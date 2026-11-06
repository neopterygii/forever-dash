<script lang="ts">
	// One character in the sidebar: portrait, name, level and class, where and when, gold, health and
	// power, XP; picks the focus; opens gear, bags and stats; star (listed first) and hide (off the map).
	import type { Character } from '../lib/api';
	import { dash } from '../lib/dash.svelte';
	import { ago, className, classColor, classIconUrl, coins, fullName, portraitUrl, powerColor, raceName, realmName } from '../lib/format';

	let { c, selected, color, onpick, onopen }: { c: Character; selected: boolean; color: string; onpick: () => void; onopen: (view: 'gear' | 'bags' | 'stats') => void } = $props();

	const portrait = $derived(portraitUrl(c.race, c.sex));
	const classIcon = $derived(classIconUrl(c.class));
	const xpPct = $derived(c.xp != null && c.xpMax ? Math.min(100, (100 * c.xp) / c.xpMax) : null);
	const restedPct = $derived(xpPct != null && c.rested && c.xpMax ? Math.min(100 - xpPct, (100 * c.rested) / c.xpMax) : 0);
	const where = $derived(c.lastPos?.zone ? [c.lastPos.subzone, c.lastPos.zone].filter(Boolean).join(' · ') : '');
	const realm = $derived(realmName(c.realmName ?? c.realm));
	const money = $derived(coins(c.money));
	const v = $derived(c.vitals);
	/** Seen in the last ten minutes: probably still playing (the client uploads at logout or /reload). */
	const recent = $derived(!!c.last && Date.now() / 1000 - c.last < 600);
	const starred = $derived(dash.starred.includes(c.id));
	const hidden = $derived(dash.hidden.includes(c.id));
	let portraitOk = $state(true);
	let classOk = $state(true);
</script>

