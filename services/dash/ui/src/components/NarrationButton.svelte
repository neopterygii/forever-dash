<script lang="ts">
	// Play/pause one Spoken narration line; while it plays, how far in it is.
	import { mmss, narrator, type Narration } from '../lib/narration.svelte';

	let { line, label = 'Play the narration' }: { line: Narration; label?: string } = $props();
	const current = $derived(narrator.url === line.url);
	const on = $derived(current && narrator.playing);
</script>

{#if narrator.supported}
	<button
		class="nb"
		class:on
		aria-label={on ? 'Pause the narration' : label}
		title={on ? 'Pause' : `${label} (${mmss(line.length)})`}
		onclick={(e) => {
			e.stopPropagation();
			narrator.toggle(line);
		}}
	>
		<i style:--g={on ? 'url(/glyph/pause.png)' : 'url(/glyph/play.png)'}></i>
		{#if current}<span>{mmss(narrator.at)} / {mmss(line.length)}</span>{/if}
	</button>
{/if}

<style>
	.nb { display: inline-flex; align-items: center; gap: 5px; flex: none; height: 22px; min-width: 22px; padding: 0 6px; border: 0; border-radius: 999px; background: var(--chip); color: var(--quest); cursor: pointer; font-size: 11px; font-variant-numeric: tabular-nums; }
	.nb:hover { background: var(--hover); }
	.nb.on { background: var(--quest); color: var(--bg); }
	.nb:focus-visible { outline: 1px solid var(--focus); }
	i { width: 10px; height: 10px; background: currentColor; mask: var(--g) center / contain no-repeat; -webkit-mask: var(--g) center / contain no-repeat; }
</style>
