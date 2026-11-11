// Playtime and trails: the scrubber's timeline and where a character is at a moment.
import type { Span, Trail } from './api';

/** Intervals merged; the slider's 0..1 maps onto their total length, skipping the gaps between them. */
export class Timeline {
	readonly iv: Span[] = [];
	readonly total: number;
	readonly start: number;
	readonly end: number;

	constructor(intervals: Span[]) {
		const sorted = intervals.filter(([a, b]) => b >= a).map(([a, b]): Span => [a, b]).sort((x, y) => x[0] - y[0]);
		for (const [a, b] of sorted) {
			const last = this.iv[this.iv.length - 1];
			if (last && a <= last[1] + 60) last[1] = Math.max(last[1], b);
			else this.iv.push([a, b]);
		}
		this.total = this.iv.reduce((n, [a, b]) => n + (b - a), 0) || 1;
		this.start = this.iv[0]?.[0] ?? 0;
		this.end = this.iv[this.iv.length - 1]?.[1] ?? 0;
	}

	toT(u: number): number {
		let left = Math.max(0, Math.min(1, u)) * this.total;
		for (const [a, b] of this.iv) {
			if (left <= b - a) return a + left;
			left -= b - a;
		}
		return this.end;
	}

	toU(t: number): number {
		let n = 0;
		for (const [a, b] of this.iv) {
			if (t <= b) return (n + Math.max(0, t - a)) / this.total;
			n += b - a;
		}
		return 1;
	}

	/** Where each later interval starts, as slider fractions (the session boundaries). */
	ticks(): number[] {
		let n = 0;
		return this.iv.map(([a, b]) => ((n += b - a), (n - (b - a)) / this.total)).slice(1);
	}

	/** The moment dt seconds of play after t. */
	advance(t: number, dt: number): number {
		return this.toT(this.toU(t) + dt / this.total);
	}
}

/** Where the last `hours` of playtime begin in a character's sessions (oldest first). */
export function playtimeFrom(sessions: Span[], hours: number): number {
	let left = hours * 3600;
	for (let i = sessions.length - 1; i >= 0; i--) {
		const [a, b] = sessions[i];
		if (b - a >= left) return b - left;
		left -= b - a;
	}
	return sessions[0]?.[0] ?? 0;
}

export const inSessions = (sessions: Span[], t: number) => sessions.some(([a, b]) => t >= a - 60 && t <= b + 60);

export interface At {
	c: number;
	wx: number;
	wy: number;
	/** Radians clockwise from north on screen. */
	heading: number;
	k: number;
}

/** Heading of the step into point i (world x is north, world y is west). */
function dirOf(p: number[], i: number): number {
	if (i < 1) return 0;
	return Math.atan2(-(p[2 * i + 1] - p[2 * i - 1]), p[2 * i] - p[2 * i - 2]);
}

function posIn(s: Trail, t: number): At {
	const ts = s.ts;
	let lo = 0;
	let hi = ts.length - 1;
	while (lo < hi - 1) {
		const mid = (lo + hi) >> 1;
		if (ts[mid] <= t) lo = mid;
		else hi = mid;
	}
	const k = lo;
	const f = Math.max(0, Math.min(1, (t - ts[k]) / (ts[k + 1] - ts[k] || 1)));
	const p = s.pts;
	return { k, c: s.c, wx: p[2 * k] + (p[2 * k + 2] - p[2 * k]) * f, wy: p[2 * k + 1] + (p[2 * k + 3] - p[2 * k + 1]) * f, heading: dirOf(p, k + 1) };
}

/** The character at t: interpolated inside a segment, else where it last was before t. */
export function posAt(segs: Trail[], t: number): At | null {
	let best: (At & { t: number }) | null = null;
	for (const s of segs) {
		const ts = s.ts;
		if (!ts.length || ts[0] > t) continue;
		if (ts.length > 1 && t <= ts[ts.length - 1]) return posIn(s, t);
		const n = ts.length - 1;
		if (!best || ts[n] > best.t) best = { t: ts[n], k: n, c: s.c, wx: s.pts[2 * n], wy: s.pts[2 * n + 1], heading: dirOf(s.pts, n) };
	}
	return best;
}

/** How a stretch of trail is drawn: on foot, mounted, dead (a ghost run) or a flight. */
export type LineStyle = 'walk' | 'mount' | 'ghost' | 'flight';

/** MapView's own route format (lib/mapview.ts `setRoute`; the dashboard draws its trails itself). */
export interface Route {
	c: number;
	pts: Float32Array;
	mode: LineStyle;
	state: 'past' | 'future';
}

export const styleOf = (s: Trail): LineStyle => (s.flight ? 'flight' : s.ghost ? 'ghost' : s.mounted ? 'mount' : 'walk');
