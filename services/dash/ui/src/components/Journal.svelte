<script lang="ts">
	// The focused character's journal: sessions newest first, their events and notes.
	import { api, type Session } from '../lib/api';
	import { dash } from '../lib/dash.svelte';
	import { day, hhmm } from '../lib/format';

	let { visible }: { visible: boolean } = $props();
	let sessions = $state.raw<Session[] | null>(null);
	let reload = $state(0);
	let drafts = $state<Record<number, string>>({});

	const id = $derived(dash.mode === 'focus' ? dash.focus?.id : undefined);

	$effect(() => {
		reload;
		if (!visible || !id) return;
		let stale = false;
		api.journal(id).then((s) => {
			if (!stale) sessions = s;
		});
		return () => (stale = true);
	});

	type Item = { t: number; kind: string; text: string };
	const items = (s: Session): Item[] => [...s.events, ...s.notes.map((n) => ({ t: n.t, kind: 'note', text: n.text }))].sort((a, b) => a.t - b.t);
	const key = (s: Session) => `s:${s.start}:${s.end}`;

	async function replay(s: Session, t?: number) {
		await dash.showFocus(id!, key(s));
		if (t !== undefined) dash.t = t;
		dash.tab = 'map';
	}

	async function addNote(s: Session, i: number) {
		const text = (drafts[i] ?? '').trim();
		if (!text || !id) return;
		await api.addNote(id, s.end, text);
		drafts[i] = '';
		reload++;
	}
</script>

<section class="journal" class:on={visible}>
	{#if !id}
		<p class="empty">Pick a character to read its journal.</p>
	{:else if sessions && !sessions.length}
		<p class="empty">Nothing recorded for this character yet.</p>
	{:else if sessions}
		{#each sessions as s, i (s.start)}
			<article>
				<div class="head">
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
							<button onclick={() => dash.run(replay(s, e.t))}><time>{hhmm(e.t)}</time><b class="ji"></b><span>{e.text}</span></button>
						</li>
					{/each}
				</ul>
				<form class="note" onsubmit={(ev) => { ev.preventDefault(); dash.run(addNote(s, i)); }}>
					<input placeholder="Add a note to this session…" maxlength="4000" bind:value={drafts[i]} />
					<button>Add</button>
				</form>
			</article>
		{/each}
	{/if}
</section>

<style>
	.journal { display: none; overflow: auto; padding: 16px 20px 40px; height: 100%; }
	.journal.on { display: block; }
	article { max-width: 860px; margin: 0 auto 16px; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
	.head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; padding: 14px 16px; border-bottom: 1px solid var(--divider); }
	h3 { font-size: 15px; }
	.when { color: var(--textDim); }
	.replay { margin-left: auto; background: var(--chip); border: 0; border-radius: 6px; padding: 4px 10px; color: var(--accent); font-weight: 600; }
	.facts { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 16px 0; }
	.facts span { background: var(--chip); border-radius: 999px; padding: 2px 10px; font-size: 12px; color: var(--textDim); }
	.facts b { color: var(--text); font-weight: 700; }
	.events { list-style: none; margin: 0; padding: 10px 16px; }
	.events button { all: unset; box-sizing: border-box; width: 100%; display: grid; grid-template-columns: 72px 14px 1fr; gap: 8px; align-items: center; padding: 3px 0; cursor: pointer; border-radius: 4px; }
	.events button:hover { background: var(--hover); }
	.events button:focus-visible { outline: 1px solid var(--focus); }
	.events time { white-space: nowrap; color: var(--textMuted); font-size: 12px; }
	.ji { width: 8px; height: 8px; border-radius: 50%; background: var(--textMuted); justify-self: center; }
	.k-death .ji { background: var(--danger); }
	.k-level .ji { background: var(--success); }
	.k-accept .ji, .k-turnin .ji { background: var(--quest); }
	.k-mark .ji, .k-note .ji { background: var(--accent); }
	.k-zone { color: var(--textDim); }
	.k-note span { font-style: italic; color: var(--accent); }
	.note { display: flex; gap: 8px; padding: 0 16px 14px; }
	.note input { flex: 1; background: var(--well); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; }
	.note button { background: var(--chip); border: 0; border-radius: 6px; padding: 6px 12px; }
	.empty { color: var(--textDim); text-align: center; margin-top: 60px; }
	@media (max-width: 720px) {
		.journal { padding: 12px 16px 40px; }
	}
</style>
