<script lang="ts">
	// One character in the sidebar: portrait, name, level, XP, where they are; picks the focus.
	import type { Character } from '../lib/api';
	import { ago, className, classIconUrl, fullName, gold, portraitUrl, raceName, realmName } from '../lib/format';

	let { c, selected, color, onpick, onopen }: { c: Character; selected: boolean; color: string; onpick: () => void; onopen: (view: 'gear' | 'bags') => void } = $props();

	const portrait = $derived(portraitUrl(c.race, c.sex));
	const classIcon = $derived(classIconUrl(c.class));
	const xpPct = $derived(c.xp != null && c.xpMax ? Math.min(100, (100 * c.xp) / c.xpMax) : null);
	const restedPct = $derived(xpPct != null && c.rested && c.xpMax ? Math.min(100 - xpPct, (100 * c.rested) / c.xpMax) : 0);
	const where = $derived(c.lastPos?.zone ? `${c.lastPos.zone}${c.lastPos.subzone ? ` · ${c.lastPos.subzone}` : ''}` : '');
	const realm = $derived(realmName(c.realm));
	let portraitOk = $state(true);
	let classOk = $state(true);
</script>

<li class="card" class:on={selected}>
	<button class="main" onclick={onpick} aria-pressed={selected}>
		<span class="portrait">
			{#if portrait && portraitOk}<img src={portrait} alt="" onerror={() => (portraitOk = false)} />{:else}<span class="initial">{(c.name || '?')[0]}</span>{/if}
			{#if classIcon && classOk}<img class="cls" src={classIcon} alt="" onerror={() => (classOk = false)} />{/if}
			<span class="lv" title="Level">{c.level ?? '?'}</span>
		</span>
		<span class="text">
			<span class="n"><b class="dot" style:background={color}></b>{fullName(c)}</span>
			<span class="sub">{raceName(c.race)} {className(c.class)}{realm ? ` · ${realm}` : ''}{c.money != null ? ` · ${gold(c.money)}` : ''}</span>
			{#if xpPct != null}
				<span class="xp" title="{c.xp} / {c.xpMax} XP{c.rested ? ` · ${c.rested} rested` : ''}">
					<span class="fill" style:width="{xpPct}%"></span><span class="rest" style:left="{xpPct}%" style:width="{restedPct}%"></span>
				</span>
			{/if}
			<span class="seen">{where}{c.last ? `${where ? ' · ' : ''}${ago(c.last)}` : ''}</span>
		</span>
	</button>
	<div class="actions">
		<button disabled={!c.snapshotAt} title={c.snapshotAt ? 'Gear: the character sheet' : 'No snapshot yet: needs the Polestar_DashSnapshot addon'} onclick={() => onopen('gear')}>Gear</button>
		<button disabled={!c.snapshotAt} title={c.snapshotAt ? 'Bags and bank' : 'No snapshot yet: needs the Polestar_DashSnapshot addon'} onclick={() => onopen('bags')}>Bags</button>
	</div>
</li>

<style>
	.card { border-radius: 10px; margin-bottom: 4px; }
	.card.on { background: var(--selected); box-shadow: inset 2px 0 0 var(--accent); }
	.card:not(.on):hover { background: var(--hover); }
	.main { all: unset; box-sizing: border-box; width: 100%; display: grid; grid-template-columns: 48px 1fr; gap: 10px; padding: 10px 10px 4px; cursor: pointer; border-radius: 10px; }
	.main:focus-visible { outline: 1px solid var(--focus); }
	.portrait { position: relative; width: 48px; height: 48px; }
	.portrait > img:first-child, .initial { width: 48px; height: 48px; border-radius: 50%; display: grid; place-items: center; object-fit: cover; box-shadow: 0 0 0 2px var(--border); background: var(--well); font-weight: 700; font-size: 18px; color: var(--textDim); }
	.card.on .portrait > img:first-child { box-shadow: 0 0 0 2px var(--accent); }
	.cls { position: absolute; right: -4px; bottom: -2px; width: 20px; height: 20px; border-radius: 50%; box-shadow: 0 0 0 2px var(--sidebar); }
	.lv { position: absolute; left: -4px; bottom: -2px; min-width: 20px; height: 18px; padding: 0 4px; border-radius: 9px; background: var(--sidebar); color: var(--accent); font-size: 11px; font-weight: 700; display: grid; place-items: center; box-shadow: 0 0 0 1px var(--border); font-variant-numeric: tabular-nums; }
	.text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
	.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: 1px; }
	.n { font-weight: 700; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.sub { color: var(--textDim); font-size: 12px; }
	.seen { color: var(--textMuted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.xp { position: relative; height: 4px; border-radius: 2px; background: var(--track); overflow: hidden; margin: 3px 0 2px; }
	.fill { position: absolute; left: 0; top: 0; bottom: 0; background: var(--dungeon, #a385ff); }
	.rest { position: absolute; top: 0; bottom: 0; background: var(--npc); opacity: 0.55; }
	.actions { display: flex; gap: 6px; padding: 2px 10px 10px 68px; }
	.actions button { background: var(--chip); border: 0; border-radius: 6px; padding: 3px 10px; font-size: 11px; color: var(--textDim); }
	.actions button:disabled { opacity: 0.45; cursor: default; }
</style>
