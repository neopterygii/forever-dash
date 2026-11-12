// One world map, then the ground, by zoom (services/dash/tools/dash-art.cjs makes the art):
// - far out: the game's world map of Azeroth, one painting of both continents. The continents are
//   laid out as that painting places them (index.world: MapView's world-mode offsets from the
//   game's UiMapAssignment), so trails and pins sit on it where the game would show them;
// - at region scale: the zones' painted maps, edges feathered, fading in over it, then over the
//   sharp minimap terrain as the (blurry close up) world painting fades out;
// - close in: the terrain alone.
//
// With OpenMap's stitched zone art in the art folder (tools/openmap-art.cjs, index.openmap), the
// region scale is that instead: one seamless picture of every zone in the world painting's own
// space, at one resolution, in tiles at four levels of detail. Our own cut zone maps are then used
// only for towns (drawn over it) and for maps outside the world painting.
//
// Every zone's painting is the same 1002 x 668 pixels, whatever ground it covers: the Barrens' has a
// tenth of a pixel per yard, Ironforge's thirteen times that. So each painting gives way to the
// terrain (one pixel per yard everywhere) at its own zoom, where it is drawn about twice its size:
// at any zoom everything on screen is about as sharp. A city's map, drawn inside its zone at a
// finer scale, waits until it is no longer a miniature. The lower-resolution copy of a map the
// client carries twice (Zephras Isle) is dropped.
//
// MapView keeps its layout and zone art private; this changes them on our map instance only (not
// Polestar's code): its `_layout` (continent offsets) and its zone art layer's `draw` (the same loop
// with a per-map opacity and the world painting first). It fails soft: without the fields it relies
// on, the map keeps MapView's own layout and drawing.
import type { MapViewApi } from './mapview';

/** CSS px per yard where zone maps fade in over the world painting ... */
const ZONES_IN: [number, number] = [0.04, 0.08];
/** ... where the world painting gives way (blurry closer in; the sea between zone maps is then the
 *  painting's ocean colour, as a flat fill: the terrain's own sea is near black) ... */
const WORLD_OUT: [number, number] = [0.07, 0.13];
/** ... and where a zone map whose resolution is not known gives way to the terrain. */
const TERRAIN_IN: [number, number] = [0.5, 1.1];
/** A zone map gives way to the terrain over this range of magnification (screen px per pixel of
 *  the painting): soft from about 1.5, mush by 3. */
const ZONE_OUT_MAG: [number, number] = [1.6, 2.8];
/** Of the stitched art's pixels, how many most zones' own paintings fill (11 of its 16 per world unit:
 *  the art is every painting resampled to one resolution). */
const STITCHED_DETAIL = 11 / 16;
/** A map drawn inside a larger one (a city in its zone) fades in over this range of magnification:
 *  below it, it is a sharp miniature pasted on a soft map. */
const INSET_IN_MAG: [number, number] = [0.3, 0.5];
/** A map is an inset when it is town-sized (at least this many pixels per yard: under 2000 yards
 *  across; the smallest zone, Redridge, has 0.46 and Stormwind, the largest city, 0.58) and its
 *  centre lies in a map several times its area. Zone frames overlap too much to tell by that alone. */
const INSET_DENSITY = 0.5;
const INSET_AREA = 3;
/** Below this zoom the terrain is off: the painting covers the continents, and the terrain's far
 *  tiles (sea filled near black) would show around it. */
const TERRAIN_FROM = 0.04;
/** Room between the world painting and the other maps laid out under it (yards). */
const GAP = 2000;

const smooth = ([a, b]: [number, number], x: number) => {
	const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};

