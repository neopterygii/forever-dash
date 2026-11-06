<script lang="ts">
	// A character's gear (laid out as the game's character sheet) or bags and bank, in a window over
	// the page, from its latest Polestar_DashSnapshot save and what Polestar itself keeps.
	import { api, type Container, type Item, type Snapshot } from '../lib/api';
	import { dash } from '../lib/dash.svelte';
	import { ago, className, classIconUrl, day, fullName, gold, hhmm, portraitUrl, qualityColor, raceName, realmName } from '../lib/format';
	import ItemIcon from './ItemIcon.svelte';

	let snap = $state.raw<Snapshot | null | undefined>(undefined);
	const sheet = $derived(dash.sheet);
	const ch = $derived(sheet ? dash.chars.find((c) => c.id === sheet.id) : undefined);

	$effect(() => {
		const id = sheet?.id;
		if (!id) return;
		let stale = false;
		snap = undefined;
		api.snapshot(id).then((s) => {
			if (!stale) snap = s;
		});
		return () => (stale = true);
	});

	function close() {
		dash.sheet = null;
	}
	function onkey(e: KeyboardEvent) {
		if (e.key === 'Escape' && dash.sheet) close();
	}

	// The game's character sheet: two columns of slots beside the portrait, the weapons under it.
	const LEFT = [1, 2, 3, 15, 5, 4, 19, 9];
	const RIGHT = [10, 6, 7, 8, 11, 12, 13, 14];
	const BOTTOM = [16, 17, 18];
	const SLOT_NAME: Record<number, string> = {
		1: 'Head', 2: 'Neck', 3: 'Shoulder', 4: 'Shirt', 5: 'Chest', 6: 'Waist', 7: 'Legs', 8: 'Feet', 9: 'Wrist', 10: 'Hands',
		11: 'Finger', 12: 'Finger', 13: 'Trinket', 14: 'Trinket', 15: 'Back', 16: 'Main hand', 17: 'Off hand', 18: 'Ranged', 19: 'Tabard',
	};
	const bySlot = $derived(new Map((snap?.equip ?? []).map((i) => [i.slot!, i])));
	const ilvl = $derived.by(() => {
		const l = (snap?.equip ?? []).filter((i) => i.slot !== 4 && i.slot !== 19 && i.ilvl).map((i) => i.ilvl!);
		return l.length ? Math.round(l.reduce((a, b) => a + b, 0) / l.length) : null;
	});

	const BAG_NAMES: Record<number, string> = { [-2]: 'Keyring', [-1]: 'Bank', 0: 'Backpack' };
	const bagName = (b: Container) => b.item?.name ?? BAG_NAMES[b.bag] ?? `Bag ${b.bag}`;
	const cells = (b: Container) => Array.from({ length: b.size }, (_, i) => b.slots.find((s) => s.slot === i + 1) ?? null);
	const used = (bs: Container[] | null) => (bs ?? []).reduce((n, b) => n + b.slots.length, 0);
	const total = (bs: Container[] | null) => (bs ?? []).reduce((n, b) => n + b.size, 0);
	const when = (t: number | null | undefined) => (t ? `${day(t)} ${hhmm(t)} (${ago(t)})` : '');
	const tip = (i: Item | undefined, slot: number) => (i ? `${i.name ?? `Item ${i.id}`}${i.ilvl ? ` · item level ${i.ilvl}` : ''} · ${SLOT_NAME[slot]}` : `${SLOT_NAME[slot]}: empty`);
</script>

<svelte:window onkeydown={onkey} />

