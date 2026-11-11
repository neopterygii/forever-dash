<script lang="ts">
	// The journal, as a panel that drops down over the map: one character's sessions when one is
	// selected, every character's together when none is, the same in both: sessions newest first,
	// a page at a time, their facts, events and notes. Clicking a session or an event replays it
	// on the map behind, with the panel left open; the session on the map is highlighted. A quest
	// line plays Spoken's narration of that moment and opens the quest's card.
	import { untrack } from 'svelte';
	import { api, type DashEvent, type Pos, type Session } from '../lib/api';
	import { dash } from '../lib/dash.svelte';
	import { day, hhmm } from '../lib/format';
	import NarrationButton from './NarrationButton.svelte';
	import QuestCard from './QuestCard.svelte';

	const PAGE = 10;

	const visible = $derived(dash.journalOpen);
	/** The selected character, or undefined for everyone. */
	const id = $derived(dash.mode === 'focus' ? dash.focus?.id : undefined);
	const scope = $derived(id ?? '*');

	let sessions = $state.raw<Session[] | null>(null);
	let more = $state(false);
	let loadingOlder = $state(false);
	let reload = $state(0);
	/** The quest card open, as `<char>:<time>:<quest id>` of its line. */
	let openQuest = $state<string | null>(null);
	let drafts = $state<Record<string, string>>({});
	/** The session whose diary entry is being edited, and its text. */
	let editing = $state<string | null>(null);
	let editText = $state('');
	/** Sessions whose log is open (the diary entry is shown, the log folded, by default). */
	let logOpen = $state<Record<string, boolean>>({});
	/** Words to look for through the whole journal (as typed, and as asked of the server a moment later). */
	let findText = $state('');
	let find = $state('');
	/** A day to jump to (yyyy-mm-dd): the journal starts at that day's last session. */
	let jump = $state('');
	/** The end of the day jumped to (epoch seconds), or undefined for the newest. */
	const until = $derived(jump ? new Date(`${jump}T23:59:59`).getTime() / 1000 + 1 : undefined);
	/** The note being edited (its id), and its text. */
	let noteEditing = $state<number | null>(null);
	let noteText = $state('');

	$effect(() => {
		const text = findText;
		const timer = setTimeout(() => (find = text.trim()), 300);
		return () => clearTimeout(timer);
	});

	// The first page, or as many sessions as are shown when only reloading (a note was added).
	let shownFor: string | undefined;
	$effect(() => {
		reload;
		dash.version; // newer play was uploaded
		if (!visible) return;
		const forScope = `${scope}\n${find}\n${until ?? ''}`;
		const words = find, upTo = until;
		// Read without subscribing: this effect writes `sessions`.
		const keep = shownFor === forScope ? Math.max(PAGE, untrack(() => sessions?.length ?? 0)) : PAGE;
		if (shownFor !== forScope) {
			sessions = null;
			openQuest = null;
		}
		shownFor = forScope;
		let stale = false;
		api.journal(id, undefined, keep, words, upTo).then((p) => {
			if (stale) return;
			sessions = p.sessions;
			more = p.more;
		});
		return () => (stale = true);
	});

	async function loadOlder() {
		if (!sessions?.length || loadingOlder) return;
		loadingOlder = true;
		try {
			const p = await api.journal(id, sessions[sessions.length - 1], PAGE, find);
			sessions = [...sessions, ...p.sessions];
			more = p.more;
		} finally {
			loadingOlder = false;
		}
	}

	type Item = { t: number; kind: string; text: string; pos?: Pos | null; quest?: DashEvent['quest']; how?: string; person?: string; note?: number };
	const qkey = (s: Session, e: Item) => `${s.char}:${e.t}:${e.quest?.id}`;
	const toggleQuest = (s: Session, e: Item) => (openQuest = openQuest === qkey(s, e) ? null : qkey(s, e));
	const items = (s: Session): Item[] => [...s.events, ...s.notes.map((n) => ({ t: n.t, kind: 'note', text: n.text, note: n.id }))].sort((a, b) => b.t - a.t); // newest first, as the sessions
	const key = (s: Session) => `s:${s.start}:${s.end}`;
	/** Gathering counts in the facts row: (key, one, many). */
	const GATHER = [['herb', 'herb', 'herbs'], ['ore', 'vein', 'veins'], ['skin', 'skinned', 'skinned'], ['fish', 'fish', 'fish'], ['lock', 'lock', 'locks']] as const;
	const groupTitle = (g: NonNullable<Session['group']>) => (g.raid ? `Raid of up to ${g.raid}` : `Party of up to ${g.party + 1}`);
	const draftKey = (s: Session) => `${s.char}:${s.start}`;
	/** One character's journal: a chapter card heads each run of sessions in one zone (newest first,
	 *  so above the chapter's newest session shown). */
	const chapterHere = (i: number) => {
		const c = sessions?.[i]?.chapter;
		return id && c && sessions?.[i - 1]?.chapter?.n !== c.n ? c : null;
	};
	function playtime(seconds: number): string {
		const m = Math.round(seconds / 60);
		return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
	}
	function levels(c: NonNullable<Session['chapter']>): string | null {
		if (c.levelFrom == null || c.levelTo == null) return null;
		return c.levelTo > c.levelFrom ? `levels ${c.levelFrom}–${c.levelTo}` : `level ${c.levelTo}`;
	}

	/** The map goes to the event's spot (lib/dash `focusPoint`, MapPane zooms there). */
	function goTo(pos: Pos | null | undefined) {
		if (pos?.c !== undefined && pos.wx !== undefined && pos.wy !== undefined) dash.focusPoint = { c: pos.c, wx: pos.wx, wy: pos.wy };
	}

	/** Replays the session on the map (focusing its character), at the event when one is given.
	 *  With everyone shown, an event the overview's buffer already holds is shown there instead,
	 *  with every character at that moment. */
	async function replay(s: Session, e?: Item) {
		const ov = dash.mode === 'overview' ? dash.overview?.characters.find((c) => c.char === s.char) : undefined;
		if (e && ov && e.t >= ov.from && e.t <= ov.to) {
			dash.playing = false;
			dash.t = e.t;
			goTo(e.pos);
			return;
		}
		await dash.showFocus(s.char, key(s));
		if (e) {
			dash.t = e.t;
			goTo(e.pos);
		}
	}

	const sessionKey = (s: Session) => `${s.char}:${s.start}`;
	const SOURCE: Record<string, string> = { you: 'Your words', ai: 'Written from the log', template: 'From the log' };
	function sourceLabel(s: Session): string {
		// The gateway's `diary` model is Gemini.
		if (s.diary.source === 'ai') return `Written from the log by ${/gemini|^diary/i.test(s.diary.model ?? '') ? 'Gemini' : 'a model'}`;
		return SOURCE[s.diary.source] ?? '';
	}
	function startEdit(s: Session) {
		editing = sessionKey(s);
		editText = s.diary.text;
	}
	async function saveEdit(s: Session, text: string) {
		await api.setDiary(s.char, s.start, text);
		editing = null;
		reload++;
	}

	async function saveNote(id: number, text: string) {
		if (!text.trim()) return;
		await api.editNote(id, text);
		noteEditing = null;
		reload++;
	}
	async function deleteNote(id: number) {
		if (!confirm('Delete this note?')) return;
		await api.editNote(id, '');
		noteEditing = null;
		reload++;
	}

	async function addNote(s: Session) {
		const k = draftKey(s);
		const text = (drafts[k] ?? '').trim();
		if (!text) return;
		await api.addNote(s.char, s.end, text);
		drafts[k] = '';
		logOpen[sessionKey(s)] = true; // the note is a line of the log: show it
		reload++;
	}