interface World {
	file: string;
	w: number;
	h: number;
	sea?: [number, number, number];
	continents: Record<string, { ox: number; oy: number }>;
}
interface Zone {
	id: string;
	c: string;
	file: string;
	x0: number;
	x1: number;
	y0: number;
	y1: number;
	area: number;
	world?: boolean;
	/** Ours: the zooms over which it fades in (insets only) and gives way to the terrain. */
	fadeIn?: [number, number];
	fadeOut?: [number, number];
	/** Ours: not drawn, the stitched art shows it. */
	covered?: boolean;
	/** An OpenMap tile: its level of detail, column and row. */
	lod?: number;
	ti?: number;
	tj?: number;
}
/** OpenMap's stitched zone art (tools/openmap-art.cjs). */
interface OpenMapArt {
	v: string;
	/** The world painting's size in the tiles' units, a level-0 tile's side in them, a tile's pixels. */
	units: [number, number];
	tile: number;
	px: number;
	/** Per level (each twice as coarse as the one before), its tiles as column * 256 + row. */
	levels: number[][];
}
interface Tex {
	status: string;
	tex: WebGLTexture | null;
	used: number;
	failedAt?: number;
}
interface ZoneArt {
	gl: WebGL2RenderingContext;
	zones: Zone[];
	tex: Map<string, Tex>;
	frame: number;
	loading: number;
	_load(z: Zone): void;
	_evict(frame: number): void;
	draw(f: Frame, quad: Quad): boolean;
	capacity?: number;
}
interface Frame {
	zoom: number;
	conts: { c: number; ox: number; oy: number }[];
	x0: number;
	x1: number;
	y0: number;
	y1: number;
	cx: number;
	cy: number;
}
interface Quad {
	begin(f: Frame): void;
	draw(tex: WebGLTexture, x0: number, y0: number, x1: number, y1: number, u0: number, v0: number, u1: number, v1: number, alpha: number): void;
	end(): void;
}
interface Internals {
	index?: { world?: World; openmap?: OpenMapArt; continents?: Record<string, { name?: string }>; zones?: Record<string, { w?: number; h?: number }> };
	grid?: { draw: (f: unknown) => void };
	/** The map shown: 'azeroth' (the continents of the world painting) or another continent id. */
	__dashMap?: MapChoice;
	offsets?: Map<number, { ox: number; oy: number }>;
	colors?: { sea: number[] };
	zoneArt?: ZoneArt;
	_layout?: () => boolean;
	_rect?: (c: number) => [number, number, number, number];
	_changed?: (layout?: boolean) => void;
	requestRender?: () => void;
}

export type MapChoice = 'azeroth' | number;

/** Lays out the map shown: Azeroth's continents as the world painting places them, or one other map
 *  (Zephras Isle, a battleground...) alone. Continents not shown get no offset: MapView skips them. */
function installLayout(m: Internals, world: World): boolean {
	if (typeof m._layout !== 'function' || typeof m._rect !== 'function' || !(m.offsets instanceof Map)) return false;
	const original = m._layout;
	m.__dashMap = 'azeroth';
	m._layout = function (this: Internals) {
		const changed = original.call(this);
		const before = JSON.stringify([...this.offsets!]);
		const show = this.__dashMap ?? 'azeroth';
		for (const c of [...this.offsets!.keys()]) {
			const placed = world.continents[String(c)];
			if (show === 'azeroth' && placed) this.offsets!.set(c, { ...placed });
			else if (show === c) this.offsets!.set(c, { ox: 0, oy: 0 });
			else this.offsets!.delete(c);
		}
		return changed || before !== JSON.stringify([...this.offsets!]);
	};
	m._layout.call(m);
	return true;
}

/** The maps that can be shown: Azeroth first, then every other map of the art. */
export function mapChoices(view: MapViewApi): { value: MapChoice; name: string }[] {
	const m = view as unknown as Internals;
	const world = m.index?.world;
	const others = Object.entries(m.index?.continents ?? {})
		.filter(([c]) => !world?.continents[c])
		.map(([c, v]) => ({ value: Number(c) as MapChoice, name: v.name ?? `Map ${c}` }))
		.sort((a, b) => a.name.localeCompare(b.name));
	return world ? [{ value: 'azeroth', name: 'Azeroth' }, ...others] : others;
}

export function shownMap(view: MapViewApi): MapChoice {
	return (view as unknown as Internals).__dashMap ?? 'azeroth';
}

/** The map continent c belongs to. */
export function mapOf(view: MapViewApi, c: number): MapChoice {
	return (view as unknown as Internals).index?.world?.continents[String(c)] ? 'azeroth' : c;
}

