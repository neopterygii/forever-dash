<script lang="ts">
	import { onMount } from 'svelte';
	import { dash } from './lib/dash.svelte';
	import { fullName } from './lib/format';
	import Sidebar from './components/Sidebar.svelte';
	import MapPane from './components/MapPane.svelte';
	import Journal from './components/Journal.svelte';
	import CharacterSheet from './components/CharacterSheet.svelte';
	import People from './components/People.svelte';
	import SignIn from './components/SignIn.svelte';

	onMount(() => {
		dash.run(dash.load());
		const onPop = () => dash.run(dash.applyLocation());
		window.addEventListener('popstate', onPop);
		return () => window.removeEventListener('popstate', onPop);
	});

	/** Esc leaves the selected character (after the character sheet, which closes first). */
	function onkey(e: KeyboardEvent) {
		if (e.key !== 'Escape' || e.defaultPrevented || dash.sheet || dash.people || dash.mode !== 'focus') return;
		const t = e.target as HTMLElement | null;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
		dash.run(dash.leaveFocus());
	}

	const who = $derived.by(() => {
		if (dash.mode === 'overview') return dash.overview ? `All characters · last ${dash.overview.hours} h of play each` : '';
		const f = dash.focus;
		const c = f && dash.chars.find((x) => x.id === f.id);
		return c && f ? `${fullName(c)} · level ${c.level ?? '?'}` : '';
	});

	// The address follows what is shown (the moment, the journal), so a reload or a copied link
	// opens the same thing. Not while playing: the moment is written when the replay stops.
	$effect(() => {
		dash.t;
		dash.journalOpen;
		if (dash.playing || !dash.timeline || dash.signedOut) return;
		const timer = setTimeout(() => dash.syncLocation(), 400);
		return () => clearTimeout(timer);
	});
</script>

{#if dash.signedOut}
<SignIn />
{:else if dash.access}
<div class="app">
	<Sidebar />
	<main>
		<nav class="tabs">
			{#if dash.mode === 'focus'}
				<button class="back" title="Back to all characters (Esc)" onclick={() => dash.run(dash.leaveFocus())}><i></i>All characters</button>
			{/if}
			<span class="who">{who}</span>
			{#if dash.fresh}
				<button class="fresh" title="Newer play has been uploaded" onclick={() => dash.run(dash.showLatest())}><b></b>New play · show</button>
			{/if}
			<button class="jt pt" class:on={!!dash.people} aria-pressed={!!dash.people} onclick={() => (dash.people = dash.people ? null : { who: null })}>
				<img src="/glyph/character.png" alt="" />People
			</button>
			<button class="jt" class:on={dash.journalOpen} aria-pressed={dash.journalOpen} onclick={() => (dash.journalOpen = !dash.journalOpen)}>
				<img src="/glyph/guides.png" alt="" />Journal
			</button>
		</nav>
		<div class="body">
			<MapPane visible={true} />
			<Journal />
		</div>
	</main>
</div>
<CharacterSheet />
<People />
{/if}
<svelte:window onkeydown={onkey} />
{#if dash.error}<pre class="error">{dash.error}</pre>{/if}

<style>
	:global(#app) { height: 100%; }
	.app { display: grid; grid-template-columns: 320px minmax(0, 1fr); height: 100%; }
	/* One column that never grows past the screen: an implicit auto column sized to the top bar's full text,
	   so a selected character's long title line widened the page instead of ending in an ellipsis. */
	main { display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); min-width: 0; }
	.body { position: relative; min-height: 0; }
	.tabs { display: flex; gap: 4px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--border); background: var(--panel); }
	.back { display: inline-flex; align-items: center; gap: 4px; flex: none; background: var(--chip); border: 0; padding: 6px 10px 6px 6px; border-radius: 8px; color: var(--text); font-weight: 600; cursor: pointer; }
	.back:hover { background: var(--hover); }
	.back:focus-visible { outline: 1px solid var(--focus); }
	.back i { width: 14px; height: 14px; background: currentColor; mask: url(/glyph/chevron-left.png) center / contain no-repeat; -webkit-mask: url(/glyph/chevron-left.png) center / contain no-repeat; }
	.who { color: var(--textDim); margin-right: auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.fresh { display: inline-flex; align-items: center; gap: 6px; flex: none; background: var(--chip); border: 1px solid var(--accent); padding: 5px 10px; border-radius: 999px; color: var(--accent); font-weight: 600; }
	.fresh b { width: 7px; height: 7px; border-radius: 50%; background: #6bd999; }
	.jt { display: inline-flex; align-items: center; gap: 6px; background: var(--chip); border: 0; padding: 6px 12px; border-radius: 8px; color: var(--textDim); font-weight: 600; }
	.jt img { width: 14px; height: 14px; opacity: 0.8; }
	.jt.on { background: var(--accent); color: var(--onAccent); }
	.jt.on img { filter: brightness(0); }
	.error { position: fixed; bottom: 0; left: 0; margin: 8px; color: var(--danger); background: var(--panel); padding: 6px 10px; border-radius: 6px; }
	@media (max-width: 720px) {
		/* minmax(0, …): a bare 1fr lets the top bar's widest content widen the page (sideways scroll on phones). */
		.app { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
		.who { font-size: 11px; }
	}
</style>
