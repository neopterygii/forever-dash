// One world map, then the ground, by zoom (services/dash/tools/dash-art.cjs makes the art):
// - far out: the game's world map of Azeroth, one painting of both continents. The continents are
//   laid out as that painting places them (index.world: MapView's world-mode offsets from the
//   game's UiMapAssignment), so trails and pins sit on it where the game would show them;
// - at region scale: the zones' painted maps, edges feathered, fading in over it, then over the
//   sharp minimap terrain as the (blurry close up) world painting fades out;
// - close in: the terrain alone.
//
// MapView keeps its layout and zone art private; this changes them on our map instance only (not
// Polestar's code): its `_layout` (continent offsets) and its zone art layer's `draw` (the same loop
// with a per-map opacity and the world painting first). It fails soft: without the fields it relies
// on, the map keeps MapView's own layout and drawing.
import type { MapViewApi } from './mapview';

/** CSS px per yard where zone maps fade in over the world painting ... */
const ZONES_IN: [number, number] = [0.045, 0.09];
/** ... where the world painting under them (the sea between zones) gives way to the terrain ... */
const WORLD_OUT: [number, number] = [0.12, 0.25];
/** ... and where the zone maps give way to the terrain. */
const TERRAIN_IN: [number, number] = [0.5, 1.1];
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
	index?: { world?: World; continents?: Record<string, { name?: string }> };
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

export function installWorldMap(view: MapViewApi): boolean {
	const m = view as unknown as Internals;
	const art = m.zoneArt;
	const world = m.index?.world;
	if (!art || !Array.isArray(art.zones) || !(art.tex instanceof Map) || typeof art._load !== 'function' || typeof art._evict !== 'function') return false;
	view.setLayer('zoneArt', true);
	// There is always art behind the map: no fallback grid when the terrain is off at world scale.
	if (m.grid) m.grid.draw = () => {};
	if (world && installLayout(m, world)) {
		// The world painting as one more "zone", on continent 0's offset (draw adds it back).
		const o = m.offsets!.get(0) ?? { ox: 0, oy: 0 };
		art.zones.unshift({ id: 'world', c: '0', file: world.file, x0: -o.ox, x1: world.w - o.ox, y0: -o.oy, y1: world.h - o.oy, area: Infinity, world: true });
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
	art.draw = function (f: Frame, quad: Quad): boolean {
		const zonesIn = smooth(ZONES_IN, f.zoom);
		const worldAlpha = 1 - smooth(WORLD_OUT, f.zoom);
		const zoneAlpha = zonesIn * (1 - smooth(TERRAIN_IN, f.zoom));
		if (worldAlpha <= 0.002 && zoneAlpha <= 0.002) return false;
		const gl = this.gl;
		const frame = ++this.frame;
		const offs = new Map(f.conts.map((k) => [String(k.c), k]));
		gl.enable(gl.BLEND);
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		quad.begin(f);
		let pending = false;
		// The world first, then zones largest first; the zone under the view centre last, so it is whole.
		const under = (z: Zone, o: { ox: number; oy: number }) => f.cx >= z.x0 + o.ox && f.cx <= z.x1 + o.ox && f.cy >= z.y0 + o.oy && f.cy <= z.y1 + o.oy;
		const order = [...this.zones.filter((z) => offs.has(z.c) && (z.world || !under(z, offs.get(z.c)!))), ...this.zones.filter((z) => !z.world && offs.has(z.c) && under(z, offs.get(z.c)!))];
		for (const z of order) {
			const alpha = z.world ? worldAlpha : zoneAlpha;
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
