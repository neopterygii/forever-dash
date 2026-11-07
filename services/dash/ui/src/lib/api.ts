// The server's read API (services/dash/src/read.rs), typed.

export interface Pos {
	map?: number;
	x?: number;
	y?: number;
	c?: number;
	wx?: number;
	wy?: number;
}

export interface Character {
	id: string;
	name: string | null;
	realm: string | null;
	race: string | null;
	class: string | null;
	faction: string | null;
	level: number | null;
	/** Forever characters have surnames. */
	surname: string | null;
	/** UnitSex: 2 male, 3 female. */
	sex: number | null;
	xp: number | null;
	xpMax: number | null;
	rested: number | null;
	/** When xp/xpMax/rested were recorded. */
	xpAt: number | null;
	/** Polestar's own entry (PolestarDB.alts): when seen, rested XP then, whether in an inn or city. */
	polestar: { seen: number | null; rested: number | null; resting: boolean | null; xp: number | null; xpMax: number | null };
	/** From Polestar's own per-character data (PolestarDB.alts). */
	realmName: string | null;
	money: number | null;
	bind: string | null;
	guide: { title: string; id: string; step: number; count: number } | null;
	/** When the latest Polestar_DashSnapshot save was written, if any. */
	snapshotAt: number | null;
	/** From that save: maximum health and power, the attributes. */
	vitals: Stats5 | null;
	chunks: number;
	first: number | null;
	last: number | null;
	lastPos?: Pos & { t: number; flags: number; zone?: string; subzone?: string };
}

export interface Segment {
	c: number;
	/** Flat wx, wy pairs (MapView's route format). */
	pts: number[];
	ts: number[];
	ghost: boolean;
	/** Riding a mount the whole way. */
	mounted: boolean;
	/** A flight: where it was taken and where it landed (the way between is not recorded). */
	flight: boolean;
}

/** A segment with its points ready for MapView. */
export interface Trail extends Segment {
	f32: Float32Array;
}

export interface Narration {
	url: string;
	length: number;
}

export interface DashEvent {
	char: string;
	t: number;
	kind: string;
	text: string;
	pos: Pos | null;
	/** On accept, turn-in, abandon and fail lines. */
	quest?: { id: number; level: number | null; audio: Narration | null } | null;
	/** On a meeting with another player (kind `met`): how, and who ("Name-Realm"). */
	how?: string;
	person?: string;
}

export interface JournalPage {
	sessions: Session[];
	/** Older sessions remain (ask with `before` = the oldest one's start). */
	more: boolean;
}

export interface QuestNpc {
	kind: 'npc' | 'object';
	id: number;
	name: string;
}

/** Everything the journal's quest card shows (read.rs `quest`). */
export interface QuestInfo {
	id: number;
	title: string;
	level: number | null;
	minLevel: number | null;
	zone: string | null;
	objectives: string | null;
	details: string | null;
	giver: QuestNpc | null;
	ender: QuestNpc | null;
	next: { id: number; title: string } | null;
	history: { t: number; kind: string }[];
	accepted: number | null;
	done: number | null;
	seconds: number | null;
	rewards: { xp: number | null; money: number | null; items: Item[]; choices: Item[] } | null;
	paid: { xp: number | null; money: number | null; chosen: Item | null } | null;
	refXp: number | null;
	kills: number;
	audio: { accept: Narration | null; complete: Narration | null };
}

export type Span = [number, number];

export interface OverviewChar {
	char: string;
	from: number;
	to: number;
	sessions: Span[];
	segments: Segment[];
	points: number;
	events: DashEvent[];
}

/** A session's diary entry: yours, the model's prose, or written from the log (diary.rs). */
export interface DiaryEntry {
	text: string;
	source: 'you' | 'ai' | 'template';
	model?: string | null;
	at?: number;
}

export interface Session {
	/** Whose session (the journal of everyone mixes them). */
	char: string;
	diary: DiaryEntry;
	start: number;
	end: number;
	seconds: number;
	zones: string[];
	kills: number;
	killXp: number;
	quests: number;
	deaths: number;
	levels: number[];
	yards: number;
	/** Time spent grouped; null when solo throughout. `with`: this dashboard's characters grouped at the same time. */
	group: { seconds: number; party: number; raid: number; with: { char: string; name: string }[] } | null;
	/** Gathering counts: herb, ore, skin, fish, lock (absent kinds are zero). */
	gathered: Partial<Record<'herb' | 'ore' | 'skin' | 'fish' | 'lock', number>>;
	events: Omit<DashEvent, 'char'>[];
	notes: { id: number; t: number; text: string }[];
}

export interface Item {
	id: number;
	name?: string;
	/** 0 poor ... 5 legendary. */
	quality?: number | null;
	ilvl?: number | null;
	reqLevel?: number | null;
	invType?: number | null;
	icon?: number | null;
	count?: number;
	slot?: number;
	slotName?: string;
	itemString?: string;
}

