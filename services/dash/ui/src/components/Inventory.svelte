<script lang="ts">
	// The focused character's gear, bags and bank, from its latest Polestar_DashSnapshot save, with
	// what Polestar itself keeps (gold, hearthstone, guide).
	import { api, type Container, type Snapshot } from '../lib/api';
	import { dash } from '../lib/dash.svelte';
	import { ago, day, fullName, gold, hhmm, qualityColor } from '../lib/format';
	import ItemIcon from './ItemIcon.svelte';

	let { visible }: { visible: boolean } = $props();
	let snap = $state.raw<Snapshot | null | undefined>(undefined);

	const id = $derived(dash.mode === 'focus' ? dash.focus?.id : undefined);
	const ch = $derived(id ? dash.chars.find((c) => c.id === id) : undefined);

	$effect(() => {
		if (!visible || !id) return;
		let stale = false;
		snap = undefined;
		api.snapshot(id).then((s) => {
			if (!stale) snap = s;
		});
		return () => (stale = true);
	});

	const BAG_NAMES: Record<number, string> = { [-2]: 'Keyring', [-1]: 'Bank', 0: 'Backpack' };
	const bagName = (b: Container) => b.item?.name ?? BAG_NAMES[b.bag] ?? `Bag ${b.bag}`;
	const cells = (b: Container) => Array.from({ length: b.size }, (_, i) => b.slots.find((s) => s.slot === i + 1) ?? null);
	const used = (bs: Container[] | null) => (bs ?? []).reduce((n, b) => n + b.slots.length, 0);
	const total = (bs: Container[] | null) => (bs ?? []).reduce((n, b) => n + b.size, 0);
	const when = (t: number | null | undefined) => (t ? `${day(t)} ${hhmm(t)} (${ago(t)})` : '');
</script>

<section class="inv" class:on={visible}>
	{#if !id || !ch}
		<p class="empty">Pick a character to see its gear and bags.</p>
	{:else}
		<header>
			<h2>{fullName(ch)}</h2>
			<div class="facts">
				{#if ch.money != null || snap?.money != null}<span>Gold <b>{gold(snap?.money ?? ch.money)}</b></span>{/if}
				{#if ch.bind}<span>Hearthstone <b>{ch.bind}</b></span>{/if}
				{#if ch.guide}<span>Guide <b>{ch.guide.title}</b> · step {ch.guide.step} of {ch.guide.count}</span>{/if}
				{#if ch.realmName}<span>{ch.realmName}</span>{/if}
			</div>
		</header>
		{#if snap === undefined}
			<p class="empty">Loading…</p>
		{:else if snap === null}
			<p class="empty">No gear or bags yet: they come from the Polestar_DashSnapshot addon, after this character logs in with it.</p>
		{:else}
			<div class="cols">
				<section class="panel">
					<h3>Gear <small>{when(snap.equipAt)}</small></h3>
					<ul class="gear">
						{#each snap.equip as it (it.slot)}
							<li>
								<ItemIcon item={it} />
								<span class="iname" style:color={qualityColor(it.quality)}>{it.name ?? `Item ${it.id}`}</span>
								<span class="meta">{it.slotName}{it.ilvl ? ` · ${it.ilvl}` : ''}</span>
							</li>
						{:else}
							<li class="none">Nothing equipped was read.</li>
						{/each}
					</ul>
				</section>
				<section class="panel">
					<h3>Bags <small>{used(snap.bags)} / {total(snap.bags)} · {when(snap.bagsAt)}</small></h3>
					{#each snap.bags ?? [] as b (b.bag)}
						<div class="bag">
							<div class="bagname">{bagName(b)} <small>{b.slots.length}/{b.size}</small></div>
							<div class="grid">{#each cells(b) as it, i (i)}<ItemIcon item={it} />{/each}</div>
						</div>
					{/each}
					<h3 class="bank">Bank <small>{snap.bank ? `${used(snap.bank)} / ${total(snap.bank)} · as last seen ${when(snap.bankAt)}` : 'not seen yet: open the bank in game'}</small></h3>
					{#each snap.bank ?? [] as b (b.bag)}
						<div class="bag">
							<div class="bagname">{bagName(b)} <small>{b.slots.length}/{b.size}</small></div>
							<div class="grid">{#each cells(b) as it, i (i)}<ItemIcon item={it} />{/each}</div>
						</div>
					{/each}
				</section>
			</div>
		{/if}
	{/if}
</section>

<style>
	.inv { display: none; overflow: auto; padding: 16px 20px 40px; height: 100%; }
	.inv.on { display: block; }
	header { max-width: 1100px; margin: 0 auto 12px; }
	h2 { font-size: 18px; margin-bottom: 6px; }
	.facts { display: flex; flex-wrap: wrap; gap: 6px; }
	.facts span { background: var(--chip); border-radius: 999px; padding: 2px 10px; font-size: 12px; color: var(--textDim); }
	.facts b { color: var(--text); }
	.cols { max-width: 1100px; margin: 0 auto; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr); gap: 16px; align-items: start; }
	.panel { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }
	h3 { font-size: 14px; margin-bottom: 10px; }
	h3 small, .bagname small { color: var(--textMuted); font-weight: 500; margin-left: 6px; }
	h3.bank { margin-top: 18px; }
	.gear { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
	.gear li { display: grid; grid-template-columns: 36px 1fr; grid-template-rows: auto auto; column-gap: 10px; align-items: center; }
	.gear :global(.icon) { grid-row: span 2; }
	.iname { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.meta { color: var(--textMuted); font-size: 11px; }
	.none { color: var(--textDim); }
	.bag { margin-bottom: 12px; }
	.bagname { font-size: 12px; color: var(--textDim); margin-bottom: 6px; }
	.grid { display: grid; grid-template-columns: repeat(auto-fill, 36px); gap: 4px; }
	.empty { color: var(--textDim); text-align: center; margin-top: 60px; }
	@media (max-width: 900px) {
		.cols { grid-template-columns: 1fr; }
		.inv { padding: 12px 16px 40px; }
	}
</style>
