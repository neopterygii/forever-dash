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
// 2. Zone maps cut to their own land, edges feathered (zones-soft/<id>.png; the index points at
//    them). A zone's painted map is a rectangle that also sketches its neighbours in sepia, and
//    the rectangles overlap: drawn whole, a neighbour's sketch hides a zone's own detailed map
//    (Durotar's and Mulgore's covered most of the Barrens). The zone's own land is where its
//    exploration overlays paint (WorldMapOverlay, the coloured areas the game reveals as you
//    explore), with the seams and holes between them closed; the rest is made transparent. A map
//    without overlays cannot be cut that way: it gives up the ground other zones own instead
//    (Shen'dralas, whose sketch of Mulgore lay over western Mulgore), unless it is a town drawn
//    inside its zone (the cities), which is kept whole, faded out over its outer part. The
//    originals stay in zones/. The index names each file with ?v=<SOFT_VERSION>: the server sends
//    no cache lifetime, so browsers would go on showing the old pictures for hours.
//
//   node services/dash/tools/dash-art.cjs <art dir>
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const Module = require('node:module');
const { encodePng } = require('../../../tools/lib/planner/art/png');

/** Of a zone map's smaller side, the outer part faded to transparent. */
const FEATHER = 0.08;
/** A zone's own land: its overlays' coverage, seams up to about this many pixels closed, the edge
 *  faded over about as many. */
const SEAM = 6;
/** Overlays covering less of a map than this are not its land (a stray overlay): the map is kept whole. */
const MIN_LAND = 0.08;
/** Bump to rebuild every feathered zone map. */
const SOFT_VERSION = '3';
/** A map with at least this many pixels per yard is a town's (ui/src/lib/worldmap.ts, INSET_DENSITY). */
const TOWN_DENSITY = 0.5;
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

// Alpha faded to 0 over the outer FEATHER of the smaller side (smoothstep), and times `land`
// (0..1 per pixel) when the zone's own land is known.
function feather({ rgba, w, h }, land = null) {
	const band = Math.max(4, Math.round(Math.min(w, h) * FEATHER));
	const out = Buffer.from(rgba);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const d = Math.min(x, y, w - 1 - x, h - 1 - y);
			const t = Math.min(1, d / band), k = t * t * (3 - 2 * t) * (land ? land[y * w + x] : 1), i = (y * w + x) * 4 + 3;
			if (k < 1) out[i] = Math.round(out[i] * k);
		}
	}
	return out;
}

// Box blur of a w x h float image, radius r (edges clamped).
function blur(src, w, h, r) {
	const pass = (a, n, stride, lines, step) => {
		const b = new Float32Array(a.length);
		for (let l = 0; l < lines; l++) {
			const at = (i) => a[l * step + Math.max(0, Math.min(n - 1, i)) * stride];
			let sum = 0;
			for (let i = -r; i <= r; i++) sum += at(i);
			for (let i = 0; i < n; i++) {
				b[l * step + i * stride] = sum / (2 * r + 1);
				sum += at(i + r + 1) - at(i - r);
			}
		}
		return b;
	};
	return pass(pass(src, w, 1, h, w), h, w, w, 1);
}

// A zone's own land (0..1 per pixel) from its overlays' coverage (0..255 per pixel), or null when
// the overlays cover too little to be it: seams between overlays closed, holes no path leads out
// of filled (land the overlays skip, inside the zone), the edge faded.
function ownLand(coverage, w, h) {
	const hard = Float32Array.from(coverage, (v) => (v > 64 ? 1 : 0));
	if (hard.reduce((a, v) => a + v, 0) < MIN_LAND * w * h) return null;
	const closed = blur(hard, w, h, SEAM).map((v) => (v > 0.25 ? 1 : 0));
	const outside = new Uint8Array(w * h);
	const todo = [];
	const visit = (i) => {
		if (!closed[i] && !outside[i]) {
			outside[i] = 1;
			todo.push(i);
		}
	};
	for (let x = 0; x < w; x++) visit(x), visit((h - 1) * w + x);
	for (let y = 0; y < h; y++) visit(y * w), visit(y * w + w - 1);
	while (todo.length) {
		const i = todo.pop(), x = i % w;
		if (x > 0) visit(i - 1);
		if (x < w - 1) visit(i + 1);
		if (i >= w) visit(i - w);
		if (i < w * (h - 1)) visit(i + w);
	}
	return blur(Float32Array.from(outside, (v) => 1 - v), w, h, SEAM).map((v) => {
		const t = Math.max(0, Math.min(1, (v - 0.2) / 0.6));
		return t * t * (3 - 2 * t);
	});
}