/** Shows a map; `fit` frames all of it (otherwise the caller fits what it wants). */
export function showMap(view: MapViewApi, choice: MapChoice, fit = true): void {
	const m = view as unknown as Internals;
	if (m.__dashMap === undefined || typeof m._layout !== 'function') return;
	if (m.__dashMap !== choice) {
		m.__dashMap = choice;
		m._layout();
		m._changed?.(true);
	}
	if (!fit) return;
	const world = m.index?.world;
	if (choice === 'azeroth' && world) {
		// The painting's corners in continent 0's coordinates (plane x = -wy + ox, y = -wx + oy).
		const o = world.continents['0'];
		const corners: [number, number][] = [[o.oy, o.ox], [o.oy, o.ox - world.w], [o.oy - world.h, o.ox], [o.oy - world.h, o.ox - world.w]];
		view.fitWorld(0, corners, { padding: 24, maxZoom: Infinity });
	} else if (typeof choice === 'number') {
		view.setContinent(choice);
	}
}

/** Each zone map's own zooms, from how many pixels it has per yard (see the top of the file), and
 *  duplicates dropped. Returns where the first map starts to give way and where the last is gone. */
function fitZones(art: ZoneArt, px: Record<string, { w?: number; h?: number }>): { first: [number, number]; last: number } {
	const density = (z: Zone) => (px[z.id]?.w ?? 0) / Math.max(1, Math.abs(z.x1 - z.x0));
	const same = (a: Zone, b: Zone) => a.c === b.c && [a.x0 - b.x0, a.x1 - b.x1, a.y0 - b.y0, a.y1 - b.y1].every((d) => Math.abs(d) < 5);
	art.zones = art.zones.filter((z) => !art.zones.some((o) => o !== z && same(o, z) && (density(o) > density(z) || (density(o) === density(z) && o.id < z.id))));
	let first: [number, number] = TERRAIN_IN;
	let last = 0;
	for (const z of art.zones) {
		const d = density(z);
		const cx = (z.x0 + z.x1) / 2, cy = (z.y0 + z.y1) / 2;
		const inset = d >= INSET_DENSITY && art.zones.some((o) => o.c === z.c && o.area >= z.area * INSET_AREA && cx > o.x0 && cx < o.x1 && cy > o.y0 && cy < o.y1);
		z.fadeOut = d > 0 ? [ZONE_OUT_MAG[0] * d, ZONE_OUT_MAG[1] * d] : TERRAIN_IN;
		if (inset) z.fadeIn = [INSET_IN_MAG[0] * d, INSET_IN_MAG[1] * d];
		if (!inset && z.fadeOut[0] < first[0]) first = z.fadeOut;
		last = Math.max(last, z.fadeOut[1]);
	}
	return { first, last };
}

/** The stitched tiles as zones of continent 0 (whose offset `o` the painting hangs on), all levels. */
function stitchedTiles(om: OpenMapArt, world: World, o: { ox: number; oy: number }): { tiles: Map<string, Zone>; fadeOut: [number, number] } {
	const kx = world.w / om.units[0], ky = world.h / om.units[1];
	// Gives way to the terrain at the same magnification as any painting, of the detail most zones
	// really have in it: one picture cannot leave zone by zone, so the largest zones (the Barrens, a
	// third of that detail) stay on soft for a while and the smallest leave a little early.
	const density = (om.px / (om.tile * kx)) * STITCHED_DETAIL;
	const fadeOut: [number, number] = [ZONE_OUT_MAG[0] * density, ZONE_OUT_MAG[1] * density];
	const tiles = new Map<string, Zone>();
	om.levels.forEach((keys, lod) => {
		const side = om.tile * 2 ** lod;
		for (const k of keys) {
			const ti = k >> 8, tj = k & 255;
			const id = `om${lod}_${ti}_${tj}`;
			tiles.set(id, { id, c: '0', file: `openmap/${lod}/${ti}_${tj}.png?v=${om.v}`, x0: ti * side * kx - o.ox, x1: (ti + 1) * side * kx - o.ox, y0: tj * side * ky - o.oy, y1: (tj + 1) * side * ky - o.oy, area: 0, fadeOut, lod, ti, tj });
		}
	});
	return { tiles, fadeOut };
}

