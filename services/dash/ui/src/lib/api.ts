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
	/** From Polestar's own per-character data (PolestarDB.alts). */
	realmName: string | null;
	money: number | null;
	bind: string | null;
	guide: { title: string; id: string; step: number; count: number } | null;
	/** When the latest Polestar_DashSnapshot save was written, if any. */
	snapshotAt: number | null;
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
}

/** A segment with its points ready for MapView. */
export interface Trail extends Segment {
	f32: Float32Array;
}

export interface DashEvent {
	char: string;
	t: number;
	kind: string;
	text: string;
	pos: Pos | null;
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

export interface Session {
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

export interface Snapshot {
	saved: number;
	name: string | null;
	realm: string | null;
	money: number | null;
	equipAt: number | null;
	bagsAt: number | null;
	bankAt: number | null;
	equip: Item[];
	bags: Container[] | null;
	bank: Container[] | null;
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
	journal: (char: string) => get<Session[]>(`/api/journal?${q({ char })}`),
	snapshot: (char: string) => get<Snapshot | null>(`/api/snapshot?${q({ char })}`),
	addNote: async (char: string, t: number, text: string) => {
		const r = await fetch('/api/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ char, t, text }) });
		if (!r.ok) throw new Error(`notes: ${r.status}`);
	},
};

export const prep = (segs: Segment[]): Trail[] => segs.map((s) => ({ ...s, f32: Float32Array.from(s.pts) }));
