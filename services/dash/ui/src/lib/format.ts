import type { Character } from './api';

export const hhmm = (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const day = (t: number) => new Date(t * 1000).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

export function ago(t: number): string {
	const s = Date.now() / 1000 - t;
	if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
	if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
	return `${Math.round(s / 86400)} days ago`;
}

const RACE: Record<string, string> = { Scourge: 'Undead', NightElf: 'Night Elf' };
export const raceName = (r: string | null) => (r ? RACE[r] || r : '');
export const className = (c: string | null) => (c ? c[0] + c.slice(1).toLowerCase() : '');

/** The game's character portrait icon for a race and sex (exported by tools/export-icons.cjs into the art folder). */
export const portraitUrl = (race: string | null, sex: number | null) => (race ? `/art/icons/race/${race}-${sex === 3 ? 'female' : 'male'}.png` : null);
export const classIconUrl = (cls: string | null) => (cls ? `/art/icons/class/${cls}.png` : null);
/** Forever's realm folders are numbers; show a realm only when it has a name. */
export const realmName = (r: string | null) => (r && !/^\d+$/.test(r) ? r : '');
export const fullName = (c: { name: string | null; surname: string | null; id: string }) => [c.name || c.id, c.surname].filter(Boolean).join(' ');

/** Copper as the game shows it: 12g 3s 40c. */
export function gold(copper: number | null | undefined): string {
	if (copper == null) return '';
	const g = Math.floor(copper / 10000), s = Math.floor((copper % 10000) / 100), c = copper % 100;
	return [g && `${g}g`, (g || s) && `${s}s`, `${c}c`].filter(Boolean).join(' ');
}

/** The game's item quality colours (poor ... heirloom). */
export const QUALITY = ['#9d9d9d', '#ffffff', '#1eff00', '#2f8cff', '#a335ee', '#ff8000', '#e6cc80', '#00ccff'];
export const qualityColor = (q: number | null | undefined) => QUALITY[q ?? 1] ?? QUALITY[1];
export const itemIconUrl = (id: number) => `/art/icons/item/${id}.png`;

/** The game's class colours (RAID_CLASS_COLORS). */
const CLASS_COLOR: Record<string, string> = {
	WARRIOR: '#c69b6d', PALADIN: '#f48cba', HUNTER: '#aad372', ROGUE: '#fff468', PRIEST: '#ffffff', SHAMAN: '#0070dd',
	MAGE: '#3fc7eb', WARLOCK: '#8788ee', DRUID: '#ff7c0a',
};
export const classColor = (cls: string | null) => (cls && CLASS_COLOR[cls]) || 'var(--text)';
/** The game's power bar colours. */
const POWER_COLOR: Record<string, string> = { MANA: '#3a8cff', RAGE: '#ff4d4d', ENERGY: '#ffe34d', FOCUS: '#ff9a4d' };
export const powerColor = (t: string | undefined) => (t && POWER_COLOR[t]) || '#3a8cff';
/** Copper as gold, silver and copper parts (for coloured display). */
export function coins(copper: number | null | undefined): { g: number; s: number; c: number } | null {
	if (copper == null) return null;
	return { g: Math.floor(copper / 10000), s: Math.floor((copper % 10000) / 100), c: copper % 100 };
}

/**
 * Rested XP now: the last known value plus what accrued since logout. Classic's rules, as Polestar
 * estimates them: 5% of a level per 8 hours in an inn or city, a quarter of that elsewhere, capped at
 * 1.5 levels. Recorder data (xp_t) wins while playing; Polestar's alts entry gives logout and resting.
 */
export function restedNow(c: Character, now = Date.now() / 1000): { rested: number; estimated: boolean } | null {
	const p = c.polestar;
	const xpMax = c.xpMax ?? p?.xpMax;
	if (!xpMax) return null;
	const cap = 1.5 * xpMax;
	// The newer of the two readings.
	const fromRecorder = c.rested != null && c.xpAt != null && (p?.seen == null || c.xpAt >= p.seen);
	const base = fromRecorder ? c.rested! : (p?.rested ?? c.rested ?? 0);
	const at = fromRecorder ? c.xpAt! : (p?.seen ?? c.last ?? now);
	// Still playing: no accrual while logged in (the next upload carries it).
	if (c.last && now - c.last < 600) return { rested: Math.min(cap, base), estimated: false };
	const rate = (p?.resting ? 0.05 : 0.0125) * xpMax / (8 * 3600);
	const since = Math.max(0, now - at);
	return { rested: Math.min(cap, Math.round(base + rate * since)), estimated: since > 600 };
}
