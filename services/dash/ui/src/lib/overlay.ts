// Trails, event markers and character pins drawn on a 2D canvas over MapView (which draws the map
// itself): a line per character in its own colour with a dark casing and direction chevrons, the
// part after the replay time faint; level-ups as numbered starbursts; other events as small
// badges; characters as pins with a name pill. Redrawn whenever the map's camera or the data
// changes (checked every animation frame). Projection: MapView's own toScreen, as an affine map
// per continent from three points (exact: MapView's view is linear in world yards).
import type { MapViewApi } from './mapview';
import type { LineStyle } from './timeline';

export interface OverlayLine {
	c: number;
	/** Flat wx, wy pairs. */
	pts: ArrayLike<number>;
	color: string;
	faint: boolean;
	style: LineStyle;
	/** The points either side of this line when the trail goes on through its ends (walking into
	 *  riding, the replay's past into its future): the curve keeps its direction across the join. */
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
 */
export function smooth(p: [number, number][], maxDev: number, pre?: [number, number], post?: [number, number]): [number, number][] {
	if (p.length < 3 || !(maxDev >= 0.5)) return p;
	const out: [number, number][] = [p[0]];
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
		}
	}
	return out;
}

export interface OverlayEvent {
	c: number;
	wx: number;
	wy: number;
	kind: string;
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
	/** Playing at the replay time (bright), else where last seen (dim). */
	online: boolean;
	/** The focused character: drawn as an arrow turned to its heading (radians, clockwise from north). */
	heading?: number;
	id: string;
}
export interface OverlayData {
	lines: OverlayLine[];
	events: OverlayEvent[];
	pins: OverlayPin[];
	/** Many trails over each other (all play): translucent strokes without chevrons, so places
	 *  passed often build up brighter instead of a tangle of solid lines. */
	dense?: boolean;
}
export type Hit = { kind: 'pin'; pin: OverlayPin } | { kind: 'event'; event: OverlayEvent } | null;

/**
 * Douglas-Peucker on flat x, y pairs: the points kept (as flat pairs) so that none of the dropped
 * ones lies further than `tol` from the line. The first and last always stay.
 */