export function installWorldMap(view: MapViewApi): boolean {
	const m = view as unknown as Internals;
	const art = m.zoneArt;
	const world = m.index?.world;
	if (!art || !Array.isArray(art.zones) || !(art.tex instanceof Map) || typeof art._load !== 'function' || typeof art._evict !== 'function') return false;
	view.setLayer('zoneArt', true);
	const fit = fitZones(art, m.index?.zones ?? {});
	let stitched: { om: OpenMapArt; tiles: Map<string, Zone>; yards: number } | null = null;
	// There is always art behind the map: no fallback grid when the terrain is off at world scale.
	if (m.grid) m.grid.draw = () => {};
	if (world && installLayout(m, world)) {
		// The world painting as one more "zone", on continent 0's offset (draw adds it back).
		const o = m.offsets!.get(0) ?? { ox: 0, oy: 0 };
		art.zones.unshift({ id: 'world', c: '0', file: world.file, x0: -o.ox, x1: world.w - o.ox, y0: -o.oy, y1: world.h - o.oy, area: Infinity, world: true });
		const om = m.index?.openmap;
		if (om?.levels?.length && om.tile > 0 && om.px > 0) {
			// The stitched art covers the painting's continents: of our own maps there, only the towns stay.
			const placed = new Set(Object.keys(world.continents));
			// (They stay in the list, not drawn: MapView names the zones from it.)
			for (const z of art.zones) z.covered = !z.world && !z.fadeIn && placed.has(z.c);
			const made = stitchedTiles(om, world, o);
			stitched = { om, tiles: made.tiles, yards: (om.tile * world.w) / om.units[0] };
			fit.first = made.fadeOut;
			fit.last = Math.max(made.fadeOut[1], ...art.zones.filter((z) => z.fadeOut && !z.covered).map((z) => z.fadeOut![1]));
			art.capacity = Math.max(art.capacity ?? 0, 96);
		}
		// Around the painting: the page's own dark, not the terrain's near-black sea.
		if (m.colors) m.colors.sea = [0x12 / 255, 0x16 / 255, 0x24 / 255, 1];
		let terrain = true;
		const setTerrain = (zoom: number) => {
			const on = zoom >= TERRAIN_FROM;
			if (on !== terrain) view.setLayer('terrain', (terrain = on));
		};
		view.on('view', (v) => setTerrain(v.zoom));
		m._changed?.(true);
	}
	// The ocean fill: a 1x1 texture of the painting's ocean colour, stretched over the painting.
	let sea: WebGLTexture | null = null;
	const seaRect = world && m.offsets?.has(0) ? { o: m.offsets!.get(0)!, w: world.w, h: world.h } : null;
	if (world?.sea && seaRect) {
		const gl = art.gl;
		sea = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, sea);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([...world.sea, 255]));
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
	}
	art.draw = function (f: Frame, quad: Quad): boolean {
		const zonesIn = smooth(ZONES_IN, f.zoom);
		const worldAlpha = 1 - smooth(WORLD_OUT, f.zoom);
		if (worldAlpha <= 0.002 && (zonesIn <= 0.002 || f.zoom >= fit.last)) return false;
		const gl = this.gl;
		const frame = ++this.frame;
		const offs = new Map(f.conts.map((k) => [String(k.c), k]));
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		quad.begin(f);
		let pending = false;
		// The sea under the zone maps (only with Azeroth shown: the painting's continents laid out),
		// gone before the first zone map is: the terrain has to show under that one.
		const seaAlpha = zonesIn * (1 - smooth(fit.first, f.zoom));
		const o0 = offs.get('0');
		if (sea && seaRect && seaAlpha > 0.002 && o0 && m.__dashMap === 'azeroth') quad.draw(sea, o0.ox - seaRect.o.ox, o0.oy - seaRect.o.oy, o0.ox - seaRect.o.ox + seaRect.w, o0.oy - seaRect.o.oy + seaRect.h, 0, 0, 1, 1, seaAlpha);
		// The world first, then zones largest first; the zone under the view centre after them, so it
		// is whole; the insets last, over their zones.
		const under = (z: Zone, o: { ox: number; oy: number }) => f.cx >= z.x0 + o.ox && f.cx <= z.x1 + o.ox && f.cy >= z.y0 + o.oy && f.cy <= z.y1 + o.oy;
		const rank = (z: Zone) => (z.world ? 0 : z.fadeIn ? 3 : under(z, offs.get(z.c)!) ? 2 : 1);
		const shown = this.zones.filter((z) => offs.has(z.c) && !z.covered);
		const order = [0, 1, 2, 3].flatMap((r) => shown.filter((z) => rank(z) === r));
		const want = (z: Zone) => {
			const t = this.tex.get(z.id);
			if (t?.status === 'ready' && t.tex) return (t.used = frame), t.tex;
			if ((!t || (t.status === 'failed' && performance.now() - (t.failedAt ?? 0) > 15000)) && this.loading < 4) this._load(z);
			pending = true;
			return null;
		};
		// The stitched zone art, after the world: the coarsest level that still has (nearly) a pixel per screen pixel. A tile
		// still loading shows its part of a coarser one that is there.
		const o0s = stitched && m.__dashMap === 'azeroth' ? offs.get('0') : null;
		if (stitched && o0s) {
			const { om, tiles, yards } = stitched;
			const alpha = zonesIn * (1 - smooth(fit.first, f.zoom));
			const top = om.levels.length - 1;
			const lod = Math.max(0, Math.min(top, Math.floor(Math.log2(om.px / (yards * f.zoom * (window.devicePixelRatio || 1))) + 0.2)));
			const world = this.zones.find((z) => z.world);
			if (alpha > 0.002 && world) {
				const side = yards * 2 ** lod;
				const bx = world.x0 + o0s.ox, by = world.y0 + o0s.oy;
				const inset = 0.5 / om.px;
				for (let ti = Math.max(0, Math.floor((f.x0 - bx) / side)); ti <= Math.floor((f.x1 - bx) / side); ti++) {
					for (let tj = Math.max(0, Math.floor((f.y0 - by) / side)); tj <= Math.floor((f.y1 - by) / side); tj++) {
						const z = tiles.get(`om${lod}_${ti}_${tj}`);
						if (!z) continue;
						const x0 = z.x0 + o0s.ox, y0 = z.y0 + o0s.oy;
						let tex = want(z);
						let u0 = 0, v0 = 0, span = 1;
						for (let up = 1; !tex && lod + up <= top; up++) {
							const a = tiles.get(`om${lod + up}_${ti >> up}_${tj >> up}`);
							const t = a && this.tex.get(a.id);
							if (!a || t?.status !== 'ready' || !t.tex) continue;
							t.used = frame;
							tex = t.tex;
							span = 1 / 2 ** up;
							u0 = (ti - ((ti >> up) << up)) * span;
							v0 = (tj - ((tj >> up) << up)) * span;
						}
						if (tex) quad.draw(tex, x0, y0, x0 + side, y0 + side, u0 + inset * span, v0 + inset * span, u0 + span - inset * span, v0 + span - inset * span, alpha);
					}
				}
			}
		}
		for (const z of order) {
			const alpha = z.world ? worldAlpha : (z.fadeIn ? smooth(z.fadeIn, f.zoom) : zonesIn) * (1 - smooth(z.fadeOut ?? TERRAIN_IN, f.zoom));
			if (alpha <= 0.002) continue;
			const o = offs.get(z.c)!;
			const x0 = z.x0 + o.ox, x1 = z.x1 + o.ox, y0 = z.y0 + o.oy, y1 = z.y1 + o.oy;
			if (x1 < f.x0 || x0 > f.x1 || y1 < f.y0 || y0 > f.y1) continue;
			const t = this.tex.get(z.id);
			if (t?.status === 'ready' && t.tex) {
				t.used = frame;
				quad.draw(t.tex, x0, y0, x1, y1, 0, 0, 1, 1, alpha);
			} else if ((!t || (t.status === 'failed' && performance.now() - (t.failedAt ?? 0) > 15000)) && this.loading < 4) {
				this._load(z);
				pending = true;
			} else if (!t || t.status === 'loading') {
				pending = true;
			}
		}
		quad.end();
		this._evict(frame);
		return pending;
	};
	return true;
}
