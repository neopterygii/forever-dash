// Trails, event markers and character pins drawn on a 2D canvas over MapView (which draws the map
// itself): a line per character in its own colour with a dark casing and direction chevrons, the
// part after the replay time faint; level-ups as numbered starbursts; other events as small
// badges; characters as pins with a name pill. Redrawn whenever the map's camera or the data
// changes (checked every animation frame). Projection: MapView's own toScreen, as an affine map
// per continent from three points (exact: MapView's view is linear in world yards).
//
// A trail's screen line (thinned for the zoom, corners rounded) is worked out once per view and
// kept with the time of each of its points; the replay only moves the place where the bright part
// ends, so playing costs a redraw and nothing else. The same kept lines answer what is under the
// pointer (a pin, an event, a moment of a trail).
import type { MapViewApi } from './mapview';
import type { LineStyle } from './timeline';

export interface OverlayLine {
	/** Whose trail (a character id). */
	id: string;
	c: number;
	/** Flat wx, wy pairs. */
	pts: ArrayLike<number>;
	/** The time of each point (epoch seconds, rising). */
	ts: ArrayLike<number>;
	color: string;
	style: LineStyle;
	/** The points either side of this line when the trail goes on through its ends (walking into
	 *  riding): the curve keeps its direction across the join. */
	pre?: [number, number];
	post?: [number, number];
}
/** How far (world yards) a smoothed trail may bow away from the straight line between two recorded points. */
export const SMOOTH_YD = 4;
/** Turns sharper than this (radians between the way in and the way out) stay corners: a real turnaround. */
const SHARP_TURN = (135 * Math.PI) / 180;

/**
 * Rounds a trail's corners without moving it: the curve passes through every point it was given
 * (centripetal Catmull-Rom, which neither loops nor overshoots like the uniform kind), and each
 * piece between two points stays within `maxDev` px of the straight line between them (a Bezier
 * lies within its control points, which are clamped to that band and to half the piece's length).
 * Sharp turns stay sharp. Returned as a polyline (each piece in steps of about 4 px), so the
 * stroke and the direction chevrons follow the same line. maxDev < 0.5 px: the points as given.
 * `pre` and `post`: the points before the first and after the last when the trail goes on there
 * (used for the direction at the ends only; nothing is drawn towards them).
 * `at`, when given, is filled with where each returned point lies along the given ones (2.25: a
 * quarter of the way from point 2 to point 3), so a point's time can be read off its neighbours'.
 */
