#!/usr/bin/env node
// Writes a synthetic WoW `WTF` folder with Polestar Recorder data (docs/RECORDING.md, schema 2)
// for prototyping the dashboard before real recordings exist:
//
//   node gen-sample.mjs <out-dir> [--days N]
//
//   <out-dir>/WTF/Account/DASHTEST/SavedVariables/Polestar_Recorder.lua       (PolestarRecorderDB)
//   <out-dir>/WTF/Account/DASHTEST/<Realm>/<Name>/SavedVariables/Polestar_Recorder.lua
//                                                                           (PolestarRecorderCharDB)
//
// Two characters play a few sessions each, `--days` days in a row (default 2) from 2026-11-02.
// Positions, quests and NPC ids are made up; the map frames are approximately Classic's.
// Deterministic for a given --days, so re-running with more days extends the same history
// (earlier chunks keep their seq and text: re-uploading them must add nothing).

import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2];
if (!out) {
	console.error('usage: gen-sample.mjs <out-dir> [--days N]');
	process.exit(2);
}
const days = Number(process.argv[process.argv.indexOf('--days') + 1] || 0) || 2;

// uiMap frames: id -> [type, parent, continent, top, left, bottom, right] (world yards).
const MAPS = {
	1429: [3, 1415, 0, -7939.583, 1535.417, -10254.167, -1935.417], // Elwynn Forest
	1436: [3, 1415, 0, -9800.0, 3016.667, -12133.333, -483.333], // Westfall
	1426: [3, 1415, 0, -3877.083, 1802.083, -7160.417, -3122.917], // Dun Morogh
};
const ZONES = { 1429: 'Elwynn Forest', 1436: 'Westfall', 1426: 'Dun Morogh' };

// A small seeded PRNG so the output is stable.
function rng(seed) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const CHARS = [
	{
		name: 'Aldric', realm: 'Dashrealm', id: 'a1dr1c0001', race: 'Human', cls: 'WARRIOR', faction: 'Alliance', sex: 2, level: 4,
		// Each session: start hour (UTC), a list of legs [map, x%, y%, subzone] walked in order, events by leg index.
		sessions: [
			{ hour: 18, legs: [[1429, 48.2, 41.6, 'Northshire Valley'], [1429, 52.9, 33.1, 'Northshire Vineyards'], [1429, 47.6, 31.8, 'Northshire Valley'], [1429, 45.9, 51.0, ''], [1429, 42.1, 65.8, 'Goldshire'], [1429, 39.5, 80.1, 'Fargodeep Mine'], [1429, 42.0, 65.5, 'Goldshire']] },
			{ hour: 20, legs: [[1429, 42.0, 65.5, 'Goldshire'], [1429, 30.3, 64.4, ''], [1429, 24.6, 77.1, 'Westbrook Garrison'], [1436, 59.9, 19.6, 'The Jansen Stead'], [1436, 56.4, 31.5, 'Saldean\'s Farm'], [1436, 51.8, 47.6, 'Sentinel Hill'], [1436, 45.1, 69.9, 'The Dust Plains'], [1436, 52.0, 52.9, 'Sentinel Hill']] },
		],
	},
	{
		name: 'Brannia', realm: 'Dashrealm', id: 'br4nn14002', race: 'Dwarf', cls: 'HUNTER', faction: 'Alliance', sex: 3, level: 6,
		sessions: [
			{ hour: 22, legs: [[1426, 29.9, 71.2, 'Coldridge Valley'], [1426, 22.6, 71.4, 'Coldridge Valley'], [1426, 34.8, 50.5, 'Coldridge Pass'], [1426, 46.7, 53.6, 'Kharanos'], [1426, 49.6, 48.6, 'Kharanos'], [1426, 42.2, 35.7, 'Shimmer Ridge'], [1426, 46.9, 52.3, 'Kharanos']] },
		],
	},
	{
		// A friend on another WoW account (own install), playing alongside Aldric a few yards off his path.
		account: 'DASHFRIEND', name: 'Corwyn', realm: 'Dashrealm', id: 'acorwyn003', race: 'NightElf', cls: 'DRUID', faction: 'Alliance', sex: 2, level: 5,
		sessions: null,
	},
];
const friend = CHARS[2];
friend.sessions = CHARS[0].sessions.map((s) => ({ hour: s.hour, legs: s.legs.map(([m, x, y, sub]) => [m, x + 0.6, y + 0.5, sub]) }));

