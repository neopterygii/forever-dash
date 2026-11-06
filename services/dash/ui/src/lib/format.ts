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
