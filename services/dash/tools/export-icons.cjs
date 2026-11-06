// Pre-renders the game icons the dashboard shows, with Polestar's icon module
// (tools/planner/icons.js: client textures from wago.tools, decoded from BLP), into the server's art
// folder (`serve --art`): icons/race/<Race>-<male|female>.png (the game's character portrait icons)
// and icons/class/<CLASS>.png. Blizzard's art: local only, never committed or published.
//
//   node services/dash/tools/export-icons.cjs <art dir> [--items-from <server url>]
//
// --items-from also renders icons/item/<id>.png for every item the server's snapshots and quest rewards hold
// (GET /api/item-ids); run it again after new snapshots arrive (present icons are kept).
const fs = require('node:fs');
const path = require('node:path');
const { openIcons } = require('../../../tools/planner/icons');
const { CLASS_FILES, RACE_FILES } = require('../../../tools/lib/game/races');

async function main() {
	const art = process.argv[2];
	if (!art) throw new Error('usage: export-icons.cjs <art dir>');
	const icons = openIcons();
	const jobs = [...RACE_FILES.flatMap((r) => ['male', 'female'].map((s) => ['race', `${r}-${s}`])), ...CLASS_FILES.map((c) => ['class', c])];
	const from = process.argv.indexOf('--items-from');
	if (from > 0) {
		const res = await fetch(new URL('/api/item-ids', process.argv[from + 1]));
		if (!res.ok) throw new Error(`item ids: ${res.status}`);
		for (const id of await res.json()) jobs.push(['item', String(id)]);
	}
	let n = 0;
	for (const [kind, key] of jobs) {
		if (fs.existsSync(path.join(art, 'icons', kind, `${key}.png`))) {
			n++;
			continue;
		}
		const png = await icons.icon(kind, key);
		if (!png) {
			console.warn(`no icon: ${kind} ${key}`);
			continue;
		}
		fs.mkdirSync(path.join(art, 'icons', kind), { recursive: true });
		fs.writeFileSync(path.join(art, 'icons', kind, `${key}.png`), png);
		n++;
	}
	console.log(`${n} icons -> ${path.join(art, 'icons')}`);
}

main().catch((e) => {
	console.error(e.message);
	process.exit(1);
});