const QUESTS = [
	[783, 'A Threat Within'], [7, 'Kobold Camp Cleanup'], [5261, 'Eagan Peltskinner'], [33, 'Wolves Across the Border'],
	[18, 'Brotherhood of Thieves'], [3903, 'Milly Osworth'], [62, 'The Fargodeep Mine'], [47, 'Gold Dust Exchange'],
	[106, 'Young Lovers'], [12, 'The People\'s Militia'], [9, 'The Killing Fields'], [22, 'Goretusk Liver Pie'],
	[179, 'Dwarven Outfitters'], [233, 'Coldridge Valley Mail Delivery'], [170, 'A New Threat'], [3364, 'Scalding Mornbrew Delivery'],
	[384, 'Beer Basted Boar Ribs'], [313, 'The Grizzled Den'], [412, 'Operation Recombobulation'],
];

const firstDay = Date.UTC(2026, 10, 2) / 86400000;
const yesterday = firstDay + days - 1;
// Polestar_DashSnapshot's PolestarDashSnapshotDB (overlay/addons/Polestar_DashSnapshot/Snapshot.lua, schema 1)
// for the characters with a kit: real item ids of the Forever client (Item/ItemSparse).
CHARS[0].kit = {
	equip: { 4: 2575, 5: 250488, 7: 2303, 8: 250482, 9: 3323, 10: 250508, 15: 3322, 16: 935, 17: 257255, 18: 4763 },
	bags: { 0: [16, { 1: '6948:1', 2: '159:5', 3: '117:4', 5: '2589:12', 6: '4865:3' }], 1: [6, { 1: '2770:8' }, 4496] },
	bank: { '-1': [24, { 1: '2589:20', 4: '2770:14' }] },
	money: 1234,
};
CHARS[2].kit = {
	equip: { 5: 250489, 7: 281267, 16: 9513 },
	bags: { 0: [16, { 1: '6948:1', 2: '159:10' }] },
	money: 87,
};
function snapshotOf(ch) {
	const at = (firstDay + days) * 86400 - 3600;
	const bags = (b) => Object.fromEntries(Object.entries(b).map(([k, [size, slots, item]]) => [k, item ? { size, item, slots } : { size, slots }]));
	const d = { schema: 1, name: ch.name, realm: ch.realm, money: ch.kit.money, moneyAt: at, bags: bags(ch.kit.bags), bagsAt: at, equipAt: at, equip: {} };
	for (const [slot, id] of Object.entries(ch.kit.equip)) d.equip[slot] = `item:${id}:0:0:0:0:0:0:0:${ch.level}:::::`;
	if (ch.kit.bank) Object.assign(d, { bank: bags(ch.kit.bank), bankAt: at - 7200 });
	return d;
}
// A JS value as a Lua literal (SavedVariables style; numeric keys stay numeric).
function luaOf(v, ind = '') {
	if (typeof v === 'string') return esc(v);
	if (typeof v !== 'object') return String(v);
	const inner = ind + '\t';
	const key = (k) => (/^-?\d+$/.test(k) ? `[${k}]` : `[${esc(k)}]`);
	return `{\n${Object.entries(v).map(([k, x]) => `${inner}${key(k)} = ${luaOf(x, inner)},`).join('\n')}\n${ind}}`;
}

// One Recorder install per WoW account folder.
const ACCOUNTS = { DASHTEST: { install: 'd4shtest0001', chunks: {}, mapsSeen: {}, seq: 0 }, DASHFRIEND: { install: 'd4shfr1end02', chunks: {}, mapsSeen: {}, seq: 0 } };
const accountOf = (ch) => ACCOUNTS[ch.account || 'DASHTEST'];

function world(map, x, y) {
	const [, , , top, left, bottom, right] = MAPS[map];
	return [top + ((bottom - top) * y) / 100, left + ((right - left) * x) / 100];
}

