<script lang="ts">
	import { dash } from '../lib/dash.svelte';
	import { ago } from '../lib/format';
	import CharacterCard from './CharacterCard.svelte';

	/** A PC has gone quiet when it sent nothing for this long while another has uploaded since (seconds). */
	const QUIET = 3 * 24 * 3600;
	const pcs = $derived(
		dash.uploads.map((u, i) => ({
			...u,
			names: u.chars.map((id) => dash.chars.find((c) => c.id === id)?.name ?? '?').join(', '),
			quiet: i > 0 && dash.uploads[0].received - u.received > QUIET,
		})),
	);

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
	{#if pcs.length || dash.access?.group}
		<footer class="stats">
			{#if pcs.length}
				<ul class="pcs" aria-label="Uploads, by PC">
					{#each pcs as p, i (i)}
						<li class:quiet={p.quiet} title="{p.quiet ? 'This PC has sent nothing for a while: is its client running? ' : ''}Latest play it sent: {ago(p.last)}">
							<b></b><span class="pn">{p.names}</span><span class="pa">uploaded {ago(p.received)}</span>
						</li>
					{/each}
				</ul>
			{/if}
			{#if dash.access?.group}<span class="grp">{dash.access.group} · <button onclick={() => dash.run(dash.signOut())}>Sign out</button></span>{/if}
		</footer>
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
	.stats { display: grid; gap: 6px; padding: 12px 16px; color: var(--textMuted); font-size: 11px; border-top: 1px solid var(--border); }
	.pcs { list-style: none; margin: 0; padding: 0; display: grid; gap: 3px; }
	.pcs li { display: flex; align-items: center; gap: 6px; min-width: 0; }
	.pcs b { flex: none; width: 6px; height: 6px; border-radius: 50%; background: #6bd999; }
	.pcs .pn { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--textDim); }
	.pcs .pa { flex: none; }
	.pcs li.quiet b { background: var(--danger); }
	.pcs li.quiet .pa { color: var(--danger); }
	.grp button { all: unset; color: var(--accent); cursor: pointer; font-weight: 600; }
	.grp button:hover { text-decoration: underline; }
	.grp button:focus-visible { outline: 1px solid var(--focus); }
	@media (max-width: 720px) {
		.side { max-height: 32vh; border-right: 0; border-bottom: 1px solid var(--border); }
		/* Phones: only who is signed in, to sign out. */
		.stats { padding: 6px 16px; }
		.stats .pcs { display: none; }
		.grp button { padding: 8px 6px; margin: -8px -6px; }
		.stats:not(:has(.grp)) { display: none; }
	}
</style>
