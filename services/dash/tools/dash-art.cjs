// The dashboard's map art on top of planner art's (node tools/polestar.js planner art --out <dir>):
//
// 1. The game's world map of Azeroth (UiMap 947: one painting of both continents) and where each
//    continent sits in it (index.world: file, size, sea colour, and per continent the world-mode
//    offset that puts it where the painting shows it; from UiMapAssignment). The painting draws
//    both continents at one scale (within 0.5%), so the dashboard lays the continents out as the
//    game's map does and the painting lies under them as one map. Planner art builds zone (3) and
//    orphan (6) maps only; this runs its build with the world map (type 1) added
//    (tools/lib/planner/art/build.js loaded with that one constant changed, and 947 given a frame,
//    which the painting needs to be composed), so it follows upstream and fails loudly if that
//    constant changes. Existing tiles and zones are kept.
// 2. Zone maps with feathered edges (zones-soft/<id>.png; the index points at them): each zone's
//    painted map ends in its own parchment frame; faded out over its outer part, neighbouring zones
//    and the terrain under them meet without hard rectangles. The originals stay in zones/.
//
//   node services/dash/tools/dash-art.cjs <art dir>
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const Module = require('node:module');
const { encodePng } = require('../../../tools/lib/planner/art/png');

/** Of a zone map's smaller side, the outer part faded to transparent. */
const FEATHER = 0.08;
/** A map this large (yd²) is a continent: kept whole, it is the backdrop. */
const CONTINENT_AREA = 2e8;

const file = path.join(__dirname, '../../../tools/lib/planner/art/build.js');
const src = fs.readFileSync(file, 'utf8');
const ORIGINAL = 'const ZONE_TYPES = new Set([3, 6]);';
if (!src.includes(ORIGINAL)) throw new Error(`${file}: ZONE_TYPES changed upstream; update dash-art.cjs`);
const build = new Module(file, module);
build.filename = file;
build.paths = Module._nodeModulePaths(path.dirname(file));
build._compile(src.replace(ORIGINAL, 'const ZONE_TYPES = new Set([1, 3, 6]);'), file);
const WORLD = '947';

// A CSV line, quote-aware.
function split(line) {
	const out = [];
	let cur = '', q = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (q && ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
		else if (ch === '"') q = !q;
		else if (ch === ',' && !q) { out.push(cur); cur = ''; }
		else cur += ch;
	}
	out.push(cur);
	return out;
}

// The newest Forever client table cached by forge data build, as rows.
function table(name) {
	const wago = path.join(__dirname, '../../../data/sources/wago');
	const builds = fs.readdirSync(wago).filter((b) => /^1\.6\d\./.test(b) && fs.existsSync(path.join(wago, b, `${name}.csv`))).sort();
	if (!builds.length) throw new Error(`${name}.csv: not cached (forge data build)`);
	const lines = fs.readFileSync(path.join(wago, builds[builds.length - 1], `${name}.csv`), 'utf8').split('\n').filter(Boolean);
	const head = split(lines[0]);
	return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [head[i], v])));
}

// Where each continent sits in the world map: offsets for MapView's world mode (plane x = -wy + ox,
// y = -wx + oy, yards) so that the painting covers the plane rectangle [0, w] x [0, h].
function worldLayout() {
	const rows = table('UiMapAssignment').filter((r) => r.UiMapID === WORLD);
	if (!rows.length) throw new Error(`UiMapAssignment: no rows for the world map ${WORLD}`);
	const n = (v) => Number(v);
	const per = rows.map((r) => {
		const [u0, v0, u1, v1] = [n(r.UiMin_0), n(r.UiMin_1), n(r.UiMax_0), n(r.UiMax_1)];
		const [xmin, ymin, , xmax, ymax] = [0, 1, 2, 3, 4].map((i) => n(r[`Region_${i}`]));
		return { c: r.MapID, u0, v0, ku: (u1 - u0) / (ymax - ymin), kv: (v1 - v0) / (xmax - xmin), xmax, ymax };
	});
	const ku = per.reduce((a, p) => a + p.ku, 0) / per.length, kv = per.reduce((a, p) => a + p.kv, 0) / per.length;
	const spread = Math.max(...per.map((p) => Math.abs(p.ku / ku - 1)));
	if (spread > 0.02) throw new Error(`the world map's continents differ in scale by ${(spread * 100).toFixed(1)}%: one layout cannot match them`);
	const continents = Object.fromEntries(per.map((p) => [p.c, { ox: p.u0 / ku + p.ymax, oy: p.v0 / kv + p.xmax }]));
	return { w: 1 / ku, h: 1 / kv, continents };
}