function simulate(ch, sess, day, sIdx) {
	const R = rng(day * 1000 + sIdx * 17 + ch.id.charCodeAt(0));
	let t = (day * 86400) + sess.hour * 3600 + Math.floor(R() * 900);
	let level = ch.level;
	let xp = Math.floor(R() * 300);
	const xpMax = () => 400 + level * 180;
	const records = []; // [t, kind, ...fields]
	const P = (m, x, y) => [m, Math.round(x * 100), Math.round(y * 100)];
	const quests = [];
	let qi = (day * 3 + sIdx * 5 + ch.id.charCodeAt(1)) % QUESTS.length;
	let cur = [sess.legs[0][0], sess.legs[0][1], sess.legs[0][2]];
	let zone = '';
	let subzone = null;
	const enterZone = (m, sub) => {
		if (ZONES[m] !== zone || sub !== subzone) {
			zone = ZONES[m];
			subzone = sub;
			records.push([t, 'zone', ...P(...cur), zone, sub]);
		}
	};
	records.push([t, 'group', ch.id === 'a1dr1c0001' || ch === friend ? 1 : 0, 0]);
	records.push([t, 'xp', xp, xpMax(), 0]);
	enterZone(cur[0], sess.legs[0][3]);
	const gain = (n) => {
		xp += n;
		if (xp >= xpMax()) {
			xp -= xpMax();
			level += 1;
			records.push([t, 'level', level, ...P(...cur), 3600 * (level + 2)]);
			records.push([t, 'xp', xp, xpMax(), 0]);
		}
	};
	let died = false;
	for (let leg = 1; leg < sess.legs.length; leg++) {
		const [m, tx, ty, sub] = sess.legs[leg];
		// Walk there (a change of map jumps across the zone border at the leg's midpoint).
		const [wx0, wy0] = world(...cur);
		const [wx1, wy1] = world(m, tx, ty);
		const dist = Math.hypot(wx1 - wx0, wy1 - wy0);
		const steps = Math.max(2, Math.round(dist / 22));
		for (let s = 1; s <= steps; s++) {
			const f = s / steps;
			const jitter = () => (R() - 0.5) * 0.25;
			const wx = wx0 + (wx1 - wx0) * f;
			const wy = wy0 + (wy1 - wy0) * f;
			// Back to map % on whichever map holds the point.
			const onMap = f < 0.5 ? cur[0] : m;
			const [, , , top, left, bottom, right] = MAPS[onMap];
			const x = Math.min(100, Math.max(0, ((wy - left) / (right - left)) * 100 + jitter()));
			const y = Math.min(100, Math.max(0, ((wx - top) / (bottom - top)) * 100 + jitter()));
			t += 3 + Math.round(R() * 1.5 * 10) / 10;
			const prevMap = cur[0];
			cur = [onMap, x, y];
			if (onMap !== prevMap) enterZone(onMap, '');
			const ghost = died ? 32 : 0;
			records.push([t, 'pos', ...P(...cur), ghost, 70 + Math.round(R() * 6)]);
		}
		cur = [m, tx, ty];
		enterZone(m, sub);
		if (died) {
			records.push([t, 'revive', ...P(...cur), 'c']);
			died = false;
		}
		// At each stop: quests, some fighting.
		if (leg % 2 === 1) {
			const [q, title] = QUESTS[qi++ % QUESTS.length];
			records.push([t, 'detail', q, 'c', 190 + q, ...P(...cur), '']);
			records.push([t, 'text', q, title, `Objective text of ${title}.`, `The quest giver tells you about ${title}.`]);
			records.push([t + 2, 'accept', q, 'c', 190 + q, ...P(...cur), level, 250 + level * 40, 25 * level, '', '']);
			records.push([t + 2, 'objectives', q, `monster:8:Kobold Vermin slain`]);
			quests.push(q);
			t += 5;
		}
		const fights = 2 + Math.floor(R() * 4);
		records.push([t, 'combat', 1, ...P(...cur)]);
		for (let k = 0; k < fights; k++) {
			t += 12 + Math.round(R() * 20);
			const npc = 6 + Math.floor(R() * 4);
			const kx = 50 + level * 9;
			const q = quests[quests.length - 1];
			records.push([t, 'kill', npc, level - 1 + Math.floor(R() * 2), 'n', ...P(...cur), kx, 0, 0, q ? `${q}:1` : '']);
			if (q) records.push([t, 'progress', q, 1, Math.min(8, k + 1), 8, ...P(...cur)]);
			if (R() < 0.35) records.push([t + 1, 'loot', 'c', npc, ...P(...cur), '', `${2589 + k}:1`, q ? `${q}:1` : '']);
			gain(kx);
		}
		records.push([t, 'combat', 0, ...P(...cur)]);
		if (leg % 2 === 0 && quests.length) {
			const q = quests.shift();
			records.push([t, 'complete', q]);
			t += 30;
			records.push([t, 'turnin', q, 'c', 190 + q, ...P(...cur), level, 300 + level * 40, 25 * level, '']);
			gain(300 + level * 40);
		}
		if (R() < 0.15 && !died && leg < sess.legs.length - 1) {
			records.push([t, 'death', ...P(...cur), 99, level + 2]);
			died = true;
		}
		if (leg === 3) records.push([t, 'mark', ...P(...cur), `checkpoint on day ${day - firstDay + 1}`]);
		if (R() < 0.3) records.push([t, 'explore', 80 + leg, 20 * level, ...P(...cur)]);
		if (R() < 0.25) {
			records.push([t, 'rest', 'f', 18]);
			t += 20;
		}
	}
	records.push([t, 'xp', xp, xpMax(), 0]);
	ch.level = level;
	records.sort((a, b) => a[0] - b[0]); // stable: same-time records keep their order
	return records;
}