</script>

<section class="journal" class:on={visible} aria-label="Journal">
	<header class="jh">
		<h2>Journal<small>{id ? dash.name(id) : 'all characters'}</small></h2>
		<button class="close" aria-label="Close the journal" onclick={() => (dash.journalOpen = false)}>×</button>
		<div class="find">
			<input type="search" placeholder="Search: a quest, a place, a note…" aria-label="Search the journal" bind:value={findText} />
			<input type="date" aria-label="Jump to a day" title="Jump to a day" bind:value={jump} />
			{#if findText || jump}<button class="clear" onclick={() => ((findText = ''), (find = ''), (jump = ''))}>Newest</button>{/if}
		</div>
	</header>
	{#if sessions && !sessions.length}
		<p class="empty">{find || jump ? `No session${find ? ` mentions “${find}”` : ''}${jump ? ` on or before ${day(until! - 2)}` : ''}.` : id ? 'Nothing recorded for this character yet.' : 'Nothing recorded yet.'}</p>
	{:else if sessions}
		{#each sessions as s, i (`${s.char}:${s.start}`)}
			{@const ch = chapterHere(i)}
			{#if ch}
				<div class="chapter">
					<span class="cn">Chapter {ch.n}{ch.next ? '' : ' · now'}</span>
					<h3>{ch.zone}{#if ch.zoneLevels}<small title="The levels the zone is made for">{ch.zoneLevels[0]}–{ch.zoneLevels[1]}</small>{/if}</h3>
					<div class="cmeta">
						{#if levels(ch)}<span>{levels(ch)}</span>{/if}
						<span>{ch.sessions} {ch.sessions === 1 ? 'session' : 'sessions'}</span>
						<span>{playtime(ch.seconds)}</span>
						{#if ch.quests}<span>{ch.quests} {ch.quests === 1 ? 'quest' : 'quests'}</span>{/if}
						{#if ch.next}<span>then {ch.next}</span>{/if}
					</div>
					<p>{ch.intro}</p>
				</div>
			{/if}
			<article class:current={dash.focus?.id === s.char && dash.focus?.buffer === key(s)}>
				<div class="head">
					{#if !id}<span class="who" style:color={dash.colorOf(s.char)}><b class="dot" style:background={dash.colorOf(s.char)}></b>{dash.name(s.char)}</span>{/if}
					<h3>{day(s.start)}</h3>
					<span class="when">{hhmm(s.start)}–{hhmm(s.end)} · {Math.round(s.seconds / 60)} min · {s.zones.join(', ')}</span>
					{#if !id && s.chapter}<span class="chip" title={s.chapter.intro}>Ch. {s.chapter.n} · {s.chapter.zone}</span>{/if}
					<button class="replay" onclick={() => dash.run(replay(s))}>Replay on map</button>
				</div>
				<div class="diary">
					{#if editing === sessionKey(s)}
						<textarea bind:value={editText} rows="7" maxlength="8000" aria-label="Your diary entry"></textarea>
						<div class="dbar">
							<button class="save" onclick={() => dash.run(saveEdit(s, editText))}>Save</button>
							<button onclick={() => (editing = null)}>Cancel</button>
							{#if s.diary.source === 'you'}<button class="restore" onclick={() => dash.run(saveEdit(s, ''))}>Use the written entry</button>{/if}
						</div>
					{:else}
						<p>{s.diary.text}</p>
						<div class="dbar">
							<span class="src">{sourceLabel(s)}</span>
							<button onclick={() => startEdit(s)}>Edit</button>
						</div>
					{/if}
				</div>
				<div class="facts">
					{#if s.levels.length}<span>level <b>{s.levels[0] - 1} → {s.levels[s.levels.length - 1]}</b></span>{/if}
					<span><b>{s.quests}</b> quests</span><span><b>{s.kills}</b> kills</span><span><b>{s.deaths}</b> deaths</span>
					<span><b>{(s.yards / 1000).toFixed(1)}k</b> yd walked</span>
					{#if s.group}<span title={groupTitle(s.group)}><b>{Math.round(s.group.seconds / 60)} min</b> {s.group.with.length ? `with ${s.group.with.map((w) => w.name).join(', ')}` : 'grouped'}</span>{/if}
					{#each GATHER as [k, one, many] (k)}{#if s.gathered[k]}<span><b>{s.gathered[k]}</b> {s.gathered[k] === 1 ? one : many}</span>{/if}{/each}
				</div>
				<button class="logt" aria-expanded={!!logOpen[sessionKey(s)]} onclick={() => (logOpen[sessionKey(s)] = !logOpen[sessionKey(s)])}>
					<i class:on={logOpen[sessionKey(s)]}></i>{logOpen[sessionKey(s)] ? 'Hide the log' : `The log · ${items(s).length} ${items(s).length === 1 ? 'entry' : 'entries'}`}
				</button>
				{#if logOpen[sessionKey(s)]}
				<ul class="events">
					{#each items(s) as e, j (j)}
						<li class="k-{e.kind}{e.how ? ` h-${e.how}` : ''}">
							{#if e.note !== undefined && noteEditing === e.note}
								{@const nid = e.note}
								<form class="ne" onsubmit={(ev) => { ev.preventDefault(); dash.run(saveNote(nid, noteText)); }}>
									<input maxlength="4000" aria-label="The note" bind:value={noteText} />
									<button class="save">Save</button>
									<button type="button" onclick={() => (noteEditing = null)}>Cancel</button>
									<button type="button" class="del" onclick={() => dash.run(deleteNote(nid))}>Delete</button>
								</form>
							{:else}
							<button class="ev" onclick={() => dash.run(replay(s, e))}><time>{hhmm(e.t)}</time><b class="ji"></b><span>{e.text}</span></button>
							{/if}
							{#if e.note !== undefined && noteEditing !== e.note}{@const nid = e.note}<button class="nedit" aria-label="Edit or delete this note" title="Edit or delete this note" onclick={() => ((noteEditing = nid), (noteText = e.text))}>Edit</button>{/if}
							{#if e.quest?.audio}<NarrationButton line={e.quest.audio} />{/if}
							{#if e.person}{@const who = e.person}<button class="pp" aria-label="About {who}" title="About this player" onclick={() => (dash.people = { who })}><i></i></button>{/if}
							{#if e.quest}
								<button class="qt" class:on={openQuest === qkey(s, e)} aria-expanded={openQuest === qkey(s, e)} aria-label="Quest details" title="Quest details" onclick={() => toggleQuest(s, e)}><i></i></button>
							{/if}
						</li>
						{#if e.quest && openQuest === qkey(s, e)}<li class="card"><QuestCard char={s.char} id={e.quest.id} /></li>{/if}
					{/each}
				</ul>
				{/if}
				<form class="note" onsubmit={(ev) => { ev.preventDefault(); dash.run(addNote(s)); }}>
					<input placeholder="Add a note to this session…" maxlength="4000" bind:value={drafts[draftKey(s)]} />
					<button>Add</button>
				</form>
			</article>
		{/each}
		{#if more}
			<button class="older" disabled={loadingOlder} onclick={() => dash.run(loadOlder())}>{loadingOlder ? 'Loading…' : 'Show older sessions'}</button>
		{:else if sessions.length > PAGE}
			<p class="end">The first session recorded.</p>
		{/if}
	{/if}
</section>

<style>
	.journal { display: none; position: absolute; z-index: 5; top: 12px; right: 12px; bottom: 84px; width: min(400px, calc(100% - 24px)); overflow: auto; padding: 0 10px 12px; border-radius: 12px; background: color-mix(in srgb, var(--bg) 92%, transparent); border: 1px solid var(--border); box-shadow: var(--window-shadow); backdrop-filter: blur(6px); }
	.journal.on { display: block; animation: drop 0.16s ease-out; }
	@keyframes drop { from { opacity: 0; transform: translateY(-8px); } }
	.jh { position: sticky; top: 0; z-index: 1; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; padding: 10px 2px 8px; background: var(--bg); }
	.find { flex: 1 1 100%; display: flex; gap: 6px; margin-top: 8px; }
	.find input { min-width: 0; background: var(--well); border: 1px solid var(--border); border-radius: 6px; padding: 5px 8px; color-scheme: dark; }
	.find input[type='search'] { flex: 1; }
	.find input[type='date'] { flex: none; width: 132px; }
	.find .clear { flex: none; background: var(--chip); border: 0; border-radius: 6px; padding: 4px 10px; color: var(--accent); font-weight: 600; }
	.ne { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; gap: 6px; padding: 4px 0; }
	.ne input { flex: 1 1 100%; min-width: 0; background: var(--well); border: 1px solid var(--border); border-radius: 6px; padding: 5px 8px; }
	.ne button, .nedit { flex: none; background: var(--chip); border: 0; border-radius: 6px; padding: 3px 10px; font-size: 12px; color: var(--textDim); }
	.ne button:hover, .nedit:hover { color: var(--text); }
	.ne .save { color: var(--accent); font-weight: 600; }
	.ne .del { margin-left: auto; color: var(--danger); }
	.jh h2 { font-size: 15px; }
	.jh small { margin-left: 8px; color: var(--textDim); font-weight: 500; font-size: 12px; }
	.close { background: none; border: 0; font-size: 22px; line-height: 1; color: var(--textDim); padding: 0 4px; }
	article { margin: 0 0 10px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
	article.current { border-color: var(--accent); box-shadow: inset 2px 0 0 var(--accent); }
	.head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; padding: 10px 12px; border-bottom: 1px solid var(--divider); }
	h3 { font-size: 15px; }
	.when { color: var(--textDim); }
	.replay { margin-left: auto; background: var(--chip); border: 0; border-radius: 6px; padding: 4px 10px; color: var(--accent); font-weight: 600; }
	.diary { padding: 10px 12px 2px; }
	.diary p { margin: 0; line-height: 1.55; font-size: 13.5px; white-space: pre-line; }
	.diary textarea { width: 100%; box-sizing: border-box; background: var(--well); border: 1px solid var(--border); border-radius: 6px; padding: 8px; color: var(--text); font: inherit; font-size: 13.5px; line-height: 1.5; resize: vertical; }
	.dbar { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
	.dbar .src { margin-right: auto; font-size: 11px; color: var(--textMuted); }
	.dbar button { background: var(--chip); border: 0; border-radius: 6px; padding: 3px 10px; font-size: 12px; color: var(--textDim); cursor: pointer; }
	.dbar button:hover { color: var(--text); }
	.dbar .save { color: var(--accent); font-weight: 600; }
	.dbar .restore { margin-left: auto; }
	.logt { display: flex; align-items: center; gap: 6px; margin: 8px 12px 0; padding: 4px 0; background: none; border: 0; color: var(--textDim); font-size: 12px; cursor: pointer; }
	.logt:hover { color: var(--text); }
	.logt i { width: 12px; height: 12px; background: currentColor; mask: url(/glyph/chevron-down.png) center / contain no-repeat; -webkit-mask: url(/glyph/chevron-down.png) center / contain no-repeat; transform: rotate(-90deg); transition: transform 0.12s; }
	.logt i.on { transform: none; }
	.facts { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 12px 0; }
	.facts span { background: var(--chip); border-radius: 999px; padding: 2px 10px; font-size: 12px; color: var(--textDim); }
	.facts b { color: var(--text); font-weight: 700; }
	.events { list-style: none; margin: 0; padding: 8px 12px; }
	.events li { display: flex; align-items: center; gap: 4px; }
	.events li.card { display: block; }
	.events .ev { all: unset; box-sizing: border-box; flex: 1; min-width: 0; display: grid; grid-template-columns: 62px 12px 1fr; gap: 6px; align-items: center; padding: 3px 0; cursor: pointer; border-radius: 4px; }
	.events .ev:hover { background: var(--hover); }
	.events .ev:focus-visible { outline: 1px solid var(--focus); }
	.qt { flex: none; width: 22px; height: 22px; display: grid; place-items: center; border: 0; border-radius: 999px; background: none; color: var(--textMuted); cursor: pointer; padding: 0; }
	.qt:hover, .qt.on { background: var(--chip); color: var(--text); }
	.qt:focus-visible { outline: 1px solid var(--focus); }
	.qt i { width: 12px; height: 12px; background: currentColor; mask: url(/glyph/chevron-down.png) center / contain no-repeat; -webkit-mask: url(/glyph/chevron-down.png) center / contain no-repeat; transition: transform 0.12s; }
	.qt.on i { transform: rotate(180deg); }
	.pp { flex: none; width: 22px; height: 22px; display: grid; place-items: center; border: 0; border-radius: 999px; background: none; color: var(--textMuted); cursor: pointer; padding: 0; }
	.pp:hover { background: var(--chip); color: var(--text); }
	.pp:focus-visible { outline: 1px solid var(--focus); }
	.pp i { width: 12px; height: 12px; background: currentColor; mask: url(/glyph/character.png) center / contain no-repeat; -webkit-mask: url(/glyph/character.png) center / contain no-repeat; }
	.older { display: block; width: 100%; margin: 0 0 10px; padding: 8px; border: 1px dashed var(--border); border-radius: 10px; background: none; color: var(--accent); font-weight: 600; cursor: pointer; }
	.older:disabled { color: var(--textDim); cursor: default; }
	.end { text-align: center; color: var(--textMuted); font-size: 12px; margin: 4px 0 12px; }
	.events time { white-space: nowrap; color: var(--textMuted); font-size: 12px; }
	.ji { width: 8px; height: 8px; border-radius: 50%; background: var(--textMuted); justify-self: center; }
	.k-death .ji { background: var(--danger); }
	.k-level .ji { background: var(--success); }
	.k-accept .ji, .k-turnin .ji { background: var(--quest); }
	.k-mark .ji, .k-note .ji { background: var(--accent); }
	.k-fail .ji, .k-abandon .ji { background: var(--quest); opacity: 0.5; }
	.k-group .ji, .k-met .ji { background: var(--accent); border-radius: 2px; }
	.h-fought .ji, .h-killedby .ji, .h-killed .ji { background: var(--danger); }
	/* Milestones (a first, a round number): a star, and the line a little stronger. */
	.k-milestone .ji { width: 12px; height: 12px; border-radius: 0; background: var(--accent); mask: url(/glyph/star.png) center / contain no-repeat; -webkit-mask: url(/glyph/star.png) center / contain no-repeat; }
	.k-milestone span { font-weight: 600; color: var(--accent); }
	.k-zone { color: var(--textDim); }
	.who { display: inline-flex; align-items: center; gap: 6px; font-weight: 700; flex-basis: 100%; }
	.dot { width: 8px; height: 8px; border-radius: 50%; }
	.k-note span { font-style: italic; color: var(--accent); }
	.note { display: flex; gap: 8px; padding: 0 12px 12px; }
	.note input { flex: 1; background: var(--well); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; }
	.note button { background: var(--chip); border: 0; border-radius: 6px; padding: 6px 12px; }
	.chapter { margin: 14px 2px 10px; padding: 0 2px 10px; border-bottom: 1px solid var(--divider); }
	.chapter .cn { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--accent); }
	.chapter h3 { margin: 2px 0 4px; font-size: 18px; }
	.chapter h3 small { margin-left: 8px; font-size: 12px; font-weight: 600; color: var(--textDim); }
	.cmeta { display: flex; flex-wrap: wrap; gap: 4px 6px; font-size: 12px; color: var(--textDim); }
	.cmeta span { background: var(--chip); border-radius: 999px; padding: 1px 8px; }
	.chapter p { margin: 6px 0 0; font-size: 13px; line-height: 1.5; font-style: italic; color: var(--textDim); }
	.chip { background: var(--chip); border-radius: 999px; padding: 1px 8px; font-size: 11px; color: var(--textDim); }
	.empty { color: var(--textDim); text-align: center; margin: 30px 0; }
	@media (pointer: coarse), (max-width: 720px) {
		.events .ev { padding: 8px 0; }
	}
	@media (max-width: 720px) {
		/* A phone: the journal covers the map and its player (nothing of them is usable beside it). */
		.journal { left: 8px; right: 8px; width: auto; top: 8px; bottom: 8px; }
		.find input[type='date'] { width: 118px; }
	}
</style>
