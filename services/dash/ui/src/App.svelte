<script lang="ts">
	import { onMount } from 'svelte';
	import { dash } from './lib/dash.svelte';
	import { fullName } from './lib/format';
	import Sidebar from './components/Sidebar.svelte';
	import MapPane from './components/MapPane.svelte';
	import Journal from './components/Journal.svelte';
	import CharacterSheet from './components/CharacterSheet.svelte';

	onMount(() => dash.run(dash.load()));

	const who = $derived.by(() => {
		if (dash.mode === 'overview') return dash.overview ? `All characters · last ${dash.overview.hours} h of play each` : '';
		const f = dash.focus;
		const c = f && dash.chars.find((x) => x.id === f.id);
		return c && f ? `${fullName(c)} · level ${c.level} · ${f.kept} of ${f.points} points` : '';
	});
</script>

<div class="app">
	<Sidebar />
	<main>
		<nav class="tabs">
			<span class="who">{who}</span>
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
{#if dash.error}<pre class="error">{dash.error}</pre>{/if}

<style>
	:global(#app) { height: 100%; }
	.app { display: grid; grid-template-columns: 280px minmax(0, 1fr); height: 100%; }
	main { display: grid; grid-template-rows: auto minmax(0, 1fr); min-width: 0; }
	.body { position: relative; min-height: 0; }
	.tabs { display: flex; gap: 4px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--border); background: var(--panel); }
	.who { color: var(--textDim); margin-right: auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.jt { display: inline-flex; align-items: center; gap: 6px; background: var(--chip); border: 0; padding: 6px 12px; border-radius: 8px; color: var(--textDim); font-weight: 600; }
	.jt img { width: 14px; height: 14px; opacity: 0.8; }
	.jt.on { background: var(--accent); color: var(--onAccent); }
	.jt.on img { filter: brightness(0); }
	.error { position: fixed; bottom: 0; left: 0; margin: 8px; color: var(--danger); background: var(--panel); padding: 6px 10px; border-radius: 6px; }
	@media (max-width: 720px) {
		.app { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }
		.who { font-size: 11px; }
	}
</style>