export interface Container {
	bag: number;
	size: number;
	item: Item | null;
	slots: Item[];
}

export interface Stats5 {
	health?: number;
	power?: number;
	/** MANA, RAGE, ENERGY... */
	powerType?: string;
	str?: number;
	agi?: number;
	sta?: number;
	int?: number;
	spi?: number;
	armor?: number;
}

export interface Snapshot {
	saved: number;
	name: string | null;
	realm: string | null;
	money: number | null;
	equipAt: number | null;
	bagsAt: number | null;
	bankAt: number | null;
	equip: Item[];
	stats: Stats5 | null;
	statsAt: number | null;
	bags: Container[] | null;
	bank: Container[] | null;
}

/** How a player was met (Polestar_DashSnapshot's People.lua). */
export type How = 'group' | 'trade' | 'duel' | 'seen' | 'fought' | 'killedby' | 'killed';

/** A player one of our characters met, as last seen in game, with your rating and notes. */
export interface Person {
	who: string;
	name: string;
	realm: string | null;
	class: string | null;
	race: string | null;
	sex: number | null;
	level: number | null;
	guild: string | null;
	faction: string | null;
	seen: number | null;
	rating: number | null;
	note: string | null;
	/** Our own character this is, when it is one. */
	ours: string | null;
}

export interface PersonRow extends Person {
	first: number;
	last: number;
	count: number;
	hows: Partial<Record<How, number>>;
	/** Our characters that met them. */
	chars: string[];
}

export interface Meeting {
	char: string;
	t: number;
	how: How;
	note: string | null;
	text: string;
	zone: string | null;
	pos: Pos | null;
}

export interface PersonDetail extends Person {
	met: Meeting[];
}

export interface Stats {
	chunks: number;
	positions: number;
	events: number;
	characters: number;
	maps: number;
}

async function get<T>(path: string): Promise<T> {
	const r = await fetch(path);
	if (!r.ok) throw new Error(`${path}: ${r.status}`);
	return r.json() as Promise<T>;
}

const q = (params: Record<string, string | number>) => new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();

export const api = {
	characters: () => get<Character[]>('/api/characters'),
	stats: () => get<Stats>('/api/stats'),
	overview: (hours: number, tol = 8) => get<{ hours: number; characters: OverviewChar[] }>(`/api/overview?${q({ hours, tol })}`),
	sessions: (char: string) => get<Span[]>(`/api/sessions?${q({ char })}`),
	trail: (char: string, from: number, to: number, tol = 1.5) => get<{ segments: Segment[]; points: number; kept: number }>(`/api/trail?${q({ char, from, to, tol })}`),
	events: (char: string, from: number, to: number, kinds: string[]) => get<DashEvent[]>(`/api/events?${q({ char, from, to, kinds: kinds.join(',') })}`),
	/** Every character's events in [from, to] (all journal kinds when `kinds` is empty). */
	allEvents: (from: number, to: number, kinds: string[] = []) => get<DashEvent[]>(`/api/events?${q({ from, to, kinds: kinds.join(',') })}`),
	/** A page of one character's journal (everyone's when `char` is undefined), newest first: the sessions after `after` (the last one shown; default: the newest). */
	journal: (char: string | undefined, after?: Session, limit = 10) =>
		get<JournalPage>(`/api/journal?${q({ limit, ...(char ? { char } : {}), ...(after ? { before: after.start, beforeChar: after.char } : {}) })}`),
	quest: (char: string, id: number) => get<QuestInfo>(`/api/quest?${q({ char, id })}`),
	snapshot: (char: string) => get<Snapshot | null>(`/api/snapshot?${q({ char })}`),
	/** Your own diary entry for a session; empty text goes back to the written one. */
	setDiary: async (char: string, start: number, text: string) => {
		const r = await fetch('/api/diary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ char, start, text }) });
		if (!r.ok) throw new Error(`diary: ${r.status}`);
	},
	/** Everyone met, by one character or by any. */
	people: (char?: string) => get<PersonRow[]>(`/api/people?${q(char ? { char } : {})}`),
	person: (who: string) => get<PersonDetail | null>(`/api/person?${q({ who })}`),
	/** Your rating (1-5, 0 clears) and notes for a player. */
	setPerson: async (who: string, rating: number, note: string) => {
		const r = await fetch('/api/person', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ who, rating, note }) });
		if (!r.ok) throw new Error(`person: ${r.status}`);
	},
	addNote: async (char: string, t: number, text: string) => {
		const r = await fetch('/api/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ char, t, text }) });
		if (!r.ok) throw new Error(`notes: ${r.status}`);
	},
};

export const prep = (segs: Segment[]): Trail[] => segs.map((s) => ({ ...s, f32: Float32Array.from(s.pts) }));