// Per zone map, where its overlays paint: id -> { coverage (0..255 per pixel), w, h }. Each overlay
// is drawn white on black with the build's own tile drawing, so the canvas holds the coverage.
async function overlayCoverage(ids) {
	const { openCasc } = require('../../../tools/lib/planner/art/casc');
	const { decodeBlp } = require('../../../tools/lib/planner/art/blp');
	const { buildOverlays } = require('../../../tools/lib/maps/overlays');
	const { SOURCES } = require('../../../tools/lib/paths');
	const casc = await openCasc({ sourcesDir: SOURCES });
	const tables = await build.exports.loadTables({ sourcesDir: SOURCES, build: casc.build, log: () => {} });
	const n = Number;
	const artOf = new Map();
	for (const r of [...tables.UiMapXMapArt].sort((a, b) => n(a.PhaseID) - n(b.PhaseID) || n(a.ID) - n(b.ID))) if (!artOf.has(r.UiMapID)) artOf.set(r.UiMapID, n(r.UiMapArtID));
	const arts = buildOverlays(tables).arts;
	const fileSize = (pixels) => {
		let s = 16;
		while (s < pixels) s *= 2;
		return s;
	};
	const out = new Map();
	for (const { id, w, h } of ids) {
		const art = arts[artOf.get(id)];
		if (!art?.overlays.length) continue;
		const tw = art.tileWidth, th = art.tileHeight;
		const canvas = new Uint8Array(w * h * 4);
		for (const o of art.overlays) {
			const cols = Math.ceil(o.width / tw), rows = o.files.length / cols;
			for (const [i, fdid] of o.files.entries()) {
				const blp = decodeBlp(await casc.get(fdid), { levels: 1 });
				const img = Uint8Array.from(blp.mips[0].rgba);
				for (let k = 0; k < img.length; k += 4) img[k] = img[k + 1] = img[k + 2] = 255;
				const r = Math.floor(i / cols), c = i % cols;
				const pw = c < cols - 1 ? tw : o.width - c * tw || tw, ph = r < rows - 1 ? th : o.height - r * th || th;
				build.exports.drawTile(canvas, w, h, img, blp.width, blp.height, o.x + c * tw, o.y + r * th, pw, ph, c < cols - 1 ? tw : fileSize(pw), r < rows - 1 ? th : fileSize(ph));
			}
		}
		out.set(id, { coverage: Uint8Array.from({ length: w * h }, (_, i) => canvas[i * 4]), w, h });
	}
	return out;
}

// For a map without overlays: 1 minus the other zones' own land under each of its pixels.
// frame: world yards of the picture's edges (left/right along the picture's x, top/bottom along y).
function notOthers(z, others) {
	const out = new Float32Array(z.w * z.h).fill(1);
	const f = z.frame;
	for (const o of others) {
		const g = o.frame;
		for (let y = 0; y < z.h; y++) {
			const py = Math.floor((((f.top + ((y + 0.5) / z.h) * (f.bottom - f.top)) - g.top) / (g.bottom - g.top)) * o.h);
			if (py < 0 || py >= o.h) continue;
			for (let x = 0; x < z.w; x++) {
				const px = Math.floor((((f.left + ((x + 0.5) / z.w) * (f.right - f.left)) - g.left) / (g.right - g.left)) * o.w);
				if (px < 0 || px >= o.w) continue;
				const k = 1 - o.land[py * o.w + px];
				if (k < out[y * z.w + x]) out[y * z.w + x] = k;
			}
		}
	}
	return out;
}

