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

	// The first page, or as many sessions as are shown when only reloading (a note was added).
	let shownFor: string | undefined;
	$effect(() => {
		reload;
		if (!visible) return;
		const forScope = scope;
		// Read without subscribing: this effect writes `sessions`.
		const keep = shownFor === forScope ? Math.max(PAGE, untrack(() => sessions?.length ?? 0)) : PAGE;
		if (shownFor !== forScope) {
			sessions = null;
			openQuest = null;
		}
		shownFor = forScope;
		let stale = false;
		api.journal(id, undefined, keep).then((p) => {
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
			const p = await api.journal(id, sessions[sessions.length - 1], PAGE);
			sessions = [...sessions, ...p.sessions];
			more = p.more;
		} finally {
			loadingOlder = false;
		}
	}

	type Item = { t: number; kind: string; text: string; pos?: Pos | null; quest?: DashEvent['quest'] };
	const qkey = (s: Session, e: Item) => `${s.char}:${e.t}:${e.quest?.id}`;
	const toggleQuest = (s: Session, e: Item) => (openQuest = openQuest === qkey(s, e) ? null : qkey(s, e));
	const items = (s: Session): Item[] => [...s.events, ...s.notes.map((n) => ({ t: n.t, kind: 'note', text: n.text }))].sort((a, b) => b.t - a.t); // newest first, as the sessions
	const key = (s: Session) => `s:${s.start}:${s.end}`;
	const draftKey = (s: Session) => `${s.char}:${s.start}`;

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

	async function addNote(s: Session) {
		const k = draftKey(s);
		const text = (drafts[k] ?? '').trim();
		if (!text) return;
		await api.addNote(s.char, s.end, text);
		drafts[k] = '';
		reload++;
	}
</script>

<section class="journal" class:on={visible} aria-label="Journal">
	<header class="jh">
		<h2>Journal<small>{id ? dash.name(id) : 'all characters'}</small></h2>
		<button class="close" aria-label="Close the journal" onclick={() => (dash.journalOpen = false)}>×</button>
	</header>
	{#if sessions && !sessions.length}
		<p class="empty">{id ? 'Nothing recorded for this character yet.' : 'Nothing recorded yet.'}</p>
	{:else if sessions}
		{#each sessions as s (`${s.char}:${s.start}`)}
			<article class:current={dash.focus?.id === s.char && dash.focus?.buffer === key(s)}>
				<div class="head">
					{#if !id}<span class="who" style:color={dash.colorOf(s.char)}><b class="dot" style:background={dash.colorOf(s.char)}></b>{dash.name(s.char)}</span>{/if}
					<h3>{day(s.start)}</h3>
					<span class="when">{hhmm(s.start)}–{hhmm(s.end)} · {Math.round(s.seconds / 60)} min · {s.zones.join(', ')}</span>
					<button class="replay" onclick={() => dash.run(replay(s))}>Replay on map</button>
				</div>
				<div class="facts">
					{#if s.levels.length}<span>level <b>{s.levels[0] - 1} → {s.levels[s.levels.length - 1]}</b></span>{/if}
					<span><b>{s.quests}</b> quests</span><span><b>{s.kills}</b> kills</span><span><b>{s.deaths}</b> deaths</span>
					<span><b>{(s.yards / 1000).toFixed(1)}k</b> yd walked</span>
				</div>
				<ul class="events">
					{#each items(s) as e, j (j)}
						<li class="k-{e.kind}">
							<button class="ev" onclick={() => dash.run(replay(s, e))}><time>{hhmm(e.t)}</time><b class="ji"></b><span>{e.text}</span></button>
							{#if e.quest?.audio}<NarrationButton line={e.quest.audio} />{/if}
							{#if e.quest}
								<button class="qt" class:on={openQuest === qkey(s, e)} aria-expanded={openQuest === qkey(s, e)} aria-label="Quest details" title="Quest details" onclick={() => toggleQuest(s, e)}><i></i></button>
							{/if}
						</li>
						{#if e.quest && openQuest === qkey(s, e)}<li class="card"><QuestCard char={s.char} id={e.quest.id} /></li>{/if}
					{/each}
				</ul>
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
	.jh { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between; padding: 10px 2px 8px; background: inherit; }
	.jh h2 { font-size: 15px; }
	.jh small { margin-left: 8px; color: var(--textDim); font-weight: 500; font-size: 12px; }
	.close { background: none; border: 0; font-size: 22px; line-height: 1; color: var(--textDim); padding: 0 4px; }
	article { margin: 0 0 10px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
	article.current { border-color: var(--accent); box-shadow: inset 2px 0 0 var(--accent); }
	.head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; padding: 10px 12px; border-bottom: 1px solid var(--divider); }
	h3 { font-size: 15px; }
	.when { color: var(--textDim); }
	.replay { margin-left: auto; background: var(--chip); border: 0; border-radius: 6px; padding: 4px 10px; color: var(--accent); font-weight: 600; }
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
	.older { display: block; width: 100%; margin: 0 0 10px; padding: 8px; border: 1px dashed var(--border); border-radius: 10px; background: none; color: var(--accent); font-weight: 600; cursor: pointer; }
	.older:disabled { color: var(--textDim); cursor: default; }
	.end { text-align: center; color: var(--textMuted); font-size: 12px; margin: 4px 0 12px; }
	.events time { white-space: nowrap; color: var(--textMuted); font-size: 12px; }
	.ji { width: 8px; height: 8px; border-radius: 50%; background: var(--textMuted); justify-self: center; }
	.k-death .ji { background: var(--danger); }
	.k-level .ji { background: var(--success); }
	.k-accept .ji, .k-turnin .ji { background: var(--quest); }
	.k-mark .ji, .k-note .ji { background: var(--accent); }
	.k-zone { color: var(--textDim); }
	.who { display: inline-flex; align-items: center; gap: 6px; font-weight: 700; flex-basis: 100%; }
	.dot { width: 8px; height: 8px; border-radius: 50%; }
	.k-note span { font-style: italic; color: var(--accent); }
	.note { display: flex; gap: 8px; padding: 0 12px 12px; }
	.note input { flex: 1; background: var(--well); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; }
	.note button { background: var(--chip); border: 0; border-radius: 6px; padding: 6px 12px; }
	.empty { color: var(--textDim); text-align: center; margin: 30px 0; }
	@media (max-width: 720px) {
		.journal { left: 8px; right: 8px; width: auto; top: 8px; }
	}
</style>
