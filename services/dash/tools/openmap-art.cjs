// OpenMap's stitched zone art as the map's region-scale layer (github.com/openmap-world/openmap,
// Media/Textures/Forever/MapZones): every zone's painted map composited onto the world map's own
// space, seams masked and colours matched, in 512 px tiles at 16 px per world-map unit (the Azeroth
// painting is 1002 x 668 units). It replaces the zone maps dash-art cuts (the dashboard keeps those
// for towns and for maps outside the world painting).
//
// Whose art: Blizzard's zone maps, and in the gaps between zones Santiago Reyes's paintings over
// them, which OpenMap uses with his permission and which its MIT licence does not cover. Local
// only, like the rest of the art folder: never committed, never in the image.
//
//   node services/dash/tools/openmap-art.cjs <art dir> [--commit <sha>] [--remove]
//
// Writes <art dir>/openmap/<level>/<i>_<j>.png (510 px; level 0 is OpenMap's tile without its
// 1 px filtering border, each level above halves the one below) and `openmap` in index.json.
// Downloads are kept under data/sources/openmap/<commit>/. --remove takes the layer out again.
const fs = require('node:fs');
const path = require('node:path');
const { decodeBlp } = require('../../../tools/lib/planner/art/blp');
const { encodePng } = require('../../../tools/lib/planner/art/png');

/** The OpenMap commit the tiles are taken from (its tiles are rebuilt often: pin, then look). */
const COMMIT = 'dc611408ad0cfc2355815edcd364c74679ef4101';
const RAW = 'https://raw.githubusercontent.com/openmap-world/openmap';
const DIR = 'OpenMap/Media/Textures/Forever/MapZones';
const DATA = 'OpenMap/Data/Forever/ZoneArt.lua';
/** Levels above OpenMap's own: 3 halvings leave about six tiles for the whole world. */
const LEVELS = 3;

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const out = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--commit');
if (!out) {
	console.error('usage: node services/dash/tools/openmap-art.cjs <art dir> [--commit <sha>] [--remove]');
	process.exit(2);
}
const commit = opt('--commit') || COMMIT;
const indexFile = path.join(out, 'index.json');
const cache = path.join(__dirname, '../../../data/sources/openmap', commit);

async function fetchCached(rel) {
	const file = path.join(cache, rel);
	if (fs.existsSync(file)) return fs.readFileSync(file);
	const res = await fetch(`${RAW}/${commit}/${rel}`);
	if (!res.ok) throw new Error(`${rel}: ${res.status}`);
	const buf = Buffer.from(await res.arrayBuffer());
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, buf);
	return buf;
}

/** Four tiles (some missing) as one of the same size: 2x2 box filter, colour weighted by alpha. */
function halve(kids, n) {
	const dst = new Uint8Array(n * n * 4);
	const h = n / 2;
	kids.forEach((src, k) => {
		if (!src) return;
		const ox = (k & 1) * h, oy = (k >> 1) * h;
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < h; x++) {
				let r = 0, g = 0, b = 0, a = 0, r0 = 0, g0 = 0, b0 = 0;
				for (const d of [0, 4, n * 4, n * 4 + 4]) {
					const p = (y * 2 * n + x * 2) * 4 + d;
					const al = src[p + 3];
					r += src[p] * al; g += src[p + 1] * al; b += src[p + 2] * al; a += al;
					r0 += src[p]; g0 += src[p + 1]; b0 += src[p + 2];
				}
				const q = ((oy + y) * n + ox + x) * 4;
				// Clear pixels keep their colour (OpenMap fills them with the nearest seen one, for filtering).
				dst[q] = a ? r / a : r0 / 4; dst[q + 1] = a ? g / a : g0 / 4; dst[q + 2] = a ? b / a : b0 / 4; dst[q + 3] = a / 4;
			}
		}
	});
	return dst;
}

(async () => {
	const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
	const dir = path.join(out, 'openmap');
	if (args.includes('--remove')) {
		delete index.openmap;
		fs.writeFileSync(indexFile, JSON.stringify(index));
		fs.rmSync(dir, { recursive: true, force: true });
		return console.log('openmap layer removed');
	}
	if (!index.world) throw new Error('no world map in the index: run dash-art.cjs first');
	const lua = (await fetchCached(DATA)).toString('utf8');
	const num = (k) => Number(new RegExp(`\\b${k} = (\\d+)`).exec(lua)?.[1]);
	const px = num('px'), size = num('size'), step = num('step');
	const list = /tiles = \{([^}]*)\}/.exec(lua)?.[1].replace(/--[^\n]*/g, '').match(/\d+/g)?.map(Number);
	if (!px || !list?.length || step % 2 || size - step !== 2) throw new Error(`${DATA}: not the layout this reads (px ${px}, size ${size}, step ${step})`);
	fs.rmSync(dir, { recursive: true, force: true });
	const key = (i, j) => i * 256 + j;
	let level = new Map();
	const queue = [...list];
	await Promise.all(Array.from({ length: 8 }, async () => {
		for (let k = queue.pop(); k !== undefined; k = queue.pop()) {
			const blp = decodeBlp(await fetchCached(`${DIR}/${k >> 8}_${k & 255}.blp`), { levels: 1 });
			const m = blp.mips[0];
			if (m.width !== size || m.height !== size) throw new Error(`tile ${k >> 8}_${k & 255}: ${m.width}x${m.height}`);
			// Without the border: its first and last pixels are its neighbours'.
			const inner = new Uint8Array(step * step * 4);
			for (let y = 0; y < step; y++) inner.set(m.rgba.subarray(((y + 1) * size + 1) * 4, ((y + 1) * size + 1 + step) * 4), y * step * 4);
			level.set(k, inner);
		}
	}));
	const levels = [];
	let bytes = 0;
	for (let L = 0; L <= LEVELS; L++) {
		if (L) {
			const up = new Map();
			for (const k of level.keys()) {
				const i = k >> 9, j = (k & 255) >> 1;
				if (!up.has(key(i, j))) up.set(key(i, j), halve([0, 1, 2, 3].map((c) => level.get(key(i * 2 + (c & 1), j * 2 + (c >> 1)))), step));
			}
			level = up;
		}
		fs.mkdirSync(path.join(dir, String(L)), { recursive: true });
		for (const [k, rgba] of level) {
			const png = encodePng(rgba, step, step);
			bytes += png.length;
			fs.writeFileSync(path.join(dir, String(L), `${k >> 8}_${k & 255}.png`), png);
		}
		levels.push([...level.keys()].sort((a, b) => a - b));
	}
	// units: the world painting's size in OpenMap's world units; a level-0 tile covers step / px of them.
	index.openmap = { source: 'openmap-world/openmap', commit, v: commit.slice(0, 8), units: [1002, 668], tile: step / px, px: step, levels };
	fs.writeFileSync(indexFile, JSON.stringify(index));
	console.log(`openmap ${commit.slice(0, 8)}: ${levels.map((l, i) => `level ${i}: ${l.length}`).join(', ')} tiles, ${(bytes / 1048576).toFixed(0)} MB`);
})().catch((e) => {
	console.error(e.message);
	process.exit(1);
});
