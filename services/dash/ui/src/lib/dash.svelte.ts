// The dashboard's state: which mode the map is in, what is loaded for it, and the playback time.
//
// - overview: every character, the last N hours of *playtime* each (coarse trails, milestones, a
//   pin per character). The buffer bounds what the page loads; the database keeps everything.
// - focus: one character in full detail (fine trail, arrow, journal events as pins), the others
//   faint. Its buffer defaults to the last session and can grow to all play.
import { api, auth, prep, type Access, type Character, type DashEvent, type OverviewChar, type Span, type Stats, type Trail } from './api';
import { Timeline, playtimeFrom } from './timeline';
import { PALETTE } from './overlay';

export type Mode = 'overview' | 'focus';
/** 'session' | hours as a string | 'all' | 's:<start>:<end>' (one session, from the journal). */
export type FocusBuffer = string;

export interface OverviewData {
	hours: number;
	characters: (OverviewChar & { trails: Trail[] })[];
}

export interface FocusData {
	id: string;
	buffer: FocusBuffer;
	sessions: Span[];
	from: number;
	to: number;
	trails: Trail[];
	events: DashEvent[];
	points: number;
	kept: number;
}

/** Journal kinds the focused map shows as pins (glyph, colour token). */
export const PIN: Record<string, [string, string]> = {
	level: ['icon-level', 'success'],
	death: ['cross', 'danger'],
	mark: ['icon-note', 'accent'],
	accept: ['icon-accept', 'quest'],
	turnin: ['icon-turnin', 'quest'],
	explore: ['icon-explore', 'place'],
	enter: ['icon-dungeon', 'dungeon'],
	encounter: ['icon-dungeon', 'dungeon'],
	taxi: ['icon-fly', 'npc'],
	bind: ['icon-hearth', 'npc'],
	learn: ['icon-learn', 'spell'],
	rare: ['icon-kill', 'rare'],
	abandon: ['cross', 'textDim'],
	milestone: ['star', 'accent'],
};

/** Hours: "Last session" covers at least this much play. */
const MIN_SESSION = 0.5;

export const OVERVIEW_BUFFERS: [number, string][] = [[1, 'Last 1 h of play'], [6, 'Last 6 h of play'], [24, 'Last 24 h of play'], [72, 'Last 72 h of play']];
export const FOCUS_BUFFERS: [string, string][] = [['session', 'Last session'], ['2', 'Last 2 h of play'], ['6', 'Last 6 h of play'], ['24', 'Last 24 h of play'], ['all', 'All play']];

function readList(key: string): string[] {
	try {
		const v = JSON.parse(localStorage.getItem(key) ?? '[]');
		return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
	} catch {
		return [];
	}
}

class Dash {
	chars = $state.raw<Character[]>([]);
	stats = $state.raw<Stats | null>(null);
	mode = $state<Mode>('overview');
	overview = $state.raw<OverviewData | null>(null);
	focus = $state.raw<FocusData | null>(null);
	timeline = $state.raw<Timeline | null>(null);
	/** Playback time (epoch seconds). */
	t = $state(0);
	playing = $state(false);
	/** The journal panel over the map. */
	journalOpen = $state(false);
	/** Per viewer, kept in this browser: characters starred (listed first) and hidden from the map. */
	starred = $state<string[]>(readList('dash.starred'));
	hidden = $state<string[]>(readList('dash.hidden'));

	toggle(list: 'starred' | 'hidden', id: string) {
		const cur = this[list];
		this[list] = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
		try {
			localStorage.setItem(`dash.${list}`, JSON.stringify(this[list]));
		} catch {
			/* private window or blocked storage: kept for this page only */
		}
	}

	/** A spot the map should go to (a journal event clicked): consumed by the map. */
	focusPoint = $state.raw<{ c: number; wx: number; wy: number } | null>(null);
	/** The character sheet window: whose, and gear or bags. */
	sheet = $state<{ id: string; view: 'gear' | 'bags' | 'stats' } | null>(null);
	/** The People window: open with the list (who null) or one player's card. */
	people = $state<{ who: string | null } | null>(null);
	/** Bumped to ask the map to fit its view to what is loaded. */
	fitRequest = $state(0);
	error = $state<string | null>(null);

	/** The character's colour on the map and its card (lib/overlay.ts PALETTE). */
	colorOf(id: string): string {
		const i = this.chars.findIndex((c) => c.id === id);
		return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
	}

	name(id: string): string {
		const c = this.chars.find((x) => x.id === id);
		return c ? [c.name || id, c.surname].filter(Boolean).join(' ') : id;
	}