export function simplifyFlat(p: ArrayLike<number>, tol: number): Float32Array {
	const n = p.length >> 1;
	if (n < 3) return Float32Array.from(p);
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
	for (let i = 0; i < n; i++) if (keep[i]) out.push(p[2 * i], p[2 * i + 1]);
	return Float32Array.from(out);
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

export class TrailOverlay {
	private ctx: CanvasRenderingContext2D;
	private data: OverlayData = { lines: [], events: [], pins: [] };
	private dirty = true;
	private raf = 0;
	private lastView = '';
	private w = 0;
	private h = 0;
	private zoom = 1;
	private pills: [number, number, number, number][] = [];
	private shown: { kind: 'pin' | 'event'; x: number; y: number; r: number; ref: OverlayPin | OverlayEvent }[] = [];
	private resize: ResizeObserver;
	/** Long trails thinned per zoom step (tolerance a power of two in yards), with their bounds. */
	private thin = new WeakMap<ArrayLike<number>, { box: [number, number, number, number]; byTol: Map<number, Float32Array> }>();

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
			const v = (this.map as unknown as { view: { x: number; y: number; zoom: number; c: number } }).view;
			const key = v ? `${v.x.toFixed(2)},${v.y.toFixed(2)},${v.zoom.toFixed(6)},${v.c}` : '';
			if (this.dirty || key !== this.lastView) {
				this.lastView = key;
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

	set(data: OverlayData) {
		this.data = data;
		this.dirty = true;
	}

	/** What is under a point in CSS px of the canvas: pins first, then events. */
	hit(sx: number, sy: number): Hit {
		for (let i = this.shown.length - 1; i >= 0; i--) {
			const s = this.shown[i];
			if (Math.hypot(s.x - sx, s.y - sy) <= s.r) return s.kind === 'pin' ? { kind: 'pin', pin: s.ref as OverlayPin } : { kind: 'event', event: s.ref as OverlayEvent };
		}
		return null;
	}

	private fit() {
		const r = this.canvas.getBoundingClientRect();
		const dpr = window.devicePixelRatio || 1;
		this.w = r.width;
		this.h = r.height;
		this.canvas.width = Math.round(r.width * dpr);
		this.canvas.height = Math.round(r.height * dpr);
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
		this.zoom = (this.map as unknown as { view?: { zoom: number } }).view?.zoom ?? 1;
		const cache = new Map<number, Affine | null>();
		const proj = (c: number, wx: number, wy: number): [number, number] | null => {
			if (!cache.has(c)) cache.set(c, this.affine(c, wx, wy));
			const a = cache.get(c);
			if (!a) return null;
			const dx = wx - a.wx0, dy = wy - a.wy0;
			return [a.x0 + a.ax * dx + a.bx * dy, a.y0 + a.ay * dx + a.by * dy];
		};
		const { lines, events, pins, dense } = this.data;
		for (const l of lines.filter((l) => l.faint)) this.line(l, proj, !!dense);
		for (const l of lines.filter((l) => !l.faint)) this.line(l, proj, !!dense);
		for (const e of events) this.event(e, proj);
		for (const p of [...pins].sort((a, b) => Number(a.online) - Number(b.online) || Number(a.heading !== undefined) - Number(b.heading !== undefined))) this.pin(p, proj);
	}

	private screenPts(c: number, pts: ArrayLike<number>, proj: (c: number, wx: number, wy: number) => [number, number] | null): [number, number][] {
		const out: [number, number][] = [];
		for (let i = 0; i + 1 < pts.length; i += 2) {
			const p = proj(c, pts[i], pts[i + 1]);
			if (!p) return [];
			const last = out[out.length - 1];
			if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= MIN_STEP || i + 2 >= pts.length) out.push(p);
		}
		return out;
	}

	/** A long trail's points thinned for this zoom (cached per power-of-two tolerance), or null when
	 *  it lies wholly off screen. Short trails come back as they are. */
	private visiblePts(l: OverlayLine, pxPerYd: number, proj: (c: number, wx: number, wy: number) => [number, number] | null): ArrayLike<number> | null {
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
		if (l.pts.length < 2 * RESIMPLIFY_FROM || !(pxPerYd > 0)) return l.pts;
		const tol = 2 ** Math.floor(Math.log2(RESIMPLIFY_PX / pxPerYd));
		if (tol < 0.75) return l.pts; // finer than the server's own simplification already
		let thin = e.byTol.get(tol);
		if (!thin) e.byTol.set(tol, (thin = simplifyFlat(l.pts, tol)));
		return thin;
	}

	private line(l: OverlayLine, proj: (c: number, wx: number, wy: number) => [number, number] | null, dense: boolean) {
		if (l.pts.length < 4) return;
		// Screen px per world yard here (MapView's view is linear in yards).
		const a = proj(l.c, l.pts[0], l.pts[1]), b = proj(l.c, l.pts[0] + 1, l.pts[1]);
		const pxPerYd = a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0;
		const given = this.visiblePts(l, pxPerYd, proj);
		if (!given) return;
		const raw = this.screenPts(l.c, given, proj);
		if (raw.length < 2) return;
		const flight = l.style === 'flight', ghost = l.style === 'ghost', mount = l.style === 'mount';
		// A flight is a straight guess between take-off and landing: never bent.
		const side = (q?: [number, number]) => (q ? (proj(l.c, q[0], q[1]) ?? undefined) : undefined);
		const pts = flight ? raw : smooth(raw, SMOOTH_YD * pxPerYd, side(l.pre), side(l.post));
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
			ctx.globalAlpha = l.faint ? 0.12 : 0.34;
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
		ctx.globalAlpha = (l.faint ? 0.35 : 1) * (flight ? 0.7 : 1);
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
		if (!l.faint) {
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

	private event(e: OverlayEvent, proj: (c: number, wx: number, wy: number) => [number, number] | null) {
		if (this.zoom < (e.kind === 'level' || e.kind === 'milestone' ? LEVELS_FROM : EVENTS_FROM)) return;
		const p = proj(e.c, e.wx, e.wy);
		if (!p || p[0] < -30 || p[1] < -30 || p[0] > this.w + 30 || p[1] > this.h + 30) return;
		const [x, y] = p;
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
			this.shown.push({ kind: 'event', x, y, r: 13, ref: e });
			return;
		}
		if (e.kind === 'milestone') {
			// a first or a round number: a pale five-pointed star
			this.glow(x, y, 18, '#ffe9a8', 0.45);
			this.star(x, y, 10);
			this.shown.push({ kind: 'event', x, y, r: 11, ref: e });
			return;
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
		this.shown.push({ kind: 'event', x, y, r: 10, ref: e });
	}

	private pin(pin: OverlayPin, proj: (c: number, wx: number, wy: number) => [number, number] | null) {
		const p = proj(pin.c, pin.wx, pin.wy);
		if (!p) return;
		const [x, y] = p;
		const ctx = this.ctx;
		ctx.save();
		ctx.globalAlpha = pin.online || pin.heading !== undefined ? 1 : 0.6;
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
		// the name pill, to the right: name, level, a dot in the character's colour
		ctx.font = '600 12px Inter, system-ui, sans-serif';
		const level = pin.level != null ? ` ${pin.level}` : '';
		const tw = ctx.measureText(pin.name).width;
		ctx.font = '500 11px Inter, system-ui, sans-serif';
		const lw = level ? ctx.measureText(level).width : 0;
		const pw = tw + lw + 30, ph = 22, px = x + 13;
		// Characters together: their pills stack instead of hiding each other.
		let py = y - ph / 2;
		while (this.pills.some(([ax, ay, aw, ah]) => px < ax + aw && px + pw > ax && py < ay + ah && py + ph > ay)) py += ph + 3;
		this.pills.push([px, py, pw, ph]);
		const ty = py + ph / 2;
		if (py !== y - ph / 2) {
			ctx.beginPath();
			ctx.moveTo(x + 6, y);
			ctx.lineTo(px, ty);
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
		ctx.fillStyle = pin.online ? '#6bd999' : pin.color;
		ctx.fill();
		ctx.restore();
		this.shown.push({ kind: 'pin', x, y, r: 12, ref: pin });
		this.shown.push({ kind: 'pin', x: px + pw / 2, y: ty, r: pw / 2, ref: pin });
	}
}

/** A colour per character, stable by its place in the list. */
export const PALETTE = ['#5cc8f0', '#b58cff', '#f0b45c', '#6fdc8c', '#f07cb4', '#ff8f5a', '#7f9cff', '#e6e66b'];
