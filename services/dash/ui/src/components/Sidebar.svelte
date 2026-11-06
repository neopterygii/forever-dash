<script lang="ts">
	import { dash } from '../lib/dash.svelte';
	import CharacterCard from './CharacterCard.svelte';

	// Picking the selected character again goes back to everyone.
	function pick(id: string | null) {
		const again = id && dash.mode === 'focus' && dash.focus?.id === id;
		dash.run(id && !again ? dash.showFocus(id) : dash.leaveFocus());
	}

</script>

<aside class="side">
	<header class="brand"><img src="/brand/wordmark.svg" alt="Forever Dash" /></header>
	<ul class="chars">
		<li class:on={dash.mode === 'overview'}>
			<button class="all" onclick={() => pick(null)}><span class="n">All characters</span></button>
		</li>
		{#each [...dash.chars].sort((a, b) => Number(dash.starred.includes(b.id)) - Number(dash.starred.includes(a.id))) as c (c.id)}
			<CharacterCard {c} selected={dash.mode === 'focus' && dash.focus?.id === c.id} color={dash.colorOf(c.id)} onpick={() => pick(c.id)} onopen={(view) => (dash.sheet = { id: c.id, view })} />
		{/each}
	</ul>
	{#if dash.stats}
		<footer class="stats">{dash.stats.chunks} chunks · {dash.stats.positions} positions · {dash.stats.events} events (all kept)</footer>
	{/if}
</aside>

<style>
	.side { background: var(--sidebar); border-right: 1px solid var(--border); display: flex; flex-direction: column; min-height: 0; }
	.brand { padding: 16px; }
	.brand img { height: 40px; width: auto; display: block; }
	.chars { list-style: none; margin: 0; padding: 4px 8px; overflow: auto; flex: 1; }
	.chars button { all: unset; box-sizing: border-box; width: 100%; padding: 10px; border-radius: 8px; cursor: pointer; display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; }
	.chars button:hover { background: var(--hover); }
	.chars button:focus-visible { outline: 1px solid var(--focus); }
	.chars li.on button { background: var(--selected); box-shadow: inset 2px 0 0 var(--accent); }
	.n { font-weight: 700; font-size: 14px; }
	.all .n { font-size: 13px; }
	.stats { padding: 12px 16px; color: var(--textMuted); font-size: 11px; border-top: 1px solid var(--border); }
	@media (max-width: 720px) {
		.side { max-height: 32vh; border-right: 0; border-bottom: 1px solid var(--border); }
		.stats { display: none; }
	}
</style>