	/** Who is viewing (null until asked). With groups and no sign-in, the page shows the sign-in. */
	access = $state<Access | null>(null);

	get signedOut() {
		return !!this.access?.groups && !this.access.signedIn;
	}

	async load() {
		auth.onSignedOut = () => {
			if (this.access) this.access = { ...this.access, signedIn: false, group: null };
		};
		this.access = await api.me();
		if (this.signedOut) return;
		const [chars, stats] = await Promise.all([api.characters(), api.stats()]);
		this.chars = chars;
		this.stats = stats;
		await this.applyLocation();
	}

	// The selected character lives in the address (#c=<id>): Back leaves a character for the
	// overview (or the one before), and a reload or a shared link opens the same character.

	/** The character the address names, if it is one we know. */
	private locationChar(): string | null {
		const id = new URLSearchParams(location.hash.slice(1)).get('c');
		return id && this.chars.some((c) => c.id === id) ? id : null;
	}

	/** Shows what the address names (at load and on Back/Forward). */
	async applyLocation() {
		const id = this.locationChar();
		if (id) {
			if (this.mode !== 'focus' || this.focus?.id !== id) await this.showFocus(id);
		} else if (this.mode !== 'overview' || !this.overview) {
			await this.showOverview(this.overview?.hours ?? 6);
		}
	}

	/** A new history entry when the selection changed (not for a new buffer of the same one). */
	private syncLocation() {
		const want = this.mode === 'focus' && this.focus ? `#c=${encodeURIComponent(this.focus.id)}` : '';
		if (location.hash === want || (!want && !location.hash)) return;
		history.pushState(null, '', want || location.pathname + location.search);
	}

	/** Back to every character (the sidebar's "All characters", the top bar's button, Esc). */
	leaveFocus() {
		return this.showOverview(this.overview?.hours ?? 6);
	}

	private async loadOverview(hours: number) {
		const ov = await api.overview(hours);
		this.overview = { hours, characters: ov.characters.map((c) => ({ ...c, trails: prep(c.segments) })) };
	}

	private setTimeline(intervals: Span[]) {
		this.timeline = new Timeline(intervals);
		this.t = this.timeline.end;
		this.fitRequest++;
	}

	async showOverview(hours = 6) {
		this.playing = false;
		await this.loadOverview(hours);
		this.mode = 'overview';
		this.focus = null;
		this.setTimeline(this.overview!.characters.flatMap((c) => c.sessions));
		this.syncLocation();
	}

	async showFocus(id: string, buffer: FocusBuffer = 'session') {
		this.playing = false;
		if (!this.overview) await this.loadOverview(6);
		const sessions = await api.sessions(id);
		const last = sessions[sessions.length - 1] ?? [0, 0];
		let from: number, to: number;
		// The last session, reaching back to at least MIN_SESSION of play: a quick login (standing in
		// an inn, a /reload after logging in) is otherwise a session with no path to show.
		if (buffer === 'session') [from, to] = [Math.min(last[0], playtimeFrom(sessions, MIN_SESSION)), last[1]];
		else if (buffer === 'all') [from, to] = [sessions[0]?.[0] ?? 0, last[1]];
		else if (buffer.startsWith('s:')) [from, to] = buffer.slice(2).split(':').map(Number) as Span;
		else [from, to] = [playtimeFrom(sessions, Number(buffer)), last[1]];
		const [trail, events] = await Promise.all([api.trail(id, from, to), api.events(id, from, to, Object.keys(PIN))]);
		this.focus = { id, buffer, sessions, from, to, trails: prep(trail.segments), events, points: trail.points, kept: trail.kept };
		this.mode = 'focus';
		this.syncLocation();
		this.setTimeline(sessions.filter(([a, b]) => b >= from && a <= to).map(([a, b]): Span => [Math.max(a, from), Math.min(b, to)]));
	}

	async signIn(code: string): Promise<boolean> {
		if (!(await api.signIn(code))) return false;
		await this.load();
		return true;
	}

	async signOut() {
		await api.signOut();
		this.chars = [];
		this.overview = null;
		this.focus = null;
		this.mode = 'overview';
		this.timeline = null;
		this.journalOpen = false;
		this.people = null;
		this.sheet = null;
		history.replaceState(null, '', location.pathname + location.search);
		this.access = { groups: true, signedIn: false, group: null };
	}

	/** Runs a load, showing its error instead of throwing. */
	run(p: Promise<unknown>) {
		p.then(() => (this.error = null)).catch((e: unknown) => (this.error = e instanceof Error ? e.message : String(e)));
	}
}

export const dash = new Dash();