function writeChunks(ch, records) {
	// A chunk closes after 5 minutes or ~16 KiB.
	let i = 0;
	while (i < records.length) {
		const epoch = Math.floor(records[i][0]);
		const A = accountOf(ch);
		const seq = ++A.seq;
		const mapsSeen = A.mapsSeen;
		const lines = [['chunk', 0, seq, epoch, ch.id].join('\t')];
		const sessLine = (lvl) => ['session', 0, ch.id, ch.race, ch.cls, ch.faction, ch.sex, lvl, 'enUS', 70532, 16001, 1, '', '1.60.1', '0.3.2', 'polestar-core:0.3.2;guide:human-1-12'].join('\t');
		let lvl = ch.levelAt?.(epoch) ?? ch.level;
		lines.push(sessLine(lvl));
		let bytes = lines.join('\n').length;
		for (; i < records.length; i++) {
			const [t, kind, ...fields] = records[i];
			if (t - epoch > 300 || bytes > 16000) break;
			const map = kind === 'pos' || kind === 'zone' ? fields[0] : null;
			if (map && !mapsSeen[map]) {
				mapsSeen[map] = [map, ...MAPS[map]].join('\t');
				lines.push(['map', Math.round((t - epoch) * 10), mapsSeen[map]].join('\t'));
			}
			const line = [kind, Math.round((t - epoch) * 10), ...fields].join('\t');
			lines.push(line);
			bytes += line.length + 1;
		}
		A.chunks[seq] = lines.join('\n');
	}
}

for (let day = firstDay; day <= yesterday; day++) {
	CHARS.forEach((ch, ci) => {
		ch.sessions.forEach((sess, si) => {
			const start = ch.level;
			const recs = simulate(ch, sess, day, si + (ch === friend ? 0 : ci) * 7);
			let lvl = start;
			const levels = recs.filter((r) => r[1] === 'level').map((r) => [r[0], r[2]]);
			ch.levelAt = (t) => {
				lvl = start;
				for (const [lt, l] of levels) if (lt <= t) lvl = l;
				return lvl;
			};
			writeChunks(ch, recs);
		});
	});
}
// Chunks are seq-ordered by write time; interleaved characters keep their own clock.

const esc = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';
for (const [name, A] of Object.entries(ACCOUNTS)) {
	const acct = path.join(out, 'WTF', 'Account', name);
	fs.mkdirSync(path.join(acct, 'SavedVariables'), { recursive: true });
	let lua = '\nPolestarRecorderDB = {\n\t["schema"] = 2,\n\t["enabled"] = true,\n';
	lua += `\t["install"] = ${esc(A.install)},\n\t["seq"] = ${A.seq},\n\t["acked"] = 0,\n\t["chunks"] = {\n`;
	for (const [k, v] of Object.entries(A.chunks)) lua += `\t\t[${k}] = ${esc(v)},\n`;
	lua += '\t},\n\t["maps"] = {\n';
	for (const [k, v] of Object.entries(A.mapsSeen)) lua += `\t\t[${k}] = ${esc(v)},\n`;
	lua += '\t},\n}\n';
	fs.writeFileSync(path.join(acct, 'SavedVariables', 'Polestar_Recorder.lua'), lua);
	for (const ch of CHARS.filter((c) => accountOf(c) === A)) {
		const dir = path.join(acct, ch.realm, ch.name, 'SavedVariables');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, 'Polestar_Recorder.lua'), `\nPolestarRecorderCharDB = {\n\t["id"] = ${esc(ch.id)},\n\t["textSeen"] = {\n\t},\n}\n`);
		if (ch.kit) fs.writeFileSync(path.join(dir, 'Polestar_DashSnapshot.lua'), `\nPolestarDashSnapshotDB = ${luaOf(snapshotOf(ch))}\n`);
	}
	console.log(`${name}: ${A.seq} chunks, ${days} day(s), install ${A.install}`);
}