{#if sheet && ch}
	<div class="backdrop" role="presentation" onclick={close}></div>
	<div class="window" role="dialog" aria-modal="true" aria-label="{fullName(ch)}: {sheet.view === 'gear' ? 'gear' : 'bags'}">
		<header>
			<img class="portrait" src={portraitUrl(ch.race, ch.sex)} alt="" />
			<div class="who">
				<h2>{fullName(ch)}</h2>
				<span>Level {ch.level} {raceName(ch.race)} {className(ch.class)}{realmName(ch.realmName ?? ch.realm) ? ` · ${realmName(ch.realmName ?? ch.realm)}` : ''}</span>
			</div>
			<nav>
				<button class:on={sheet.view === 'gear'} onclick={() => (dash.sheet = { id: sheet.id, view: 'gear' })}>Gear</button>
				<button class:on={sheet.view === 'bags'} onclick={() => (dash.sheet = { id: sheet.id, view: 'bags' })}>Bags</button>
			</nav>
			<button class="close" aria-label="Close" onclick={close}>×</button>
		</header>

		{#if snap === undefined}
			<p class="empty">Loading…</p>
		{:else if snap === null}
			<p class="empty">No gear or bags yet: they come from the Polestar_DashSnapshot addon, after this character logs in with it.</p>
		{:else if sheet.view === 'gear'}
			<div class="doll">
				<div class="col">
					{#each LEFT as s (s)}{@const it = bySlot.get(s)}<span class="slot" title={tip(it, s)}><ItemIcon item={it ?? null} size={40} />{#if !it}<i>{SLOT_NAME[s]}</i>{/if}</span>{/each}
				</div>
				<div class="mid">
					<img class="big" src={portraitUrl(ch.race, ch.sex)} alt="" />
					{#if classIconUrl(ch.class)}<img class="cls" src={classIconUrl(ch.class)} alt="" />{/if}
					<dl>
						{#if ilvl}<dt>Item level</dt><dd>{ilvl}</dd>{/if}
						<dt>Gold</dt><dd>{gold(snap.money ?? ch.money)}</dd>
						{#if ch.bind}<dt>Hearthstone</dt><dd>{ch.bind}</dd>{/if}
						{#if ch.guide}<dt>Guide</dt><dd>{ch.guide.title} · {ch.guide.step}/{ch.guide.count}</dd>{/if}
					</dl>
					<small>{when(snap.equipAt)}</small>
				</div>
				<div class="col">
					{#each RIGHT as s (s)}{@const it = bySlot.get(s)}<span class="slot" title={tip(it, s)}><ItemIcon item={it ?? null} size={40} />{#if !it}<i>{SLOT_NAME[s]}</i>{/if}</span>{/each}
				</div>
				<div class="bottom">
					{#each BOTTOM as s (s)}{@const it = bySlot.get(s)}<span class="slot" title={tip(it, s)}><ItemIcon item={it ?? null} size={40} />{#if !it}<i>{SLOT_NAME[s]}</i>{/if}</span>{/each}
				</div>
			</div>
			<ul class="list">
				{#each [...LEFT, ...RIGHT, ...BOTTOM] as s (s)}
					{@const it = bySlot.get(s)}
					{#if it}<li><span class="ln" style:color={qualityColor(it.quality)}>{it.name ?? `Item ${it.id}`}</span><span class="lm">{SLOT_NAME[s]}{it.ilvl ? ` · ${it.ilvl}` : ''}</span></li>{/if}
				{/each}
			</ul>
		{:else}
			<section>
				<h3>Bags <small>{used(snap.bags)} / {total(snap.bags)} · {when(snap.bagsAt)} · {gold(snap.money ?? ch.money)}</small></h3>
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
		{/if}
	</div>
{/if}

<style>
	.backdrop { position: fixed; inset: 0; background: color-mix(in srgb, var(--scrim) 55%, transparent); z-index: 20; }
	.window { position: fixed; z-index: 21; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(560px, calc(100vw - 24px)); max-height: calc(100vh - 24px); overflow: auto; background: var(--panel); border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--window-shadow); padding: 14px 16px 18px; }
	header { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
	.portrait { width: 40px; height: 40px; border-radius: 50%; box-shadow: 0 0 0 2px var(--accent); }
	.who { display: flex; flex-direction: column; min-width: 0; flex: 1; }
	h2 { font-size: 16px; }
	.who span { color: var(--textDim); font-size: 12px; }
	nav { display: flex; gap: 2px; padding: 3px; border-radius: 8px; background: var(--well); }
	nav button { background: none; border: 0; border-radius: 6px; padding: 4px 12px; color: var(--textDim); font-weight: 600; }
	nav button.on { background: var(--selected); color: var(--text); }
	.close { background: none; border: 0; font-size: 22px; line-height: 1; color: var(--textDim); padding: 0 4px; }
	.empty { color: var(--textDim); text-align: center; margin: 30px 0; }

	.doll { display: grid; grid-template-columns: 44px 1fr 44px; grid-template-areas: 'l m r' 'b b b'; gap: 6px 14px; padding: 12px; border-radius: 12px; background: radial-gradient(circle at 50% 35%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 60%), var(--well); }
	.col { display: flex; flex-direction: column; gap: 6px; }
	.col:first-child { grid-area: l; }
	.col:nth-child(3) { grid-area: r; }
	.mid { grid-area: m; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; position: relative; text-align: center; }
	.big { width: 110px; height: 110px; border-radius: 50%; box-shadow: 0 0 0 3px var(--border), 0 0 30px color-mix(in srgb, var(--accent) 25%, transparent); }
	.cls { position: absolute; top: calc(50% - 98px); left: calc(50% + 30px); width: 28px; height: 28px; border-radius: 50%; box-shadow: 0 0 0 2px var(--panel); }
	dl { display: grid; grid-template-columns: auto auto; gap: 2px 10px; margin: 0; font-size: 12px; }
	dt { color: var(--textMuted); text-align: right; }
	dd { margin: 0; text-align: left; }
	.mid small { color: var(--textMuted); font-size: 11px; }
	.bottom { grid-area: b; display: flex; justify-content: center; gap: 6px; }
	.slot { position: relative; display: inline-grid; }
	.slot i { position: absolute; inset: 0; display: grid; place-items: center; font-style: normal; font-size: 8px; line-height: 1; text-align: center; color: var(--textMuted); pointer-events: none; padding: 2px; }
	.list { list-style: none; margin: 12px 0 0; padding: 0; columns: 2; column-gap: 16px; font-size: 12px; }
	.list li { display: flex; justify-content: space-between; gap: 8px; break-inside: avoid; padding: 1px 0; }
	.ln { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 600; }
	.lm { color: var(--textMuted); white-space: nowrap; }

	h3 { font-size: 14px; margin-bottom: 10px; }
	h3 small, .bagname small { color: var(--textMuted); font-weight: 500; margin-left: 6px; }
	h3.bank { margin-top: 16px; }
	.bag { margin-bottom: 12px; }
	.bagname { font-size: 12px; color: var(--textDim); margin-bottom: 6px; }
	.grid { display: grid; grid-template-columns: repeat(auto-fill, 36px); gap: 4px; }
	@media (max-width: 520px) {
		.list { columns: 1; }
		.big { width: 84px; height: 84px; }
	}
</style>