export function smooth(p: [number, number][], maxDev: number, pre?: [number, number], post?: [number, number], at?: number[]): [number, number][] {
	if (p.length < 3 || !(maxDev >= 0.5)) {
		if (at) for (let i = 0; i < p.length; i++) at.push(i);
		return p;
	}
	const out: [number, number][] = [p[0]];
	at?.push(0);
	const dist = (u: [number, number], v: [number, number]) => Math.hypot(v[0] - u[0], v[1] - u[1]);
	const turn = (u: [number, number], v: [number, number], w: [number, number]) => {
		const a1 = Math.atan2(v[1] - u[1], v[0] - u[0]), a2 = Math.atan2(w[1] - v[1], w[0] - v[0]);
		return Math.abs(((a2 - a1 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
	};
	// The control point next to `from` on the piece from -> to, pulled back into the band.
	const clamp = (c: [number, number], from: [number, number], to: [number, number]): [number, number] => {
		const len = dist(from, to);
		if (len < 1e-6) return from;
		const ux = (to[0] - from[0]) / len, uy = (to[1] - from[1]) / len;
		let vx = c[0] - from[0], vy = c[1] - from[1];
		const along = vx * ux + vy * uy;
		if (along <= 0) return from; // pointing backwards: no rounding here
		const perp = Math.abs(-vx * uy + vy * ux);
		let k = 1;
		if (perp > maxDev) k = Math.min(k, maxDev / perp);
		if (Math.hypot(vx, vy) * k > len / 2) k = Math.min(k, len / 2 / Math.hypot(vx, vy));
		vx *= k;
		vy *= k;
		return [from[0] + vx, from[1] + vy];
	};
	for (let i = 0; i + 1 < p.length; i++) {
		const p1 = p[i], p2 = p[i + 1];
		const p0 = p[i - 1] ?? pre ?? p1, p3 = p[i + 2] ?? post ?? p2;
		const d1 = Math.sqrt(dist(p0, p1)), d2 = Math.sqrt(dist(p1, p2)), d3 = Math.sqrt(dist(p2, p3));
		if (d2 < 1e-6) continue;
		let c1: [number, number] = p1, c2: [number, number] = p2;
		if (d1 > 1e-6 && turn(p0, p1, p2) < SHARP_TURN) {
			const k = 3 * d1 * (d1 + d2), a = 2 * d1 * d1 + 3 * d1 * d2 + d2 * d2;
			c1 = clamp([(d1 * d1 * p2[0] - d2 * d2 * p0[0] + a * p1[0]) / k, (d1 * d1 * p2[1] - d2 * d2 * p0[1] + a * p1[1]) / k], p1, p2);
		}
		if (d3 > 1e-6 && turn(p1, p2, p3) < SHARP_TURN) {
			const k = 3 * d3 * (d3 + d2), a = 2 * d3 * d3 + 3 * d3 * d2 + d2 * d2;
			c2 = clamp([(d3 * d3 * p1[0] - d2 * d2 * p3[0] + a * p2[0]) / k, (d3 * d3 * p1[1] - d2 * d2 * p3[1] + a * p2[1]) / k], p2, p1);
		}
		const straight = c1 === p1 && c2 === p2;
		const n = straight ? 1 : Math.min(24, Math.max(2, Math.ceil(dist(p1, p2) / 4)));
		for (let j = 1; j <= n; j++) {
			const t = j / n, m = 1 - t;
			out.push([
				m * m * m * p1[0] + 3 * m * m * t * c1[0] + 3 * m * t * t * c2[0] + t * t * t * p2[0],
				m * m * m * p1[1] + 3 * m * m * t * c1[1] + 3 * m * t * t * c2[1] + t * t * t * p2[1],
			]);
			at?.push(i + t);
		}
	}
	return out;
}

export interface OverlayEvent {
	c: number;
	wx: number;
	wy: number;
	kind: string;
	/** When it happened: shown once the replay has reached it. */
	t: number;
	/** A starburst's number (the level reached). */
	label?: string;
	/** The event was also a first (its milestone's line): a small star on its badge. */
	first?: string;
	color: string;
	data?: unknown;
}
export interface OverlayPin {
	c: number;
	wx: number;
	wy: number;
	name: string;
	level: number | null;
	color: string;
	/** Dimmed: the replay is at a time this character was not playing (it stands where last seen). */
	dim: boolean;
	/** The green dot: playing at the replay time, or, at the latest moment, seen in the last minutes. */
	playing: boolean;
	/** The focused character: drawn as an arrow turned to its heading (radians, clockwise from north). */
	heading?: number;
	id: string;
}
export interface OverlayData {
	lines: OverlayLine[];
	events: OverlayEvent[];
	/** Many trails over each other (all play): translucent strokes without chevrons, so places
	 *  passed often build up brighter instead of a tangle of solid lines. */
	dense?: boolean;
}
/** What is under a point: a pin, the events drawn as one badge there (the one shown first), or a
 *  moment of a trail. */
export type Hit = { kind: 'pin'; pin: OverlayPin } | { kind: 'event'; events: OverlayEvent[] } | { kind: 'trail'; line: OverlayLine; t: number } | null;

/**
 * Douglas-Peucker on flat x, y pairs: the indices of the points kept, so that none of the dropped
 * ones lies further than `tol` from the line. The first and last always stay.
 */
export function simplifyIdx(p: ArrayLike<number>, tol: number): Uint32Array {
	const n = p.length >> 1;
	if (n < 3) return Uint32Array.from({ length: n }, (_, i) => i);
	const keep = new Uint8Array(n);
	keep[0] = keep[n - 1] = 1;
	const stack: [number, number][] = [[0, n - 1]];
	while (stack.length) {
		const [a, b] = stack.pop()!;
		const ax = p[2 * a], ay = p[2 * a + 1], dx = p[2 * b] - ax, dy = p[2 * b + 1] - ay;
		const len = Math.hypot(dx, dy);
		let best = -1, at = -1;
		for (let i = a + 1; i < b; i++) {
			const px = p[2 * i] - ax, py = p[2 * i + 1] - ay;
			const d = len < 1e-9 ? Math.hypot(px, py) : Math.abs(px * dy - py * dx) / len;
			if (d > best) [best, at] = [d, i];
		}
		if (best > tol) {
			keep[at] = 1;
			stack.push([a, at], [at, b]);
		}
	}
	const out: number[] = [];
	for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
	return Uint32Array.from(out);
}

/** Trails longer than this (points) are thinned for the zoom before drawing. */
const RESIMPLIFY_FROM = 400;
/** The thinning's tolerance: well under a pixel, so it never shows. */
const RESIMPLIFY_PX = 0.5;

type Affine = { x0: number; y0: number; ax: number; ay: number; bx: number; by: number; wx0: number; wy0: number };

const CHEVRON_EVERY = 64; // px between direction chevrons
/** Zoom (CSS px per yard) from which event badges show; level starbursts and firsts from LEVELS_FROM. Further
 *  out they would pile up into clutter at world scale. */
const EVENTS_FROM = 0.06;
const LEVELS_FROM = 0.035;
const MIN_STEP = 1.5; // px: closer points are merged
const DENSE_STROKE = 6; // points per stroke in dense mode

/** Events closer than this (px) to one already drawn join its badge (a count on it). */
const CLUSTER_PX = 15;
/** How near (px) the pointer has to be to a trail to be on it. */
const TRAIL_HIT_PX = 7;
/** Which event of a pile shows: the lower, the more it matters. */
const RANK: Record<string, number> = { level: 0, milestone: 1, death: 2, mark: 3, encounter: 4, rare: 5 };

type Pt = [number, number];
type Proj = (c: number, wx: number, wy: number) => Pt | null;
/** A line as drawn in the current view: its screen points and the time of each. */
type Geom = { serial: number; pts: Pt[]; ts: number[] } | { serial: number; pts: null };

export class TrailOverlay {
	private ctx: CanvasRenderingContext2D;
	private data: OverlayData = { lines: [], events: [] };
	private pinsNow: OverlayPin[] = [];
	private t = Infinity;
	/** The events by how much they matter, then newest first: the order piles are built in. */
	private ranked: OverlayEvent[] = [];
	private dirty = true;
	private raf = 0;
	private last = { x: NaN, y: NaN, zoom: NaN, c: NaN };
	/** Bumped whenever the view or the canvas changes: screen lines of an older serial are stale. */
	private serial = 0;
	private w = 0;
	private h = 0;
	private zoom = 1;
	private pills: [number, number, number, number][] = [];
	private shown: { x: number; y: number; r: number; box?: [number, number, number, number]; hit: NonNullable<Hit> }[] = [];
	private resize: ResizeObserver;
	/** Long trails thinned per zoom step (tolerance a power of two in yards), with their bounds. */
	private thin = new WeakMap<ArrayLike<number>, { box: [number, number, number, number]; byTol: Map<number, Uint32Array> }>();
	private geom = new WeakMap<OverlayLine, Geom>();

	constructor(
		private canvas: HTMLCanvasElement,
		private map: MapViewApi,
	) {
		this.ctx = canvas.getContext('2d')!;
		this.resize = new ResizeObserver(() => this.fit());
		this.resize.observe(canvas);
		this.fit();
		const loop = () => {
			this.raf = requestAnimationFrame(loop);
			const v = this.map.view, l = this.last;
			const moved = !!v && (v.x !== l.x || v.y !== l.y || v.zoom !== l.zoom || v.c !== l.c);
			if (moved) {
				this.last = { x: v.x, y: v.y, zoom: v.zoom, c: v.c };
				this.serial++;
			}
			if (this.dirty || moved) {
				this.dirty = false;
				this.draw();
			}
		};
		this.raf = requestAnimationFrame(loop);
	}

	destroy() {
		cancelAnimationFrame(this.raf);
		this.resize.disconnect();
	}

	/** What there is to draw: the trails whole and every event (the replay time decides what shows). */
	set(data: OverlayData) {
		this.data = data;
		const rank = (e: OverlayEvent) => RANK[e.kind] ?? 9;
		this.ranked = [...data.events].sort((a, b) => rank(a) - rank(b) || b.t - a.t);
		this.dirty = true;
	}

	/** The replay time and where everyone is then. */
	setTime(t: number, pins: OverlayPin[]) {
		this.t = t;
		this.pinsNow = pins;
		this.dirty = true;
	}

	/** What is under a point in CSS px of the canvas: pins first, then events, then a trail. */
	hit(sx: number, sy: number): Hit {
		for (let i = this.shown.length - 1; i >= 0; i--) {
			const s = this.shown[i];
			if (s.box ? sx >= s.box[0] && sx <= s.box[0] + s.box[2] && sy >= s.box[1] && sy <= s.box[1] + s.box[3] : Math.hypot(s.x - sx, s.y - sy) <= s.r) return s.hit;
		}
		// The nearest trail within reach, at the moment the character passed that spot.
		let best: { line: OverlayLine; t: number; d: number } | null = null;
		for (const l of this.data.lines) {
			const g = this.geom.get(l);
			if (!g || g.serial !== this.serial || !g.pts) continue;
			const p = g.pts;
			for (let i = 1; i < p.length; i++) {
				const [x0, y0] = p[i - 1], [x1, y1] = p[i];
				const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy;
				const u = len2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((sx - x0) * dx + (sy - y0) * dy) / len2));
				const d = Math.hypot(sx - (x0 + dx * u), sy - (y0 + dy * u));
				if (d <= TRAIL_HIT_PX && (!best || d < best.d)) best = { line: l, t: g.ts[i - 1] + (g.ts[i] - g.ts[i - 1]) * u, d };
			}
		}
		return best ? { kind: 'trail', line: best.line, t: best.t } : null;
	}

	private fit() {
		const r = this.canvas.getBoundingClientRect();
		const dpr = window.devicePixelRatio || 1;
		this.w = r.width;
		this.h = r.height;
		this.canvas.width = Math.round(r.width * dpr);
		this.canvas.height = Math.round(r.height * dpr);
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.serial++;
		this.dirty = true;
	}

	private affine(c: number, wx0: number, wy0: number): Affine | null {
		const p = this.map.toScreen(c, wx0, wy0);
		const px = this.map.toScreen(c, wx0 + 1000, wy0);
		const py = this.map.toScreen(c, wx0, wy0 + 1000);
		if (!p || !px || !py) return null;
		return { x0: p.x, y0: p.y, ax: (px.x - p.x) / 1000, ay: (px.y - p.y) / 1000, bx: (py.x - p.x) / 1000, by: (py.y - p.y) / 1000, wx0, wy0 };
	}

	private draw() {
		const ctx = this.ctx;
		ctx.clearRect(0, 0, this.w, this.h);
		this.shown = [];
		this.pills = [];
		this.zoom = this.map.view?.zoom ?? 1;
		const cache = new Map<number, Affine | null>();
		const proj: Proj = (c, wx, wy) => {
			if (!cache.has(c)) cache.set(c, this.affine(c, wx, wy));
			const a = cache.get(c);
			if (!a) return null;
			const dx = wx - a.wx0, dy = wy - a.wy0;
			return [a.x0 + a.ax * dx + a.bx * dy, a.y0 + a.ay * dx + a.by * dy];
		};
		const { lines, dense } = this.data;
		// What is still to come first (faint), then the way come so far over it.
		for (const l of lines) this.line(l, proj, !!dense, true);
		for (const l of lines) this.line(l, proj, !!dense, false);
		this.events(proj);
		for (const p of [...this.pinsNow].sort((a, b) => Number(b.dim) - Number(a.dim) || Number(a.heading !== undefined) - Number(b.heading !== undefined))) this.pin(p, proj);
	}

	/** A long trail's points thinned for this zoom (cached per power-of-two tolerance): the indices
	 *  kept, `undefined` for all of them, or null when the trail lies wholly off screen. */
	private visibleIdx(l: OverlayLine, pxPerYd: number, proj: Proj): Uint32Array | undefined | null {
		let e = this.thin.get(l.pts);
		if (!e) {
			const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
			for (let i = 0; i + 1 < l.pts.length; i += 2) {
				box[0] = Math.min(box[0], l.pts[i]);
				box[1] = Math.min(box[1], l.pts[i + 1]);
				box[2] = Math.max(box[2], l.pts[i]);
				box[3] = Math.max(box[3], l.pts[i + 1]);
			}
			e = { box, byTol: new Map() };
			this.thin.set(l.pts, e);
		}
		// Off screen: test the box's corners on screen (the projection may rotate, so all four).
		const corners = [proj(l.c, e.box[0], e.box[1]), proj(l.c, e.box[2], e.box[1]), proj(l.c, e.box[0], e.box[3]), proj(l.c, e.box[2], e.box[3])];
		if (corners.every((p) => p)) {
			const xs = corners.map((p) => p![0]), ys = corners.map((p) => p![1]), m = 12;
			if (Math.max(...xs) < -m || Math.min(...xs) > this.w + m || Math.max(...ys) < -m || Math.min(...ys) > this.h + m) return null;
		}
		if (l.pts.length < 2 * RESIMPLIFY_FROM || !(pxPerYd > 0)) return undefined;
		const tol = 2 ** Math.floor(Math.log2(RESIMPLIFY_PX / pxPerYd));
		if (tol < 0.75) return undefined; // finer than the server's own simplification already
		let thin = e.byTol.get(tol);
		if (!thin) e.byTol.set(tol, (thin = simplifyIdx(l.pts, tol)));
		return thin;
	}

	/** The line as drawn in this view (kept until the view changes): thinned, projected, rounded,
	 *  each screen point with its time. */
	private screenLine(l: OverlayLine, proj: Proj): Geom {
		const had = this.geom.get(l);
		if (had && had.serial === this.serial) return had;
		const none: Geom = { serial: this.serial, pts: null };
		const make = (): Geom => {
			if (l.pts.length < 4) return none;
			// Screen px per world yard here (MapView's view is linear in yards).
			const a = proj(l.c, l.pts[0], l.pts[1]), b = proj(l.c, l.pts[0] + 1, l.pts[1]);
			if (!a || !b) return none;
			const pxPerYd = Math.hypot(b[0] - a[0], b[1] - a[1]);
			const idx = this.visibleIdx(l, pxPerYd, proj);
			if (idx === null) return none;
			const n = idx ? idx.length : l.pts.length >> 1;
			const raw: Pt[] = [], rawT: number[] = [];
			for (let k = 0; k < n; k++) {
				const i = idx ? idx[k] : k;
				const p = proj(l.c, l.pts[2 * i], l.pts[2 * i + 1]);
				if (!p) return none;
				const last = raw[raw.length - 1];
				if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= MIN_STEP || k === n - 1) {
					raw.push(p);
					rawT.push(l.ts[i]);
				}
			}
			if (raw.length < 2) return none;
			// A flight is a straight guess between take-off and landing: never bent.
			if (l.style === 'flight') return { serial: this.serial, pts: raw, ts: rawT };
			const side = (q?: [number, number]) => (q ? (proj(l.c, q[0], q[1]) ?? undefined) : undefined);
			const at: number[] = [];
			const pts = smooth(raw, SMOOTH_YD * pxPerYd, side(l.pre), side(l.post), at);
			const ts = at.map((f) => {
				const i = Math.min(rawT.length - 2, Math.floor(f));
				return rawT[i] + (rawT[i + 1] - rawT[i]) * (f - i);
			});
			return { serial: this.serial, pts, ts };
		};
		const g = make();
		this.geom.set(l, g);
		return g;
	}

	/** One line's part before the replay time (`future` false) or after it (faint). */
	private line(l: OverlayLine, proj: Proj, dense: boolean, future: boolean) {
		const g = this.screenLine(l, proj);
		if (!g.pts) return;
		const all = g.pts, ts = g.ts, t = this.t;
		let pts: Pt[];
		if (t >= ts[ts.length - 1]) {
			if (future) return;
			pts = all;
		} else if (t <= ts[0]) {
			if (!future) return;
			pts = all;
		} else {
			// The first point after t, and the spot reached at t between it and the one before.
			let lo = 0, hi = ts.length - 1;
			while (lo < hi - 1) {
				const mid = (lo + hi) >> 1;
				if (ts[mid] <= t) lo = mid;
				else hi = mid;
			}
			const f = (t - ts[lo]) / (ts[hi] - ts[lo] || 1);
			const cut: Pt = [all[lo][0] + (all[hi][0] - all[lo][0]) * f, all[lo][1] + (all[hi][1] - all[lo][1]) * f];
			pts = future ? [cut, ...all.slice(hi)] : [...all.slice(0, lo + 1), cut];
		}
		if (pts.length < 2) return;
		const flight = l.style === 'flight', ghost = l.style === 'ghost', mount = l.style === 'mount';
		const ctx = this.ctx;
		const path = (from = 0, to = pts.length - 1) => {
			ctx.beginPath();
			ctx.moveTo(pts[from][0], pts[from][1]);
			for (let i = from + 1; i <= to; i++) ctx.lineTo(pts[i][0], pts[i][1]);
		};
		ctx.save();
		ctx.lineJoin = 'round';
		ctx.lineCap = 'round';
		if (dense && !flight) {
			// Short translucent strokes: where the trail crosses itself or comes back, they add up.
			// Butt caps, so the joins between strokes don't stack into dots.
			ctx.lineCap = 'butt';
			ctx.globalAlpha = future ? 0.12 : 0.34;
			ctx.strokeStyle = l.color;
			ctx.lineWidth = mount ? 4 : 3;
			if (ghost) ctx.setLineDash([2, 6]);
			for (let i = 0; i + 1 < pts.length; i += DENSE_STROKE) {
				path(i, Math.min(i + DENSE_STROKE, pts.length - 1));
				ctx.stroke();
			}
			ctx.restore();
			return;
		}
		ctx.globalAlpha = (future ? 0.35 : 1) * (flight ? 0.7 : 1);
		if (ghost) ctx.setLineDash([2, 6]);
		if (flight) ctx.setLineDash([7, 7]);
		// casing, then the colour
		path();
		ctx.strokeStyle = 'rgba(8, 14, 24, 0.75)';
		ctx.lineWidth = ghost ? 5 : flight ? 4 : mount ? 8.6 : 6;
		ctx.stroke();
		path();
		ctx.strokeStyle = l.color;
		ctx.lineWidth = ghost ? 2.5 : flight ? 1.8 : mount ? 5.6 : 3.2;
		ctx.stroke();
		if (mount) {
			// a light stripe down the middle: mounted reads as a road, not just a wider line
			path();
			ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
			ctx.lineWidth = 1.3;
			ctx.stroke();
		}
		ctx.setLineDash([]);
		// direction chevrons along the line
		if (!future) {
			const every = flight ? CHEVRON_EVERY * 3 : CHEVRON_EVERY;
			let carry = every / 2;
			ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
			ctx.lineWidth = 1.6;
			for (let i = 1; i < pts.length; i++) {
				const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
				const len = Math.hypot(x1 - x0, y1 - y0);
				if (len < 0.01) continue;
				const ux = (x1 - x0) / len, uy = (y1 - y0) / len;
				let d = carry;
				while (d < len) {
					const cx = x0 + ux * d, cy = y0 + uy * d;
					ctx.beginPath();
					ctx.moveTo(cx - ux * 4 - uy * 3.5, cy - uy * 4 + ux * 3.5);
					ctx.lineTo(cx + ux * 1.5, cy + uy * 1.5);
					ctx.lineTo(cx - ux * 4 + uy * 3.5, cy - uy * 4 - ux * 3.5);
					ctx.stroke();
					d += every;
				}
				carry = d - len;
			}
		}
		ctx.restore();
	}

	/** The events the replay has reached, piled where they would cover each other: each pile shows
	 *  the one that matters most (a level over a first over a death over the rest) and how many
	 *  it holds. */
	private events(proj: Proj) {
		const piles: { x: number; y: number; items: OverlayEvent[] }[] = [];
		for (const e of this.ranked) {
			if (e.t > this.t) continue;
			if (this.zoom < (e.kind === 'level' || e.kind === 'milestone' ? LEVELS_FROM : EVENTS_FROM)) continue;
			const p = proj(e.c, e.wx, e.wy);
			if (!p || p[0] < -30 || p[1] < -30 || p[0] > this.w + 30 || p[1] > this.h + 30) continue;
			const pile = piles.find((q) => Math.hypot(q.x - p[0], q.y - p[1]) < CLUSTER_PX);
			if (pile) pile.items.push(e);
			else piles.push({ x: p[0], y: p[1], items: [e] });
		}
		// The least important first, so the ones that matter lie on top.
		for (let i = piles.length - 1; i >= 0; i--) {
			const { x, y, items } = piles[i];
			const r = this.event(items[0], x, y);
			if (items.length > 1) this.count(x + r * 0.75, y + r * 0.75, items.length);
			this.shown.push({ x, y, r: r + 2, hit: { kind: 'event', events: items } });
		}
	}

	/** How many events a badge stands for, on its lower right. */
	private count(x: number, y: number, n: number) {
		const ctx = this.ctx;
		const text = n > 99 ? '99+' : String(n);
		ctx.save();
		ctx.font = '700 9px Inter, system-ui, sans-serif';
		const w = Math.max(13, ctx.measureText(text).width + 7);
		ctx.beginPath();
		ctx.roundRect(x - w / 2, y - 6.5, w, 13, 6.5);
		ctx.fillStyle = '#f7f8fd';
		ctx.strokeStyle = 'rgba(8, 14, 24, 0.9)';
		ctx.lineWidth = 1.2;
		ctx.fill();
		ctx.stroke();
		ctx.fillStyle = '#10141f';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText(text, x, y + 0.5);
		ctx.restore();
	}

	private glow(x: number, y: number, r: number, color: string, alpha = 0.45) {
		const ctx = this.ctx;
		const g = ctx.createRadialGradient(x, y, 0, x, y, r);
		g.addColorStop(0, color);
		g.addColorStop(1, 'transparent');
		ctx.save();
		ctx.globalAlpha = alpha;
		ctx.fillStyle = g;
		ctx.beginPath();
		ctx.arc(x, y, r, 0, Math.PI * 2);
		ctx.fill();
		ctx.restore();
	}

	/** A pale five-pointed star (a milestone), centred on x, y with outer radius r. */
	private star(x: number, y: number, r: number) {
		const ctx = this.ctx;
		ctx.save();
		ctx.beginPath();
		for (let i = 0; i < 10; i++) {
			const rr = i % 2 ? r * 0.45 : r;
			const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
			ctx[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * rr, y + Math.sin(a) * rr);
		}
		ctx.closePath();
		ctx.fillStyle = '#fff1c2';
		ctx.strokeStyle = 'rgba(40, 24, 0, 0.9)';
		ctx.lineWidth = 1.4;
		ctx.fill();
		ctx.stroke();
		ctx.restore();
	}

	/** Draws one event's badge at x, y; returns its radius. */
	private event(e: OverlayEvent, x: number, y: number): number {
		const ctx = this.ctx;
		if (e.kind === 'level') {
			// a gold starburst with the level
			this.glow(x, y, 22, '#ffe08a', 0.5);
			ctx.save();
			ctx.beginPath();
			const n = 10;
			for (let i = 0; i < n * 2; i++) {
				const r = i % 2 ? 7.5 : 13;
				const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2;
				ctx[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * r, y + Math.sin(a) * r);
			}
			ctx.closePath();
			ctx.fillStyle = '#f6c544';
			ctx.strokeStyle = 'rgba(40, 24, 0, 0.85)';
			ctx.lineWidth = 1.4;
			ctx.fill();
			ctx.stroke();
			ctx.fillStyle = '#1b1204';
			ctx.font = '700 11px Inter, system-ui, sans-serif';
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.fillText(e.label ?? '', x, y + 0.5);
			ctx.restore();
			if (e.first) this.star(x + 10, y - 10, 6);
			return 13;
		}
		if (e.kind === 'milestone') {
			// a first or a round number: a pale five-pointed star
			this.glow(x, y, 18, '#ffe9a8', 0.45);
			this.star(x, y, 10);
			return 10;
		}
		// a small round badge in the event's colour, with its sign
		const sign: Record<string, string> = { death: '✕', mark: '★', accept: '!', turnin: '?', explore: '◆', enter: '⌂', encounter: '☠', taxi: '➶', bind: '⌂', learn: '✦', rare: '◎' };
		this.glow(x, y, 14, e.color, 0.35);
		ctx.save();
		ctx.beginPath();
		ctx.arc(x, y, 7.5, 0, Math.PI * 2);
		ctx.fillStyle = 'rgba(10, 14, 24, 0.92)';
		ctx.fill();
		ctx.lineWidth = 1.8;
		ctx.strokeStyle = e.color;
		ctx.stroke();
		ctx.fillStyle = e.color;
		ctx.font = '700 9px Inter, system-ui, sans-serif';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText(sign[e.kind] ?? '•', x, y + 0.5);
		ctx.restore();
		if (e.first) this.star(x + 7, y - 7, 6);
		return 8;
	}

	private pin(pin: OverlayPin, proj: Proj) {
		const p = proj(pin.c, pin.wx, pin.wy);
		if (!p) return;
		const [x, y] = p;
		const ctx = this.ctx;
		ctx.save();
		ctx.globalAlpha = pin.dim && pin.heading === undefined ? 0.6 : 1;
		this.glow(x, y, 20, pin.color, 0.5);
		if (pin.heading !== undefined) {
			// the focused character: an arrow in its colour, turned to its heading
			ctx.translate(x, y);
			ctx.rotate(pin.heading);
			ctx.beginPath();
			ctx.moveTo(0, -11);
			ctx.lineTo(7.5, 8);
			ctx.lineTo(0, 4);
			ctx.lineTo(-7.5, 8);
			ctx.closePath();
			ctx.fillStyle = pin.color;
			ctx.strokeStyle = 'rgba(8, 14, 24, 0.9)';
			ctx.lineWidth = 2;
			ctx.fill();
			ctx.stroke();
			ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
		} else {
			ctx.beginPath();
			ctx.arc(x, y, 6.5, 0, Math.PI * 2);
			ctx.fillStyle = pin.color;
			ctx.strokeStyle = 'rgba(8, 14, 24, 0.9)';
			ctx.lineWidth = 2;
			ctx.fill();
			ctx.stroke();
		}
		// the name pill: name, level, a dot (green while playing)
		ctx.font = '600 12px Inter, system-ui, sans-serif';
		const level = pin.level != null ? ` ${pin.level}` : '';
		const tw = ctx.measureText(pin.name).width;
		ctx.font = '500 11px Inter, system-ui, sans-serif';
		const lw = level ? ctx.measureText(level).width : 0;
		// The name pill, to the right of the pin; to its left where the map's edge would cut it off.
		const pw = tw + lw + 30, ph = 22;
		const left = x + 13 + pw > this.w - 6 && x - 13 - pw >= 6;
		const px = left ? x - 13 - pw : x + 13;
		// Characters together: their pills stack instead of hiding each other.
		let py = y - ph / 2;
		while (this.pills.some(([ax, ay, aw, ah]) => px < ax + aw && px + pw > ax && py < ay + ah && py + ph > ay)) py += ph + 3;
		this.pills.push([px, py, pw, ph]);
		const ty = py + ph / 2;
		if (py !== y - ph / 2) {
			ctx.beginPath();
			ctx.moveTo(left ? x - 6 : x + 6, y);
			ctx.lineTo(left ? px + pw : px, ty);
			ctx.strokeStyle = pin.color;
			ctx.lineWidth = 1.2;
			ctx.stroke();
		}
		ctx.beginPath();
		ctx.roundRect(px, py, pw, ph, 11);
		ctx.fillStyle = 'rgba(14, 20, 34, 0.94)';
		ctx.fill();
		ctx.lineWidth = 1.5;
		ctx.strokeStyle = pin.color;
		ctx.stroke();
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'left';
		ctx.font = '600 12px Inter, system-ui, sans-serif';
		ctx.fillStyle = '#f7f8fd';
		ctx.fillText(pin.name, px + 10, ty + 0.5);
		if (level) {
			ctx.font = '500 11px Inter, system-ui, sans-serif';
			ctx.fillStyle = '#9ba2b9';
			ctx.fillText(level, px + 10 + tw, ty + 0.5);
		}
		ctx.beginPath();
		ctx.arc(px + pw - 9, ty, 3, 0, Math.PI * 2);
		// Green while playing, grey when not (as the sidebar's dot): never the character's own colour,
		// which may itself be a green.
		ctx.fillStyle = pin.playing ? '#6bd999' : '#5b6278';
		ctx.fill();
		ctx.restore();
		this.shown.push({ x, y, r: 12, hit: { kind: 'pin', pin } });
		this.shown.push({ x: px + pw / 2, y: ty, r: 0, box: [px, py, pw, ph], hit: { kind: 'pin', pin } });
	}
}

/** A colour per character, stable by its place in the list. */
export const PALETTE = ['#5cc8f0', '#b58cff', '#f0b45c', '#6fdc8c', '#f07cb4', '#ff8f5a', '#7f9cff', '#e6e66b'];