// PNG (8-bit RGB or RGBA, not interlaced, as planner art writes them) -> { rgba, w, h }.
function decodePng(buf) {
	if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
	let w = 0, h = 0, type = 0;
	const idat = [];
	for (let o = 8; o < buf.length; ) {
		const len = buf.readUInt32BE(o), kind = buf.toString('latin1', o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
		if (kind === 'IHDR') {
			w = data.readUInt32BE(0);
			h = data.readUInt32BE(4);
			type = data[9];
			if (data[8] !== 8 || (type !== 2 && type !== 6) || data[12] !== 0) throw new Error(`PNG kind not handled (depth ${data[8]}, type ${type}, interlace ${data[12]})`);
		} else if (kind === 'IDAT') idat.push(data);
		else if (kind === 'IEND') break;
		o += 12 + len;
	}
	const bpp = type === 6 ? 4 : 3, stride = w * bpp;
	const raw = zlib.inflateSync(Buffer.concat(idat));
	const px = Buffer.alloc(h * stride);
	for (let y = 0; y < h; y++) {
		const f = raw[y * (stride + 1)], srcAt = y * (stride + 1) + 1, row = y * stride, up = row - stride;
		for (let x = 0; x < stride; x++) {
			const a = x >= bpp ? px[row + x - bpp] : 0, b = y > 0 ? px[up + x] : 0, c = x >= bpp && y > 0 ? px[up + x - bpp] : 0;
			let v = raw[srcAt + x];
			if (f === 1) v += a;
			else if (f === 2) v += b;
			else if (f === 3) v += (a + b) >> 1;
			else if (f === 4) {
				const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
				v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
			}
			px[row + x] = v & 255;
		}
	}
	if (bpp === 4) return { rgba: px, w, h };
	const rgba = Buffer.alloc(w * h * 4);
	for (let i = 0, j = 0; i < w * h; i++, j += 3) {
		rgba[i * 4] = px[j];
		rgba[i * 4 + 1] = px[j + 1];
		rgba[i * 4 + 2] = px[j + 2];
		rgba[i * 4 + 3] = 255;
	}
	return { rgba, w, h };
}

// Alpha faded to 0 over the outer FEATHER of the smaller side (smoothstep).
function feather({ rgba, w, h }) {
	const band = Math.max(4, Math.round(Math.min(w, h) * FEATHER));
	const out = Buffer.from(rgba);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const d = Math.min(x, y, w - 1 - x, h - 1 - y);
			if (d >= band) continue;
			const t = d / band, k = t * t * (3 - 2 * t), i = (y * w + x) * 4 + 3;
			out[i] = Math.round(out[i] * k);
		}
	}
	return out;
}

// Feathered copies of every zone map but the continents; the index points at them.
function softZones(out, index) {
	const dir = path.join(out, 'zones-soft');
	fs.mkdirSync(dir, { recursive: true });
	let n = 0;
	for (const [id, z] of Object.entries(index.zones || {})) {
		const area = Math.abs((z.frame.left - z.frame.right) * (z.frame.top - z.frame.bottom));
		if (area >= CONTINENT_AREA || !z.file?.startsWith('zones/')) continue;
		const target = path.join(dir, `${id}.png`);
		const source = path.join(out, z.file);
		if (!fs.existsSync(target) || fs.statSync(target).mtimeMs < fs.statSync(source).mtimeMs) {
			const img = decodePng(fs.readFileSync(source));
			fs.writeFileSync(`${target}.tmp`, encodePng(feather(img), img.w, img.h));
			fs.renameSync(`${target}.tmp`, target);
			n++;
		}
		z.file = `zones-soft/${id}.png`;
	}
	return n;
}

if (require.main !== module) {
	module.exports = { decodePng, feather };
	return;
}
const out = process.argv[2];
if (!out) {
	console.error('usage: dash-art.cjs <art dir>');
	process.exit(2);
}
// The build composes a map only when it has a frame: the world map gets one for the build (its
// placement comes from worldLayout(), not from this).
const dataDir = path.join(out, '.dash-data');
fs.mkdirSync(dataDir, { recursive: true });
const frames = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../data/forever/map-frames.json'), 'utf8'));
frames.forever = { ...frames.forever, [WORLD]: { c: 0, left: 0, right: -1, top: 0, bottom: -1 } };
fs.writeFileSync(path.join(dataDir, 'map-frames.json'), JSON.stringify(frames));
build.exports
	.buildArt({ outDir: out, dataDir, log: (s) => (/^zone Azeroth/.test(s) ? console.log(s) : null) })
	.then((r) => {
		const indexFile = path.join(out, 'index.json');
		const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
		const world = index.zones?.[WORLD];
		if (!world) throw new Error(`the world map ${WORLD} was not built`);
		delete index.zones[WORLD];
		// Continent-size maps (an earlier version's) are not drawn: the world map is the backdrop.
		for (const [id, z] of Object.entries(index.zones)) if (Math.abs((z.frame.left - z.frame.right) * (z.frame.top - z.frame.bottom)) >= CONTINENT_AREA) delete index.zones[id];
		const img = decodePng(fs.readFileSync(path.join(out, world.file)));
		const sea = [[0.03, 0.05], [0.5, 0.03], [0.97, 0.05], [0.5, 0.97]].map(([u, v]) => {
			const k = ((Math.round(v * (img.h - 1)) * img.w + Math.round(u * (img.w - 1))) * 4);
			return [img.rgba[k], img.rgba[k + 1], img.rgba[k + 2]];
		});
		index.world = { file: world.file, w: world.w, h: world.h, sea: [0, 1, 2].map((i) => Math.round(sea.reduce((a, p) => a + p[i], 0) / sea.length)), ...worldLayout() };
		const softened = softZones(out, index);
		fs.writeFileSync(indexFile, JSON.stringify(index));
		console.log(`world map ${world.file} ${world.w}x${world.h}, layout ${JSON.stringify(index.world.continents)}; zones: ${Object.keys(index.zones).length} (${softened} feathered); warnings: ${r.warnings.length}`);
	})
	.catch((e) => {
		console.error(e.message);
		process.exit(1);
	});
