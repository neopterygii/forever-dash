<script lang="ts">
	// People met: the players our characters grouped, traded, duelled or fought with, or looked at
	// long enough (Polestar_DashSnapshot's People.lua), in a window over the page. The list (by the
	// selected character, or by any) and a player's card: what they looked like when last seen,
	// your rating and notes, every meeting.
	import { api, type How, type PersonDetail, type PersonRow } from '../lib/api';
	import { dash } from '../lib/dash.svelte';
	import { ago, className, classColor, classIconUrl, day, hhmm, portraitUrl, raceName } from '../lib/format';

	const open = $derived(dash.people);
	const focusId = $derived(dash.mode === 'focus' ? dash.focus?.id : undefined);
	/** List the selected character's people only (when one is selected). */
	let mineOnly = $state(true);
	const byChar = $derived(focusId && mineOnly ? focusId : undefined);

	let rows = $state.raw<PersonRow[] | null>(null);
	let detail = $state.raw<PersonDetail | null | undefined>(undefined);
	let search = $state('');
	let filter = $state<'all' | 'group' | 'trade' | 'duel' | 'pvp' | 'rated'>('all');
	let reload = $state(0);
	let noteText = $state('');
	let saving = $state(false);
	let saved = $state(false);

	$effect(() => {
		reload;
		if (!open || open.who) return;
		const c = byChar;
		let stale = false;
		api.people(c).then((r) => {
			if (!stale) rows = r;
		});
		return () => (stale = true);
	});

	$effect(() => {
		const who = open?.who;
		if (!who) return;
		let stale = false;
		detail = undefined;
		saved = false;
		api.person(who).then((p) => {
			if (stale) return;
			detail = p;
			noteText = p?.note ?? '';
		});
		return () => (stale = true);
	});

	const PVP: How[] = ['fought', 'killedby', 'killed'];
	const shown = $derived.by(() => {
		const s = search.trim().toLowerCase();
		return (rows ?? []).filter((p) => {
			if (s && !`${p.name} ${p.realm ?? ''} ${p.guild ?? ''}`.toLowerCase().includes(s)) return false;
			if (filter === 'pvp') return PVP.some((h) => p.hows[h]);
			if (filter === 'rated') return !!p.rating || !!p.note;
			return filter === 'all' || !!p.hows[filter];
		});
	});

	/** "Grouped 3 · traded 1 · duels 2": how they were met, most telling first. */
	const HOW_LABEL: [How, string][] = [['group', 'grouped'], ['trade', 'traded'], ['duel', 'duels'], ['killed', 'killed'], ['killedby', 'killed you'], ['fought', 'fights'], ['seen', 'seen']];
	const howLine = (p: PersonRow) => HOW_LABEL.filter(([h]) => p.hows[h]).map(([h, l]) => `${l} ${p.hows[h]}`).join(' · ');
	const looks = (p: { level: number | null; race: string | null; class: string | null }) =>
		[p.level ? `Level ${p.level}` : '', raceName(p.race), className(p.class)].filter(Boolean).join(' ');

	function close() {
		dash.people = null;
	}
	function onkey(e: KeyboardEvent) {
		if (e.key !== 'Escape' || !dash.people) return;
		e.preventDefault();
		if (dash.people.who) dash.people = { who: null };
		else close();
	}

	async function save(rating: number, note: string) {
		if (!detail) return;
		saving = true;
		try {
			await api.setPerson(detail.who, rating, note);
			detail = { ...detail, rating: rating || null, note: note.trim() || null };
			saved = true;
			reload++;
		} finally {
			saving = false;
		}
	}
	const rate = (n: number) => dash.run(save(detail?.rating === n ? 0 : n, detail?.note ?? ''));
</script>

<svelte:window onkeydown={onkey} />