// Cut and feathered copies of every zone map but the continents; the index points at them. All
// are made again when one is missing or older than its original: a map's cut depends on the others.
async function softZones(out, index) {
	const dir = path.join(out, 'zones-soft');
	fs.mkdirSync(dir, { recursive: true });
	const stamp = path.join(dir, '.version');
	let stale = !fs.existsSync(stamp) || fs.readFileSync(stamp, 'utf8').trim() !== SOFT_VERSION;
	const maps = [];
	for (const [id, z] of Object.entries(index.zones || {})) {
		const area = Math.abs((z.frame.left - z.frame.right) * (z.frame.top - z.frame.bottom));
		const source = path.join(out, 'zones', `${id}.png`);
		if (area >= CONTINENT_AREA || !fs.existsSync(source)) continue;
		const target = path.join(dir, `${id}.png`);
		if (!fs.existsSync(target) || fs.statSync(target).mtimeMs < fs.statSync(source).mtimeMs) stale = true;
		maps.push({ id, c: z.c, w: z.w, h: z.h, frame: z.frame, source, target });
		z.file = `zones-soft/${id}.png?v=${SOFT_VERSION}`;
	}
	if (!stale) return { made: 0, cut: 0, yielded: 0 };
	const covered = await overlayCoverage(maps);
	for (const m of maps) {
		const c = covered.get(m.id);
		m.land = c ? ownLand(c.coverage, m.w, m.h) : null;
	}
	let cut = 0, yielded = 0;
	for (const m of maps) {
		const img = decodePng(fs.readFileSync(m.source));
		let land = img.w === m.w && img.h === m.h ? m.land : null;
		if (land) cut++;
		else if (img.w === m.w && img.h === m.h && m.w / Math.abs(m.frame.left - m.frame.right) < TOWN_DENSITY) {
			const others = maps.filter((o) => o !== m && o.c === m.c && o.land);
			if (others.length) {
				land = notOthers(m, others);
				yielded++;
			}
		}
		fs.writeFileSync(`${m.target}.tmp`, encodePng(feather(img, land), img.w, img.h));
		fs.renameSync(`${m.target}.tmp`, m.target);
	}
	fs.writeFileSync(stamp, SOFT_VERSION);
	return { made: maps.length, cut, yielded };
}

if (require.main !== module) {
	module.exports = { decodePng, feather, ownLand, blur };
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
		// The painting's open ocean (between the continents), for the sea between zone maps at region scale.
		const sea = [[0.47, 0.2], [0.47, 0.8], [0.42, 0.5], [0.53, 0.62], [0.5, 0.35], [0.45, 0.65]].map(([u, v]) => {
			const k = (Math.round(v * (img.h - 1)) * img.w + Math.round(u * (img.w - 1))) * 4;
			return [img.rgba[k], img.rgba[k + 1], img.rgba[k + 2]];
		});
		index.world = { file: world.file, w: world.w, h: world.h, sea: [0, 1, 2].map((i) => Math.round(sea.reduce((a, p) => a + p[i], 0) / sea.length)), ...worldLayout() };
		return softZones(out, index).then((soft) => {
			fs.writeFileSync(indexFile, JSON.stringify(index));
			console.log(`world map ${world.file} ${world.w}x${world.h}, layout ${JSON.stringify(index.world.continents)}; zones: ${Object.keys(index.zones).length} (${soft.made} feathered: ${soft.cut} cut to their own land, ${soft.yielded} to what the others leave); warnings: ${r.warnings.length}`);
		});
	})
	.catch((e) => {
		console.error(e.message);
		process.exit(1);
	});