<li class="card" class:on={selected} class:dim={hidden}>
	<button class="main" onclick={onpick} aria-pressed={selected}>
		<span class="portrait">
			{#if portrait && portraitOk}<img src={portrait} alt="" onerror={() => (portraitOk = false)} />{:else}<span class="initial">{(c.name || '?')[0]}</span>{/if}
			{#if classIcon && classOk}<img class="cls" src={classIcon} alt="" onerror={() => (classOk = false)} />{/if}
		</span>
		<span class="text">
			<span class="row1">
				<span class="n"><b class="dot" style:background={color}></b>{fullName(c)}</span>
				<span class="lvl">Level {c.level ?? '?'} <b style:color={classColor(c.class)}>{className(c.class)}</b></span>
			</span>
			<span class="row2">
				<span class="where">{where || realm}</span>
				<span class="race">{raceName(c.race)}</span>
			</span>
			<span class="seen"><b class="status" class:live={recent}></b>{c.last ? `Last seen ${ago(c.last)}` : 'Not seen yet'}</span>
			<span class="vitals">
				{#if money}
					<span class="coins" title="Gold">
						<b class="g">{money.g}g</b> <b class="s">{money.s}s</b> <b class="c">{money.c}c</b>
					</span>
				{/if}
				{#if v?.health}<span class="hp" title="Maximum health">♥ {v.health}</span>{/if}
				{#if v?.power}<span class="pw" style:color={powerColor(v.powerType)} title="Maximum {(v.powerType ?? 'power').toLowerCase()}">◆ {v.power}</span>{/if}
			</span>
			{#if xpPct != null}
				<span class="xp" title="{c.xp} / {c.xpMax} XP{c.rested ? ` · ${c.rested} rested` : ''}">
					<span class="fill" style:width="{xpPct}%"></span><span class="rest" style:left="{xpPct}%" style:width="{restedPct}%"></span>
				</span>
			{/if}
		</span>
	</button>
	<div class="actions">
		<button disabled={!c.snapshotAt} title={c.snapshotAt ? 'Gear: the character sheet' : 'No snapshot yet: needs the Polestar_DashSnapshot addon'} onclick={() => onopen('gear')}>Gear</button>
		<button disabled={!c.snapshotAt} title={c.snapshotAt ? 'Bags and bank' : 'No snapshot yet'} onclick={() => onopen('bags')}>Bags</button>
		<button disabled={!c.vitals} title={c.vitals ? 'Attributes' : 'No attributes yet'} onclick={() => onopen('stats')}>Stats</button>
		<span class="spacer"></span>
		<button class="icon" class:active={starred} aria-pressed={starred} title={starred ? 'Starred: listed first' : 'Star: list first'} onclick={() => dash.toggle('starred', c.id)}>{starred ? '★' : '☆'}</button>
		<button class="icon" class:active={hidden} aria-pressed={hidden} title={hidden ? 'Hidden from the map: show' : 'Hide from the map'} onclick={() => dash.toggle('hidden', c.id)}>{hidden ? '⊘' : '◉'}</button>
	</div>
</li>

<style>
	.card { border-radius: 10px; margin-bottom: 4px; }
	.card.on { background: var(--selected); box-shadow: inset 2px 0 0 var(--accent); }
	.card:not(.on):hover { background: var(--hover); }
	.card.dim .main { opacity: 0.55; }
	.main { all: unset; box-sizing: border-box; width: 100%; display: grid; grid-template-columns: 44px 1fr; gap: 10px; padding: 10px 10px 4px; cursor: pointer; border-radius: 10px; }
	.main:focus-visible { outline: 1px solid var(--focus); }
	.portrait { position: relative; width: 44px; height: 44px; }
	.portrait > img:first-child, .initial { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; object-fit: cover; box-shadow: 0 0 0 2px var(--border); background: var(--well); font-weight: 700; font-size: 18px; color: var(--textDim); }
	.card.on .portrait > img:first-child { box-shadow: 0 0 0 2px var(--accent); }
	.cls { position: absolute; right: -4px; bottom: -2px; width: 18px; height: 18px; border-radius: 50%; box-shadow: 0 0 0 2px var(--sidebar); }
	.text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
	.row1, .row2 { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; min-width: 0; }
	.n { font-weight: 700; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
	.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; vertical-align: 1px; }
	.lvl { font-size: 11px; color: var(--textDim); white-space: nowrap; }
	.lvl b { font-weight: 700; }
	.where { color: var(--textDim); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
	.race { color: var(--textMuted); font-size: 11px; white-space: nowrap; }
	.seen { color: var(--textMuted); font-size: 11px; display: flex; align-items: center; gap: 5px; }
	.status { width: 7px; height: 7px; border-radius: 50%; background: var(--textMuted); }
	.status.live { background: var(--success); box-shadow: 0 0 6px var(--success); }
	.vitals { display: flex; gap: 10px; font-size: 11px; font-variant-numeric: tabular-nums; margin-top: 1px; }
	.coins b { font-weight: 600; }
	.g { color: #ffd700; }
	.s { color: #c7c7cf; }
	.c { color: #d7894a; }
	.hp { color: #ff6b6b; }
	.xp { position: relative; height: 5px; border-radius: 3px; background: var(--track); overflow: hidden; margin: 4px 0 2px; background-image: repeating-linear-gradient(90deg, transparent 0 calc(10% - 1px), color-mix(in srgb, var(--sidebar) 80%, transparent) calc(10% - 1px) 10%); }
	.fill { position: absolute; left: 0; top: 0; bottom: 0; background: #a385ff; }
	.rest { position: absolute; top: 0; bottom: 0; background: #3a8cff; opacity: 0.55; }
	.actions { display: flex; gap: 5px; align-items: center; padding: 2px 10px 10px 64px; }
	.actions button { background: var(--chip); border: 0; border-radius: 6px; padding: 3px 9px; font-size: 11px; color: var(--textDim); }
	.actions button:disabled { opacity: 0.45; cursor: default; }
	.actions .spacer { flex: 1; }
	.actions .icon { padding: 2px 6px; font-size: 12px; background: none; }
	.actions .icon.active { color: var(--accent); }
</style>
