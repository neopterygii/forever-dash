<script lang="ts">
	// A quest as this character lived it, opened from its journal line: what the quest giver said
	// (and Spoken's narration of it), the objectives, who gave it and who took it back, how long it
	// took, what it paid, and what comes next.
	import { api, type QuestInfo } from '../lib/api';
	import { gold } from '../lib/format';
	import ItemIcon from './ItemIcon.svelte';
	import NarrationButton from './NarrationButton.svelte';

	let { char, id }: { char: string; id: number } = $props();
	let info = $state.raw<QuestInfo | null>(null);
	let failed = $state(false);
	let full = $state(false);

	$effect(() => {
		let stale = false;
		info = null;
		failed = false;
		api.quest(char, id).then(
			(q) => !stale && (info = q),
			() => !stale && (failed = true),
		);
		return () => (stale = true);
	});

	function took(s: number): string {
		if (s < 90) return `${Math.round(s)} s`;
		if (s < 5400) return `${Math.round(s / 60)} min`;
		if (s < 86400 * 2) return `${(s / 3600).toFixed(1)} h`;
		return `${Math.round(s / 86400)} days`;
	}
	const chosenId = $derived(info?.paid?.chosen?.id);
	const outcome = $derived.by(() => {
		const h = info?.history ?? [];
		const last = h[h.length - 1]?.kind;
		return last === 'turnin' ? 'Done' : last === 'abandon' ? 'Abandoned' : last === 'fail' ? 'Failed' : 'In the log';
	});
</script>

<div class="qc" role="region" aria-label="Quest details">
	{#if failed}
		<p class="dim">Couldn't load this quest.</p>
	{:else if !info}
		<p class="dim">Loading…</p>
	{:else}
		<div class="chips">
			<span class="st st-{outcome.split(' ')[0].toLowerCase()}">{outcome}</span>
			{#if info.level}<span>level <b>{info.level}</b>{#if info.minLevel && info.minLevel < info.level}&nbsp;· from {info.minLevel}{/if}</span>{/if}
			{#if info.zone}<span>{info.zone}</span>{/if}
			{#if info.seconds != null}<span>took <b>{took(info.seconds)}</b></span>{/if}
			{#if info.kills}<span><b>{info.kills}</b> kills for it</span>{/if}
		</div>

		{#if info.giver || info.ender}
			<p class="who">
				{#if info.giver}From <b>{info.giver.name}</b>{/if}{#if info.ender && info.ender.id !== info.giver?.id}{info.giver ? ', back to ' : 'Hand in to '}<b>{info.ender.name}</b>{/if}
			</p>
		{/if}

		{#if info.details || info.audio.accept}
			<div class="said">
				<div class="label">
					<span>Quest text</span>
					{#if info.audio.accept}<NarrationButton line={info.audio.accept} label="Play the quest giver" />{/if}
				</div>
				{#if info.details}
					<p class="text" class:clamp={!full}>{info.details}</p>
					{#if info.details.length > 260}<button class="more" onclick={() => (full = !full)}>{full ? 'Less' : 'More'}</button>{/if}
				{/if}
			</div>
		{/if}

		{#if info.objectives}
			<div class="said">
				<div class="label"><span>Objectives</span></div>
				<p class="text">{info.objectives}</p>
			</div>
		{/if}

		{#if info.audio.complete}
			<div class="said">
				<div class="label">
					<span>On hand-in</span>
					<NarrationButton line={info.audio.complete} label="Play the hand-in" />
				</div>
			</div>
		{/if}

		{#if info.rewards && (info.rewards.items.length || info.rewards.choices.length || info.paid)}
			<div class="said">
				<div class="label"><span>Rewards</span></div>
				<div class="rw">
					{#if info.paid?.xp}<span class="pay"><b>+{info.paid.xp}</b> xp</span>{:else if info.rewards.xp}<span class="pay">{info.rewards.xp} xp</span>{/if}
					{#if info.paid?.money}<span class="pay">{gold(info.paid.money)}</span>{:else if info.rewards.money}<span class="pay">{gold(info.rewards.money)}</span>{/if}
					{#each info.rewards.items as it (it.id)}<ItemIcon item={it} size={30} />{/each}
					{#if info.rewards.choices.length}
						<span class="or">choice of</span>
						{#each info.rewards.choices as it (it.id)}
							<span class="ch" class:picked={it.id === chosenId} class:other={chosenId != null && it.id !== chosenId}><ItemIcon item={it} size={30} /></span>
						{/each}
					{/if}
				</div>
				{#if info.paid?.chosen}<p class="dim">Took {info.paid.chosen.name ?? `item ${info.paid.chosen.id}`}.</p>{/if}
			</div>
		{/if}

		{#if info.next}<p class="dim">Leads on to “{info.next.title}”.</p>{/if}
		{#if info.history.length > 2}
			<p class="dim">{info.history.map((h) => ({ accept: 'accepted', turnin: 'handed in', abandon: 'abandoned', fail: 'failed' })[h.kind] ?? h.kind).join(' → ')}</p>
		{/if}
	{/if}
</div>

<style>
	.qc { margin: 2px 0 8px 68px; padding: 8px 10px; border-radius: 8px; background: var(--well); border: 1px solid var(--divider); display: grid; gap: 8px; font-size: 13px; }
	.chips { display: flex; flex-wrap: wrap; gap: 6px; }
	.chips span { background: var(--chip); border-radius: 999px; padding: 1px 9px; font-size: 12px; color: var(--textDim); }
	.chips b { color: var(--text); }
	.chips .st-done { color: var(--success); }
	.chips .st-abandoned, .chips .st-failed { color: var(--danger); }
	.who { margin: 0; color: var(--textDim); }
	.who b { color: var(--text); font-weight: 600; }
	.said { display: grid; gap: 4px; }
	.label { display: flex; align-items: center; gap: 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--textMuted); }
	.text { margin: 0; white-space: pre-line; line-height: 1.45; }
	.clamp { display: -webkit-box; -webkit-line-clamp: 4; line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
	.more { justify-self: start; background: none; border: 0; padding: 0; color: var(--accent); font-size: 12px; cursor: pointer; }
	.rw { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
	.pay { font-size: 12px; color: var(--textDim); }
	.pay b { color: var(--text); }
	.or { font-size: 12px; color: var(--textMuted); }
	.ch { display: inline-flex; border-radius: 7px; }
	.ch.picked { box-shadow: 0 0 0 2px var(--accent); }
	.ch.other { opacity: 0.45; }
	.dim { margin: 0; color: var(--textDim); font-size: 12px; }
	@media (max-width: 720px) {
		.qc { margin-left: 0; }
	}
</style>