{#if open}
	<div class="backdrop" role="presentation" onclick={close}></div>
	<div class="window" role="dialog" aria-modal="true" aria-label="People met">
		{#if !open.who}
			<header>
				<div class="title">
					<h2>People met</h2>
					<span>{byChar ? `by ${dash.name(byChar)}` : 'by all characters'}{rows ? ` · ${rows.length}` : ''}</span>
				</div>
				{#if focusId}
					<nav>
						<button class:on={mineOnly} onclick={() => (mineOnly = true)}>{dash.name(focusId)}</button>
						<button class:on={!mineOnly} onclick={() => (mineOnly = false)}>Everyone's</button>
					</nav>
				{/if}
				<button class="close" aria-label="Close" onclick={close}>×</button>
			</header>
			<div class="tools">
				<input type="search" placeholder="Name, realm or guild" bind:value={search} aria-label="Search people" />
				<div class="chips">
					{#each [['all', 'All'], ['group', 'Grouped'], ['trade', 'Traded'], ['duel', 'Duels'], ['pvp', 'PvP'], ['rated', 'Rated']] as [k, label] (k)}
						<button class:on={filter === k} onclick={() => (filter = k as typeof filter)}>{label}</button>
					{/each}
				</div>
			</div>
			{#if rows === null}
				<p class="empty">Loading…</p>
			{:else if !rows.length}
				<p class="empty">{byChar ? `${dash.name(byChar)} hasn't met anyone yet.` : 'Nobody yet.'} Players you group, trade or duel with, fight, or look at for a few seconds are noted by the Polestar_DashSnapshot addon, from its next login.</p>
			{:else if !shown.length}
				<p class="empty">Nobody matches.</p>
			{:else}
				<ul class="list">
					{#each shown as p (p.who)}
						<li>
							<button class="row" onclick={() => (dash.people = { who: p.who })}>
								{#if classIconUrl(p.class)}<img class="cls" src={classIconUrl(p.class)} alt="" />{:else}<span class="cls none"></span>{/if}
								<span class="main">
									<span class="nm" style:color={classColor(p.class)}>{p.name}{#if p.ours}<em class="ours">ours</em>{/if}</span>
									<span class="sub">{looks(p)}{p.guild ? ` · <${p.guild}>` : ''}</span>
									<span class="how">{howLine(p)}</span>
								</span>
								<span class="side">
									{#if p.rating}<span class="stars" aria-label="{p.rating} of 5">{'★'.repeat(p.rating)}</span>{/if}
									<span class="ago">{ago(p.last)}</span>
								</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		{:else}
			<header>
				<button class="back" onclick={() => (dash.people = { who: null })}><i></i>People</button>
				<button class="close" aria-label="Close" onclick={close}>×</button>
			</header>
			{#if detail === undefined}
				<p class="empty">Loading…</p>
			{:else if detail === null}
				<p class="empty">Not found.</p>
			{:else}
				{@const p = detail}
				<div class="card">
					{#if portraitUrl(p.race, p.sex)}<img class="portrait" src={portraitUrl(p.race, p.sex)} alt="" />{/if}
					<div class="who">
						<h2 style:color={classColor(p.class)}>{p.name}{#if p.ours}<em class="ours">one of ours</em>{/if}</h2>
						<span>{looks(p)}{p.realm ? ` · ${p.realm}` : ''}</span>
						{#if p.guild || p.faction}<span>{p.guild ? `<${p.guild}>` : ''}{p.guild && p.faction ? ' · ' : ''}{p.faction ?? ''}</span>{/if}
						{#if p.seen}<small>As last seen {day(p.seen)} {hhmm(p.seen)}</small>{/if}
					</div>
				</div>
				<div class="rating" role="group" aria-label="Your rating">
					{#each [1, 2, 3, 4, 5] as n (n)}
						<button class:on={(p.rating ?? 0) >= n} aria-label="{n} of 5" aria-pressed={(p.rating ?? 0) === n} disabled={saving} onclick={() => rate(n)}>★</button>
					{/each}
					<span>{p.rating ? 'Your rating (tap it again to clear)' : 'Rate this player'}</span>
				</div>
				<form class="notes" onsubmit={(e) => { e.preventDefault(); dash.run(save(p.rating ?? 0, noteText)); }}>
					<textarea rows="3" maxlength="4000" placeholder="Your notes about {p.name}…" bind:value={noteText} oninput={() => (saved = false)} aria-label="Your notes"></textarea>
					<div class="bar">
						<span>{saved ? 'Saved' : ''}</span>
						<button disabled={saving || noteText.trim() === (p.note ?? '')}>Save notes</button>
					</div>
				</form>
				<h3>Met {p.met.length} {p.met.length === 1 ? 'time' : 'times'}</h3>
				<ul class="met">
					{#each p.met as m, i (i)}
						<li class="h-{m.how}">
							<time>{day(m.t)} {hhmm(m.t)}</time>
							<span class="t">{m.text}{m.zone ? ` · ${m.zone}` : ''}</span>
							<span class="by" style:color={dash.colorOf(m.char)}>{dash.name(m.char)}</span>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</div>
{/if}

<style>
	.backdrop { position: fixed; inset: 0; background: color-mix(in srgb, var(--scrim) 55%, transparent); z-index: 20; }
	.window { position: fixed; z-index: 21; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(560px, calc(100vw - 24px)); height: min(680px, calc(100vh - 24px)); overflow: auto; background: var(--panel); border: 1px solid var(--border); border-radius: 14px; box-shadow: var(--window-shadow); padding: 14px 16px 18px; box-sizing: border-box; }
	header { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
	.title { display: flex; flex-direction: column; min-width: 0; flex: 1; }
	h2 { font-size: 16px; }
	.title span { color: var(--textDim); font-size: 12px; }
	nav { display: flex; gap: 2px; padding: 3px; border-radius: 8px; background: var(--well); min-width: 0; }
	nav button { background: none; border: 0; border-radius: 6px; padding: 4px 10px; color: var(--textDim); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 160px; }
	nav button.on { background: var(--selected); color: var(--text); }
	.close { background: none; border: 0; font-size: 22px; line-height: 1; color: var(--textDim); padding: 0 4px; margin-left: auto; }
	.back { display: inline-flex; align-items: center; gap: 4px; background: var(--chip); border: 0; padding: 6px 10px 6px 6px; border-radius: 8px; color: var(--text); font-weight: 600; cursor: pointer; }
	.back i { width: 14px; height: 14px; background: currentColor; mask: url(/glyph/chevron-left.png) center / contain no-repeat; -webkit-mask: url(/glyph/chevron-left.png) center / contain no-repeat; }
	.empty { color: var(--textDim); text-align: center; margin: 30px 8px; line-height: 1.5; }

	.tools { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
	.tools input { background: var(--well); border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; color: var(--text); font: inherit; }
	.chips { display: flex; flex-wrap: wrap; gap: 6px; }
	.chips button { background: var(--chip); border: 0; border-radius: 999px; padding: 3px 12px; font-size: 12px; color: var(--textDim); font-weight: 600; }
	.chips button.on { background: var(--accent); color: var(--onAccent); }

	.list { list-style: none; margin: 0; padding: 0; }
	.row { all: unset; box-sizing: border-box; width: 100%; display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 8px; border-radius: 8px; cursor: pointer; }
	.row:hover { background: var(--hover); }
	.row:focus-visible { outline: 1px solid var(--focus); }
	.cls { width: 32px; height: 32px; border-radius: 50%; }
	.cls.none { background: var(--chip); }
	.main { display: flex; flex-direction: column; min-width: 0; }
	.nm { font-weight: 700; font-size: 14px; }
	.sub, .how { font-size: 12px; color: var(--textDim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.how { color: var(--textMuted); }
	.side { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
	.stars { color: var(--accent); font-size: 12px; letter-spacing: 1px; }
	.ago { font-size: 11px; color: var(--textMuted); white-space: nowrap; }
	.ours { font-style: normal; font-size: 10px; font-weight: 700; text-transform: uppercase; margin-left: 6px; padding: 1px 6px; border-radius: 999px; background: var(--chip); color: var(--textDim); vertical-align: 2px; }

	.card { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; }
	.portrait { width: 56px; height: 56px; border-radius: 50%; box-shadow: 0 0 0 2px var(--border); }
	.who { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
	.who span { color: var(--textDim); font-size: 12px; }
	.who small { color: var(--textMuted); font-size: 11px; }
	.rating { display: flex; align-items: center; gap: 2px; margin-bottom: 10px; }
	.rating button { background: none; border: 0; padding: 2px 3px; font-size: 22px; line-height: 1; color: var(--textMuted); cursor: pointer; }
	.rating button.on { color: var(--accent); }
	.rating span { margin-left: 8px; font-size: 12px; color: var(--textMuted); }
	.notes textarea { width: 100%; box-sizing: border-box; background: var(--well); border: 1px solid var(--border); border-radius: 8px; padding: 8px; color: var(--text); font: inherit; font-size: 13.5px; line-height: 1.5; resize: vertical; }
	.notes .bar { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 6px; }
	.notes .bar span { font-size: 12px; color: var(--success); margin-right: auto; }
	.notes .bar button { background: var(--chip); border: 0; border-radius: 6px; padding: 5px 12px; color: var(--accent); font-weight: 600; }
	.notes .bar button:disabled { color: var(--textMuted); }
	h3 { font-size: 14px; margin: 16px 0 8px; }
	.met { list-style: none; margin: 0; padding: 0; font-size: 13px; }
	.met li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; padding: 5px 0; border-bottom: 1px solid var(--divider); align-items: baseline; }
	.met time { color: var(--textMuted); font-size: 12px; white-space: nowrap; }
	.met .by { font-size: 12px; font-weight: 600; white-space: nowrap; }
	.met li.h-fought .t, .met li.h-killedby .t, .met li.h-killed .t { color: var(--danger); }
	@media (max-width: 520px) {
		/* The character / everyone switch under the title, so the title stays on one line. */
		header { flex-wrap: wrap; }
		header nav { order: 3; flex: 1 1 100%; }
		header nav button { flex: 1; max-width: none; }
		.met li { grid-template-columns: minmax(0, 1fr) auto; }
		.met time { grid-column: 1 / -1; }
	}
</style>
