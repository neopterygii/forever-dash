<script lang="ts">
	// An item's icon (exported by tools/export-icons.cjs) in its quality's border, with its stack count.
	import type { Item } from '../lib/api';
	import { itemIconUrl, qualityColor } from '../lib/format';

	let { item, size = 36 }: { item: Item | null; size?: number } = $props();
	let failed = $state(false);
	const tip = $derived(item ? `${item.name ?? `Item ${item.id}`}${item.ilvl ? ` · item level ${item.ilvl}` : ''}${item.count && item.count > 1 ? ` ×${item.count}` : ''}` : 'Empty');
</script>

<span class="icon" class:empty={!item} style:--q={item ? qualityColor(item.quality) : 'transparent'} style:width="{size}px" style:height="{size}px" title={tip}>
	{#if item}
		{#if !failed}<img src={itemIconUrl(item.id)} alt="" onerror={() => (failed = true)} />{:else}<span class="ph">{(item.name ?? '?')[0]}</span>{/if}
		{#if item.count && item.count > 1}<b>{item.count}</b>{/if}
	{/if}
</span>

<style>
	.icon { position: relative; display: inline-grid; place-items: center; border-radius: 6px; background: var(--well); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--q) 70%, transparent); overflow: hidden; flex: none; }
	.icon.empty { box-shadow: inset 0 0 0 1px var(--border); opacity: 0.5; }
	img { width: 100%; height: 100%; object-fit: cover; }
	.ph { color: var(--q); font-weight: 700; }
	b { position: absolute; right: 2px; bottom: 0; font-size: 11px; font-weight: 700; color: #fff; text-shadow: 0 0 2px #000, 0 0 2px #000; }
</style>
