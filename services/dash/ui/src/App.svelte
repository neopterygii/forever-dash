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
			<button class:on={dash.tab === 'map'} onclick={() => (dash.tab = 'map')}>Map</button>
			<button class:on={dash.tab === 'journal'} onclick={() => (dash.tab = 'journal')}>Journal</button>
			<span class="who">{who}</span>
		</nav>
		<div class="body">
			<!-- Both stay mounted: the map keeps its WebGL context and view while the journal is open. -->
			<MapPane visible={dash.tab === 'map'} />
			<Journal visible={dash.tab === 'journal'} />
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
	.tabs button { background: none; border: 0; padding: 6px 12px; border-radius: 6px; color: var(--textDim); font-weight: 600; }
	.tabs button.on { background: var(--selected); color: var(--text); }
	.who { margin-left: auto; color: var(--textDim); }
	.error { position: fixed; bottom: 0; left: 0; margin: 8px; color: var(--danger); background: var(--panel); padding: 6px 10px; border-radius: 6px; }
	@media (max-width: 720px) {
		.app { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }
		.who { font-size: 11px; }
	}
</style>
