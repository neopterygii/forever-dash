// The dashboard's state: which mode the map is in, what is loaded for it, and the playback time.
//
// - overview: every character, the last N hours of *playtime* each (coarse trails, milestones, a
//   pin per character). The buffer bounds what the page loads; the database keeps everything.
// - focus: one character in full detail (fine trail, arrow, journal events as pins), the others
//   faint. Its buffer defaults to the last session and can grow to all play.
import { api, auth, prep, type Access, type Character, type DashEvent, type OverviewChar, type Span, type Trail, type UploadPc } from './api';
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

function readFlag(key: string, fallback: boolean): boolean {
	try {
		const v = localStorage.getItem(key);
		return v === null ? fallback : v === '1';
	} catch {
		return fallback;
	}
}

/** How often the page asks whether newer play was uploaded (seconds). */
const REFRESH_EVERY = 60;

class Dash {
	chars = $state.raw<Character[]>([]);
	/** The PCs that upload these characters, the latest first. */
	uploads = $state.raw<UploadPc[]>([]);
	/** Bumped when newer data was loaded: whatever shows the journal reads it again. */
	version = $state(0);
	/** Newer play has been uploaded than the map shows (it was replaying, or showing one past session). */
	fresh = $state(false);
	/** The map keeps the selected character in view while its replay plays (kept in this browser). */
	follow = $state(readFlag('dash.follow', true));
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

