// Forever Dash: characters, a live map and the play journal.
//
// Map modes:
// - overview: every character, the last N hours of *playtime* each (a coarse trail, milestones as
//   dots, a labelled pin per character). The buffer bounds what the page loads; the database keeps
//   everything for the journal.
// - focus: one character in full detail (fine trail, the Polestar arrow, journal events as pins),
//   the others as faint pins. Its buffer defaults to the last session and can grow to all play.
// The scrubber runs over playtime: gaps when no shown character played take no space.
// MapView is Polestar's planner map, served from this fork at /planner.
import { MapView } from '/planner/map/mapview.js';

const $ = (s) => document.querySelector(s);
const api = async (path, opts) => {
	const r = await fetch(path, opts);
	if (!r.ok) throw new Error(`${path}: ${r.status}`);
	return r.json();
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const hhmm = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const day = (t) => new Date(t * 1000).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
const ago = (t) => {
	const s = Date.now() / 1000 - t;
	if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
	if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
	return `${Math.round(s / 86400)} days ago`;
};
const cap = (s) => (s ? s[0] + s.slice(1).toLowerCase() : '');
const RACE = { Scourge: 'Undead', NightElf: 'Night Elf' };
const DOT_TINT = { death: 'danger', level: 'success', mark: 'accent', enter: 'dungeon', encounter: 'dungeon' };
const PIN = {
	level: ['icon-level', 'success'], death: ['cross', 'danger'], mark: ['icon-note', 'accent'], accept: ['icon-accept', 'quest'],
	turnin: ['icon-turnin', 'quest'], explore: ['icon-explore', 'place'], enter: ['icon-dungeon', 'dungeon'], encounter: ['icon-dungeon', 'dungeon'],
	taxi: ['icon-fly', 'npc'], bind: ['icon-hearth', 'npc'], learn: ['icon-learn', 'spell'], rare: ['icon-kill', 'rare'], abandon: ['cross', 'textDim'],
};
const FOCUS_KINDS = Object.keys(PIN).join(',');
const OVERVIEW_BUFFERS = [[1, 'Last 1 h of play'], [6, 'Last 6 h of play'], [24, 'Last 24 h of play'], [72, 'Last 72 h of play']];
const FOCUS_BUFFERS = [['session', 'Last session'], ['2', 'Last 2 h of play'], ['6', 'Last 6 h of play'], ['24', 'Last 24 h of play'], ['all', 'All play']];

const S = { chars: [], mode: 'overview', ov: null, focus: null, tl: null, t: 0, playing: false, map: null, journalFor: null };

// ---- playtime timeline ----------------------------------------------------

// Intervals [[a, b]] merged; the slider's 0..1 maps onto their total length, skipping the gaps.
class Timeline {
	constructor(intervals) {
		const iv = intervals.filter(([a, b]) => b >= a).map(([a, b]) => [a, b]).sort((x, y) => x[0] - y[0]);
		this.iv = [];
		for (const [a, b] of iv) {
			const last = this.iv[this.iv.length - 1];
			if (last && a <= last[1] + 60) last[1] = Math.max(last[1], b);
			else this.iv.push([a, b]);
		}
		this.total = this.iv.reduce((n, [a, b]) => n + (b - a), 0) || 1;
		this.start = this.iv[0]?.[0] ?? 0;
		this.end = this.iv[this.iv.length - 1]?.[1] ?? 0;
	}
	toT(u) {
		let left = Math.max(0, Math.min(1, u)) * this.total;
		for (const [a, b] of this.iv) {
			if (left <= b - a) return a + left;
			left -= b - a;
		}
		return this.end;
	}
	toU(t) {
		let n = 0;
		for (const [a, b] of this.iv) {
			if (t <= b) return (n + Math.max(0, t - a)) / this.total;
			n += b - a;
		}
		return 1;
	}
	// Where each later interval starts, as slider fractions (the session boundaries).
	ticks() {
		let n = 0;
		return this.iv.map(([a, b]) => ((n += b - a), (n - (b - a)) / this.total)).slice(1);
	}
	// The next playtime moment after t, dt seconds of play on.
	advance(t, dt) {
		return this.toT(this.toU(t) + dt / this.total);
	}
}

// Where the last `hours` of playtime begin in a character's sessions.
function playtimeFrom(sessions, hours) {
	let left = hours * 3600;
	for (let i = sessions.length - 1; i >= 0; i--) {
		const [a, b] = sessions[i];
		if (b - a >= left) return b - left;
		left -= b - a;
	}
	return sessions[0]?.[0] ?? 0;
}

const inSessions = (sessions, t) => sessions.some(([a, b]) => t >= a - 60 && t <= b + 60);

// ---- trails ---------------------------------------------------------------

const prep = (segs) => segs.map((s) => ({ ...s, f32: Float32Array.from(s.pts) }));

// Heading on screen (radians clockwise from north) of the step into point i (world x north, y west).
function dirOf(p, i) {
	if (i < 1) return 0;
	return Math.atan2(-(p[2 * i + 1] - p[2 * i - 1]), p[2 * i] - p[2 * i - 2]);
}

// The trail split at t into past and future routes.
function split(segs, t, routes) {
	for (const s of segs) {
		const mode = s.ghost ? 'fly' : 'walk';
		const ts = s.ts;
		if (t >= ts[ts.length - 1]) routes.push({ c: s.c, pts: s.f32, mode, state: 'past' });
		else if (t <= ts[0]) routes.push({ c: s.c, pts: s.f32, mode, state: 'future' });
		else {
			const p = posIn(s, t);
			const k = p.k;
			routes.push({ c: s.c, pts: Float32Array.from([...s.pts.slice(0, 2 * k + 2), p.wx, p.wy]), mode, state: 'past' });
			routes.push({ c: s.c, pts: Float32Array.from([p.wx, p.wy, ...s.pts.slice(2 * k + 2)]), mode, state: 'future' });
		}
	}
	return routes;
}

function posIn(s, t) {
	const ts = s.ts;
	let lo = 0, hi = ts.length - 1;
	while (lo < hi - 1) {
		const mid = (lo + hi) >> 1;
		if (ts[mid] <= t) lo = mid;
		else hi = mid;
	}
	const k = lo;
	const f = Math.max(0, Math.min(1, (t - ts[k]) / (ts[k + 1] - ts[k] || 1)));
	return { k, c: s.c, wx: s.pts[2 * k] + (s.pts[2 * k + 2] - s.pts[2 * k]) * f, wy: s.pts[2 * k + 1] + (s.pts[2 * k + 3] - s.pts[2 * k + 1]) * f, heading: dirOf(s.pts, k + 1) };
}

// The character at t: inside a segment, interpolated; else where it last was before t.
function posAt(segs, t) {
	let best = null;
	for (const s of segs) {
		const ts = s.ts;
		if (ts.length < 1 || ts[0] > t) continue;
		if (t <= ts[ts.length - 1] && ts.length > 1) return posIn(s, t);
		const n = ts.length - 1;
		if (!best || ts[n] > best.t) best = { t: ts[n], c: s.c, wx: s.pts[2 * n], wy: s.pts[2 * n + 1], heading: dirOf(s.pts, n) };
	}
	return best;
}

// ---- map ------------------------------------------------------------------

async function initMap() {
	try {
		S.map = await new MapView($('#d-canvas'), { artBase: '/art' }).init();
		S.map.on('marker', ({ marker }) => {
			if (marker.kind === 'char') focus(marker.charId);
			if (marker.kind === 'event') showInfo(marker.ev);
		});
		S.map.on('pick', ({ hit }) => {
			if (!hit) $('#d-info').hidden = true;
		});
	} catch (e) {
		$('#d-nomap').hidden = false;
		console.warn(e);
	}
}

const charName = (id) => S.chars.find((c) => c.id === id)?.name || id;

function draw() {
	if (!S.map) return;
	const t = S.t;
	const live = S.tl && t >= S.tl.end - 1;
	const routes = [];
	const markers = [];
	const dots = [];
	let arrow = null;
	if (S.mode === 'overview' && S.ov) {
		for (const c of S.ov.characters) {
			split(c.segs, t, routes);
			const p = posAt(c.segs, t);
			const online = inSessions(c.sessions, t);
			if (p) markers.push({ kind: 'char', charId: c.char, step: c.char, c: p.c, wx: p.wx, wy: p.wy, icon: null, glyph: 'character', tint: online ? 'npc' : 'textMuted', label: charName(c.char), active: online || live, done: !online && !live });
			for (const e of c.events) if (e.t <= t && e.pos?.c !== undefined) dots.push({ c: e.pos.c, wx: e.pos.wx, wy: e.pos.wy, tint: DOT_TINT[e.kind] || 'textDim' });
		}
	} else if (S.mode === 'focus' && S.focus) {
		split(S.focus.segs, t, routes);
		arrow = posAt(S.focus.segs, t);
		for (const c of S.ov?.characters || []) {
			if (c.char === S.focus.id) continue;
			const p = posAt(c.segs, t);
			if (p) markers.push({ kind: 'char', charId: c.char, step: c.char, c: p.c, wx: p.wx, wy: p.wy, icon: null, glyph: 'character', tint: 'textMuted', label: charName(c.char), done: true });
		}
		for (const e of S.focus.events) {
			if (e.t > t || e.pos?.c === undefined) continue;
			const [glyph, tint] = PIN[e.kind] || ['icon-note', 'textDim'];
			markers.push({ kind: 'event', ev: e, step: `${e.kind}:${e.t}`, c: e.pos.c, wx: e.pos.wx, wy: e.pos.wy, icon: null, glyph, tint });
		}
	}
	S.map.setRoute(routes);
	S.map.setScene({ markers, dots });
	S.map.setCharacter(arrow ? { c: arrow.c, wx: arrow.wx, wy: arrow.wy, heading: arrow.heading } : null);
	const offline = S.mode === 'focus' && S.focus && !inSessions(S.focus.sessions, t);
	$('#d-clock').textContent = t ? `${day(t)} ${hhmm(t)}${live ? ' · latest' : offline ? ' · offline' : ''}` : '';
	$('#d-time').value = S.tl ? Math.round(S.tl.toU(t) * 1000) : 1000;
}

function fit() {
	if (!S.map) return;
	const segs = S.mode === 'focus' ? S.focus?.segs || [] : (S.ov?.characters || []).flatMap((c) => c.segs);
	// The continent with the most trail on it.
	const by = new Map();
	for (const s of segs) by.set(s.c, (by.get(s.c) || 0) + s.ts.length);
	const c = [...by.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
	if (c === undefined) return;
	const pairs = [];
	for (const s of segs) if (s.c === c) for (let i = 0; i < s.pts.length; i += 2) pairs.push([s.pts[i], s.pts[i + 1]]);
	S.map.setContinent(c);
	S.map.fitWorld(c, pairs, { padding: 90, maxZoom: 1.2 });
}

function setTimeline(intervals) {
	S.tl = new Timeline(intervals);
	S.t = S.tl.end;
	$('#d-ticks').innerHTML = S.tl.ticks().map((u) => `<b style="left:${(u * 100).toFixed(2)}%"></b>`).join('');
}

function showInfo(e) {
	const el = $('#d-info');
	el.hidden = false;
	el.innerHTML = `<time>${esc(day(e.t))} ${hhmm(e.t)} · ${esc(charName(e.char))}</time>${esc(e.text)}`;
}

// ---- modes ----------------------------------------------------------------

function fillBuffers(options, value) {
	$('#d-buffer').innerHTML = options.map(([v, label]) => `<option value="${v}">${esc(label)}</option>`).join('');
	$('#d-buffer').value = String(value);
}

async function loadOverview(hours) {
	const ov = await api(`/api/overview?hours=${hours}&tol=8`);
	for (const c of ov.characters) c.segs = prep(c.segments);
	S.ov = ov;
	return ov;
}

async function overview(hours = 6) {
	play(false);
	S.mode = 'overview';
	S.focus = null;
	$('#d-info').hidden = true;
	fillBuffers(OVERVIEW_BUFFERS, hours);
	await loadOverview(hours);
	setTimeline(S.ov.characters.flatMap((c) => c.sessions));
	legend();
	renderChars();
	$('#d-who').textContent = `All characters · last ${hours} h of play each`;
	draw();
	fit();
	if ($('#d-journal').classList.contains('on')) renderJournal();
}

// buffer: 'session' | hours as a string | 'all' | 's:<start>:<end>' (one session, from the journal)
async function focus(id, buffer = 'session') {
	play(false);
	S.mode = 'focus';
	$('#d-info').hidden = true;
	if (!S.ov) await loadOverview(6);
	const sessions = await api(`/api/sessions?char=${id}`);
	let from, to;
	const last = sessions[sessions.length - 1] || [0, 0];
	if (buffer === 'session') [from, to] = last;
	else if (buffer === 'all') [from, to] = [sessions[0]?.[0] ?? 0, last[1]];
	else if (buffer.startsWith('s:')) [from, to] = buffer.slice(2).split(':').map(Number);
	else [from, to] = [playtimeFrom(sessions, Number(buffer)), last[1]];
	const [trail, events] = await Promise.all([
		api(`/api/trail?char=${id}&from=${from}&to=${to}&tol=1.5`),
		api(`/api/events?char=${id}&from=${from}&to=${to}&kinds=${FOCUS_KINDS}`),
	]);
	S.focus = { id, sessions, from, to, segs: prep(trail.segments), events };
	const opts = [...FOCUS_BUFFERS];
	if (buffer.startsWith('s:')) opts.unshift([buffer, `Session ${day(from)} ${hhmm(from)}`]);
	fillBuffers(opts, buffer);
	setTimeline(sessions.filter(([a, b]) => b >= from && a <= to).map(([a, b]) => [Math.max(a, from), Math.min(b, to)]));
	legend();
	renderChars();
	const ch = S.chars.find((c) => c.id === id);
	$('#d-who').textContent = ch ? `${ch.name}-${ch.realm} · level ${ch.level} · ${trail.kept} of ${trail.points} points` : id;
	draw();
	fit();
	if ($('#d-journal').classList.contains('on')) renderJournal();
}

function legend() {
	const items = [['sw route', 'trail'], ['sw ghost', 'ghost run']];
	if (S.mode === 'overview') items.push(['dot success', 'level'], ['dot danger', 'death'], ['dot accent', 'mark']);
	else items.push(['dot quest', 'events: click a pin']);
	$('#d-legend').innerHTML = items.map(([cls, text]) => `<span><b class="${cls}"></b>${esc(text)}</span>`).join('');
}

// ---- playback -------------------------------------------------------------

let last = 0;
function tick(now) {
	if (!S.playing) return;
	const dt = last ? (now - last) / 1000 : 0;
	last = now;
	S.t = S.tl.advance(S.t, dt * Number($('#d-speed').value));
	draw();
	if (S.t >= S.tl.end) return play(false);
	requestAnimationFrame(tick);
}

function play(on) {
	S.playing = on;
	$('#d-play img').src = on ? '/glyph/pause.png' : '/glyph/play.png';
	if (on && S.tl) {
		if (S.t >= S.tl.end) S.t = S.tl.start;
		last = 0;
		requestAnimationFrame(tick);
	}
}

// ---- journal --------------------------------------------------------------

async function renderJournal() {
	const el = $('#d-journal');
	if (S.mode !== 'focus') {
		el.innerHTML = '<p class="j-empty">Pick a character to read its journal.</p>';
		return;
	}
	const id = S.focus.id;
	const journal = await api(`/api/journal?char=${id}`);
	S.journal = journal;
	if (!journal.length) {
		el.innerHTML = '<p class="j-empty">Nothing recorded for this character yet.</p>';
		return;
	}
	el.innerHTML = journal
		.map((s, i) => {
			const mins = Math.round(s.seconds / 60);
			const lv = s.levels.length ? `<span>level <b>${s.levels[0] - 1} → ${s.levels[s.levels.length - 1]}</b></span>` : '';
			const items = [...s.events, ...s.notes.map((n) => ({ t: n.t, kind: 'note', text: n.text }))].sort((a, b) => a.t - b.t);
			const key = `s:${s.start}:${s.end}`;
			return `<article class="j-sess">
				<div class="j-head"><h3>${esc(day(s.start))}</h3><span class="when">${hhmm(s.start)}–${hhmm(s.end)} · ${mins} min · ${esc(s.zones.join(', '))}</span>
				<button class="map" data-replay="${key}">Replay on map</button></div>
				<div class="j-facts">${lv}<span><b>${s.quests}</b> quests</span><span><b>${s.kills}</b> kills</span><span><b>${s.deaths}</b> deaths</span><span><b>${(s.yards / 1000).toFixed(1)}k</b> yd walked</span></div>
				<ul class="j-events">${items.map((e) => `<li class="k-${e.kind}" data-t="${e.t}" data-replay="${key}"><time>${hhmm(e.t)}</time><b class="ji"></b><span>${esc(e.text)}</span></li>`).join('')}</ul>
				<form class="j-note" data-i="${i}"><input name="text" placeholder="Add a note to this session…" maxlength="4000"><button>Add</button></form>
			</article>`;
		})
		.join('');
}

async function addNote(form) {
	const s = S.journal[Number(form.dataset.i)];
	const text = form.text.value.trim();
	if (!text) return;
	await api('/api/notes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ char: S.focus.id, t: s.end, text }) });
	await renderJournal();
}

// ---- characters -----------------------------------------------------------

function renderChars() {
	const all = `<li data-id="" class="all ${S.mode === 'overview' ? 'on' : ''}"><span class="n">All characters</span></li>`;
	$('#d-chars').innerHTML = all + S.chars
		.map((c) => {
			const p = c.lastPos;
			const where = p?.zone ? `${p.zone}${p.subzone ? ` · ${p.subzone}` : ''}` : '';
			const on = S.mode === 'focus' && S.focus?.id === c.id;
			return `<li data-id="${c.id}" class="${on ? 'on' : ''}">
				<span class="n">${esc(c.name || c.id)}</span><span class="lv">${c.level ?? '?'}</span>
				<span class="sub">${esc(RACE[c.race] || c.race || '')} ${esc(cap(c.class))}${c.realm ? ` · ${esc(c.realm)}` : ''}</span>
				<span class="seen">${esc(where)}${c.last ? ` · ${ago(c.last)}` : ''}</span></li>`;
		})
		.join('');
}

function tab(name) {
	for (const b of document.querySelectorAll('#d-tabs button')) b.classList.toggle('on', b.dataset.tab === name);
	$('#d-map').classList.toggle('on', name === 'map');
	$('#d-journal').classList.toggle('on', name === 'journal');
	if (name === 'map') S.map?.resize();
	if (name === 'journal') renderJournal();
}

async function main() {
	await initMap();
	const [chars, stats] = await Promise.all([api('/api/characters'), api('/api/stats')]);
	S.chars = chars;
	$('#d-stats').textContent = `${stats.chunks} chunks · ${stats.positions} positions · ${stats.events} events (all kept)`;
	$('#d-chars').addEventListener('click', (e) => {
		const li = e.target.closest('li');
		if (!li) return;
		(li.dataset.id ? focus(li.dataset.id) : overview()).then(() => tab('map'));
	});
	document.querySelectorAll('#d-tabs button').forEach((b) => b.addEventListener('click', () => tab(b.dataset.tab)));
	$('#d-buffer').addEventListener('change', (e) => (S.mode === 'overview' ? overview(Number(e.target.value)) : focus(S.focus.id, e.target.value)));
	$('#d-time').addEventListener('input', () => {
		play(false);
		S.t = S.tl.toT(Number($('#d-time').value) / 1000);
		draw();
	});
	$('#d-play').addEventListener('click', () => play(!S.playing));
	$('#d-journal').addEventListener('click', async (e) => {
		const el = e.target.closest('[data-replay]');
		if (!el) return;
		await focus(S.focus.id, el.dataset.replay);
		if (el.dataset.t) {
			S.t = Number(el.dataset.t);
			draw();
		}
		tab('map');
	});
	$('#d-journal').addEventListener('submit', (e) => {
		e.preventDefault();
		addNote(e.target);
	});
	await overview(6);
	window.__dash = S; // for poking at in the console
}

main().catch((e) => {
	console.error(e);
	document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;bottom:0;left:0;color:var(--danger)">${esc(e.message)}</pre>`);
});
