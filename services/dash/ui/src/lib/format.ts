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