	setFollow(on: boolean) {
		this.follow = on;
		try {
			localStorage.setItem('dash.follow', on ? '1' : '0');
		} catch {
			/* kept for this page only */
		}
	}

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
		const [chars, uploads] = await Promise.all([api.characters(), api.uploads().catch(() => [])]);
		this.chars = chars;
		this.uploads = uploads;
		await this.applyLocation();
		this.watch();
	}

	/** At the newest moment of what is loaded (not replaying the past). */
	get atLatest() {
		return !!this.timeline && this.t >= this.timeline.end - 1;
	}

	// Newer play: the page asks every minute, and when it comes back to the front. Looking at the
	// latest moment, the map simply moves on (the view stays where it is); replaying the past or one
	// past session, it says so and waits to be asked.

	private watching = false;
	private watch() {
		if (this.watching) return;
		this.watching = true;
		const check = () => {
			if (document.visibilityState === 'visible' && !this.signedOut && this.access) this.checkFresh().catch(() => {});
		};
		setInterval(check, REFRESH_EVERY * 1000);
		document.addEventListener('visibilitychange', check);
	}

	private stamp(chars: Character[]) {
		return chars.map((c) => `${c.id}:${c.last ?? 0}:${c.level ?? 0}:${c.snapshotAt ?? 0}`).sort().join('|');
	}

	async checkFresh() {
		const chars = await api.characters();
		if (this.stamp(chars) === this.stamp(this.chars)) return;
		const played = Math.max(0, ...chars.map((c) => c.last ?? 0)) > Math.max(0, ...this.chars.map((c) => c.last ?? 0));
		this.chars = chars;
		api.uploads().then((u) => (this.uploads = u)).catch(() => {});
		this.version++;
		if (!played) return;
		const pinned = this.mode === 'focus' && this.focus?.buffer.startsWith('s:');
		if (this.atLatest && !this.playing && !pinned) await this.showLatest();
		else this.fresh = true;
	}

	/** Loads the newest play into the view shown, leaving the map where it is. */
	async showLatest() {
		this.fresh = false;
		if (this.mode === 'focus' && this.focus) {
			const b = this.focus.buffer;
			await this.showFocus(this.focus.id, b.startsWith('s:') ? 'session' : b, false);
		} else await this.showOverview(this.overview?.hours ?? 6, false);
	}

	// What is shown lives in the address: #c=<character>&b=<buffer>&t=<replay time>&j=1 (journal
	// open), or #h=<hours>&t=... for everyone. Back leaves a character for the overview (or the one
	// before); a reload or a shared link opens the same character, session and moment.

	private params() {
		return new URLSearchParams(location.hash.slice(1));
	}

	/** The character the address names, if it is one we know. */
	private locationChar(p = this.params()): string | null {
		const id = p.get('c');
		return id && this.chars.some((c) => c.id === id) ? id : null;
	}

	/** Shows what the address names (at load and on Back/Forward). */
	async applyLocation() {
		const p = this.params();
		const id = this.locationChar(p);
		if (id) {
			const buffer = p.get('b') || 'session';
			const valid = buffer === 'session' || buffer === 'all' || /^\d+$/.test(buffer) || /^s:[\d.]+:[\d.]+$/.test(buffer);
			if (this.mode !== 'focus' || this.focus?.id !== id || (p.has('b') && this.focus.buffer !== buffer)) await this.showFocus(id, valid ? buffer : 'session');
		} else {
			const hours = Number(p.get('h')) || this.overview?.hours || 6;
			if (this.mode !== 'overview' || !this.overview || this.overview.hours !== hours) await this.showOverview(OVERVIEW_BUFFERS.some(([h]) => h === hours) ? hours : 6);
		}
		const t = Number(p.get('t'));
		if (t && this.timeline) this.t = Math.max(this.timeline.start, Math.min(this.timeline.end, t));
		if (p.has('j')) this.journalOpen = true;
	}

	/** The address for what is shown now. */
	private hash(): string {
		const p = new URLSearchParams();
		if (this.mode === 'focus' && this.focus) {
			p.set('c', this.focus.id);
			if (this.focus.buffer !== 'session') p.set('b', this.focus.buffer);
		} else if (this.overview && this.overview.hours !== 6) p.set('h', String(this.overview.hours));
		if (this.timeline && !this.atLatest) p.set('t', String(Math.round(this.t)));
		if (this.journalOpen) p.set('j', '1');
		const s = p.toString().replace(/%3A/g, ':');
		return s ? `#${s}` : '';
	}

	/** Keeps the address in step: a new history entry when the character changed, else the entry
	 *  rewritten (a new buffer, another moment, the journal opened). */
	syncLocation() {
		const want = this.hash();
		if (location.hash === want || (!want && !location.hash)) return;
		const url = want || location.pathname + location.search;
		const was = this.params().get('c') ?? '';
		const now = this.mode === 'focus' ? (this.focus?.id ?? '') : '';
		if (was !== now) history.pushState(null, '', url);
		else history.replaceState(null, '', url);
	}

	/** Back to every character (the sidebar's "All characters", the top bar's button, Esc). */
	leaveFocus() {
		return this.showOverview(this.overview?.hours ?? 6);
	}

	private async loadOverview(hours: number) {
		const ov = await api.overview(hours);
		this.overview = { hours, characters: ov.characters.map((c) => ({ ...c, trails: prep(c.segments) })) };
	}

	private setTimeline(intervals: Span[], fit: boolean) {
		this.timeline = new Timeline(intervals);
		this.t = this.timeline.end;
		if (fit) this.fitRequest++;
	}

	/** `fit` false: the map's view is left alone (newer data for what is already shown). */
	async showOverview(hours = 6, fit = true) {
		this.playing = false;
		await this.loadOverview(hours);
		this.mode = 'overview';
		this.focus = null;
		this.fresh = false;
		this.setTimeline(this.overview!.characters.flatMap((c) => c.sessions), fit);
		this.syncLocation();
	}

	async showFocus(id: string, buffer: FocusBuffer = 'session', fit = true) {
		this.playing = false;
		if (!this.overview || !fit) await this.loadOverview(this.overview?.hours ?? 6);
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
		this.focus = { id, buffer, sessions, from, to, trails: prep(trail.segments), events };
		this.mode = 'focus';
		if (!buffer.startsWith('s:')) this.fresh = false;
		this.setTimeline(sessions.filter(([a, b]) => b >= from && a <= to).map(([a, b]): Span => [Math.max(a, from), Math.min(b, to)]), fit);
		this.syncLocation();
	}

	async signIn(code: string): Promise<boolean> {
		if (!(await api.signIn(code))) return false;
		await this.load();
		return true;
	}

	async signOut() {
		await api.signOut();
		this.chars = [];
		this.uploads = [];
		this.fresh = false;
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
