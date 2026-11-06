<script lang="ts">
	// The map: Polestar's MapView with the dashboard's trails, pins and events, and the playtime
	// scrubber. The view is redrawn from the state whenever the data or the time changes.
	import { onMount } from 'svelte';
	import { dash, FOCUS_BUFFERS, OVERVIEW_BUFFERS, PIN } from '../lib/dash.svelte';
	import type { DashEvent } from '../lib/api';
	import { continentOffset, createMapView, type Dot, type MapViewApi, type Marker } from '../lib/mapview';
	import { installWorldMap, mapChoices, mapOf, showMap, shownMap, type MapChoice } from '../lib/worldmap';
	import { inSessions, posAt, split, type Route } from '../lib/timeline';
	import { day, hhmm } from '../lib/format';

	const DOT_TINT: Record<string, string> = { death: 'danger', level: 'success', mark: 'accent', enter: 'dungeon', encounter: 'dungeon' };

	let { visible }: { visible: boolean } = $props();
	let canvas: HTMLCanvasElement;
	let map = $state.raw<MapViewApi | null>(null);
	let noGL = $state(false);
	let info = $state.raw<DashEvent | null>(null);
	let speed = $state(120);
	/** The map shown (Azeroth, or Zephras Isle, a battleground...), and the choices. */
	let shown = $state<MapChoice>('azeroth');
	let choices = $state.raw<{ value: MapChoice; name: string }[]>([]);

	function pickMap(v: string) {
		if (!map) return;
		shown = v === 'azeroth' ? 'azeroth' : Number(v);
		showMap(map, shown);
	}


	onMount(() => {
		const view = createMapView(canvas, { artBase: '/art' });
		view.init()
			.then(() => {
				// One world map far out, zone maps at region scale, terrain close in (lib/worldmap.ts).
				if (!installWorldMap(view)) view.setLayer('zoneArt', true);
				// World mode: Azeroth's continents laid out as the game's world map, other maps one at a time.
				view.setMode('world');
				choices = mapChoices(view);
				shown = shownMap(view);
				view.on('marker', ({ marker }) => {
					if (marker.kind === 'char') dash.run(dash.showFocus(marker.charId as string));
					if (marker.kind === 'event') info = marker.ev as DashEvent;
				});
				view.on('pick', ({ hit }) => {
					if (!hit) info = null;
				});
				map = view;
			})
			.catch(() => (noGL = true));
		return () => view.destroy();
	});

	// Draw: everything the map shows at dash.t.
	$effect(() => {
		if (!map) return;
		const t = dash.t;
		const live = !!dash.timeline && t >= dash.timeline.end - 1;
		const routes: Route[] = [];
		const markers: Marker[] = [];
		const dots: Dot[] = [];
		let arrow = null;
		if (dash.mode === 'overview' && dash.overview) {
			for (const c of dash.overview.characters) {
				split(c.trails, t, routes);
				const p = posAt(c.trails, t);
				const online = inSessions(c.sessions, t);
				if (p) markers.push({ kind: 'char', charId: c.char, step: c.char, c: p.c, wx: p.wx, wy: p.wy, icon: null, glyph: 'character', tint: online ? 'npc' : 'textMuted', label: dash.name(c.char), active: online || live, done: !online && !live });
				for (const e of c.events) if (e.t <= t && e.pos?.c !== undefined) dots.push({ c: e.pos.c, wx: e.pos.wx!, wy: e.pos.wy!, tint: DOT_TINT[e.kind] || 'textDim' });
			}
		} else if (dash.mode === 'focus' && dash.focus) {
			const f = dash.focus;
			split(f.trails, t, routes);
			arrow = posAt(f.trails, t);
			for (const c of dash.overview?.characters ?? []) {
				if (c.char === f.id) continue;
				const p = posAt(c.trails, t);
				if (p) markers.push({ kind: 'char', charId: c.char, step: c.char, c: p.c, wx: p.wx, wy: p.wy, icon: null, glyph: 'character', tint: 'textMuted', label: dash.name(c.char), done: true });
			}
			for (const e of f.events) {
				if (e.t > t || e.pos?.c === undefined) continue;
				const [glyph, tint] = PIN[e.kind] ?? ['icon-note', 'textDim'];
				markers.push({ kind: 'event', ev: e, step: `${e.kind}:${e.t}`, c: e.pos.c, wx: e.pos.wx!, wy: e.pos.wy!, icon: null, glyph, tint });
			}
		}
		map.setRoute(routes);
		map.setScene({ markers, dots });
		map.setCharacter(arrow ? { c: arrow.c, wx: arrow.wx, wy: arrow.wy, heading: arrow.heading } : null);
	});

	// Fit the view when new data asks for it: the trails on the map with the most of them (Azeroth, or
	// an other map such as Zephras Isle, which is then shown). MapView fits points of one continent,
	// so Azeroth's other continent is carried into its frame through the layout's offsets. A short
	// trail fits close in, where the terrain shows (lib/worldmap.ts).
	$effect(() => {
		dash.fitRequest;
		if (!map) return;
		const trails = dash.mode === 'focus' ? (dash.focus?.trails ?? []) : (dash.overview?.characters ?? []).flatMap((c) => c.trails);
		if (!trails.length) return;
		const byMap = new Map<string, number>();
		for (const s of trails) byMap.set(String(mapOf(map, s.c)), (byMap.get(String(mapOf(map, s.c))) ?? 0) + s.ts.length);
		const best = [...byMap.entries()].sort((a, b) => b[1] - a[1])[0][0];
		// A local, not `shown`: reading `shown` here would re-run this fit whenever the player picks a map.
		const choice: MapChoice = best === 'azeroth' ? 'azeroth' : Number(best);
		shown = choice;
		showMap(map, choice, false);
		const mine = trails.filter((s) => String(mapOf(map!, s.c)) === best);
		const by = new Map<number, number>();
		for (const s of mine) by.set(s.c, (by.get(s.c) ?? 0) + s.ts.length);
		const c0 = [...by.entries()].sort((a, b) => b[1] - a[1])[0][0];
		const o0 = continentOffset(map, c0);
		const pairs: [number, number][] = [];
		for (const s of mine) {
			const o = s.c === c0 ? o0 : continentOffset(map, s.c);
			if (s.c !== c0 && !(o && o0)) continue;
			// plane x = -wy + ox, y = -wx + oy: the same plane point seen from continent c0.
			const dwy = s.c === c0 ? 0 : o!.ox - o0!.ox, dwx = s.c === c0 ? 0 : o!.oy - o0!.oy;
			for (let i = 0; i < s.pts.length; i += 2) pairs.push([s.pts[i] - dwx, s.pts[i + 1] - dwy]);
		}
		map.fitWorld(c0, pairs, { padding: 90, maxZoom: 1.2 });
		info = null;
	});

	// The map was hidden behind the journal: re-measure when it shows again.
	$effect(() => {
		if (visible) map?.resize();
	});

	// Playback over playtime.
	$effect(() => {
		if (!dash.playing || !dash.timeline) return;
		const tl = dash.timeline;
		if (dash.t >= tl.end) dash.t = tl.start;
		let last = 0;
		let raf = requestAnimationFrame(function tick(now) {
			const dt = last ? (now - last) / 1000 : 0;
			last = now;
			dash.t = tl.advance(dash.t, dt * speed);
			if (dash.t >= tl.end) dash.playing = false;
			else raf = requestAnimationFrame(tick);
		});
		return () => cancelAnimationFrame(raf);
	});

	const live = $derived(!!dash.timeline && dash.t >= dash.timeline.end - 1);
	const offline = $derived(dash.mode === 'focus' && !!dash.focus && !inSessions(dash.focus.sessions, dash.t));
	const sliderValue = $derived(dash.timeline ? Math.round(dash.timeline.toU(dash.t) * 1000) : 1000);
	const ticks = $derived(dash.timeline?.ticks() ?? []);
	const buffers = $derived.by((): [string, string][] => {
		if (dash.mode === 'overview') return OVERVIEW_BUFFERS.map(([h, l]) => [String(h), l]);
		const f = dash.focus;
		return f?.buffer.startsWith('s:') ? [[f.buffer, `Session ${day(f.from)} ${hhmm(f.from)}`], ...FOCUS_BUFFERS] : FOCUS_BUFFERS;
	});
	const bufferValue = $derived(dash.mode === 'overview' ? String(dash.overview?.hours ?? 6) : (dash.focus?.buffer ?? 'session'));

	function setBuffer(v: string) {
		dash.run(dash.mode === 'overview' ? dash.showOverview(Number(v)) : dash.showFocus(dash.focus!.id, v));
	}

	function scrub(v: number) {
		dash.playing = false;
		if (dash.timeline) dash.t = dash.timeline.toT(v / 1000);
	}
</script>

<section class="pane" class:on={visible}>
	<canvas bind:this={canvas}></canvas>
	{#if choices.length > 1}
		<select class="mapsel" aria-label="Map" value={String(shown)} onchange={(e) => pickMap(e.currentTarget.value)}>
			{#each choices as c (c.value)}<option value={String(c.value)}>{c.name}</option>{/each}
		</select>
	{/if}
	<div class="legend">
		<span><b class="sw route"></b>trail</span>
		<span><b class="sw ghost"></b>ghost run</span>
		{#if dash.mode === 'overview'}
			<span><b class="dot success"></b>level</span><span><b class="dot danger"></b>death</span><span><b class="dot accent"></b>mark</span>
		{:else}
			<span><b class="dot quest"></b>events: click a pin</span>
		{/if}
	</div>
	{#if info}
		<div class="info"><time>{day(info.t)} {hhmm(info.t)} · {dash.name(info.char)}</time>{info.text}</div>
	{/if}
	<div class="player">
		<select aria-label="How much playtime to show" value={bufferValue} onchange={(e) => setBuffer(e.currentTarget.value)}>
			{#each buffers as [v, label] (v)}<option value={v}>{label}</option>{/each}
		</select>
		<button class="play" aria-label={dash.playing ? 'Pause' : 'Play'} onclick={() => (dash.playing = !dash.playing)}>
			<img src={dash.playing ? '/glyph/pause.png' : '/glyph/play.png'} alt="" />
		</button>
		<div class="scrub">
			<input type="range" min="0" max="1000" value={sliderValue} aria-label="Time (playtime; offline gaps skipped)" oninput={(e) => scrub(Number(e.currentTarget.value))} />
			<div class="ticks">{#each ticks as u, i (i)}<b style:left="{(u * 100).toFixed(2)}%"></b>{/each}</div>
		</div>
		<time class="clock">{dash.t ? `${day(dash.t)} ${hhmm(dash.t)}${live ? ' · latest' : offline ? ' · offline' : ''}` : ''}</time>
		<select aria-label="Speed" bind:value={speed}>
			<option value={30}>30×</option><option value={120}>120×</option><option value={600}>600×</option>
		</select>
	</div>
	{#if noGL}<div class="nomap">WebGL2 is not available in this browser.</div>{/if}
</section>

<style>
	.pane { display: none; position: relative; min-height: 0; height: 100%; }
	.pane.on { display: block; }
	canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; }
	.mapsel { position: absolute; top: 12px; left: 12px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 5px 8px; font-weight: 600; box-shadow: var(--window-shadow); }
	.info { top: 52px !important; }
	.legend { position: absolute; top: 12px; right: 12px; display: flex; gap: 12px; flex-wrap: wrap; padding: 6px 10px; border-radius: 8px; background: var(--well); font-size: 11px; color: var(--textDim); pointer-events: none; }
	.legend span { display: inline-flex; align-items: center; gap: 5px; }
	.sw { display: inline-block; width: 16px; height: 3px; border-radius: 2px; }
	.sw.route { background: var(--route-past); }
	.sw.ghost { background: var(--route-fly); }
	.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
	.dot.danger { background: var(--danger); }
	.dot.success { background: var(--success); }
	.dot.quest { background: var(--quest); }
	.dot.accent { background: var(--accent); }
	.info { position: absolute; top: 12px; left: 12px; max-width: min(360px, calc(100% - 24px)); padding: 10px 12px; border-radius: 8px; background: var(--panel); border: 1px solid var(--border); box-shadow: var(--window-shadow); }
	.info time { display: block; color: var(--textMuted); font-size: 11px; }
	.player { position: absolute; left: 12px; right: 12px; bottom: 12px; display: flex; gap: 10px; align-items: center; padding: 8px 12px; border-radius: 10px; background: var(--panel); border: 1px solid var(--border); box-shadow: var(--window-shadow); }
	select { background: var(--well); border: 1px solid var(--border); border-radius: 6px; padding: 4px 6px; }
	.play { width: 30px; height: 30px; border-radius: 50%; border: 0; background: var(--accent); display: grid; place-items: center; flex: none; }
	.play img { width: 16px; height: 16px; filter: brightness(0); }
	.scrub { flex: 1; position: relative; min-width: 60px; display: flex; align-items: center; }
	.scrub input { width: 100%; accent-color: var(--accent); margin: 0; }
	.ticks { position: absolute; left: 8px; right: 8px; top: -6px; height: 4px; pointer-events: none; }
	.ticks b { position: absolute; top: 0; width: 1px; height: 5px; background: var(--textMuted); }
	.clock { min-width: 120px; text-align: right; color: var(--textDim); font-variant-numeric: tabular-nums; }
	.nomap { position: absolute; inset: 0; display: grid; place-items: center; color: var(--textDim); }
	@media (max-width: 720px) {
		.legend { display: none; }
		.player { flex-wrap: wrap; gap: 8px; }
		.player > select:first-child { flex: 1 1 100%; min-width: 0; }
		.clock { min-width: 0; font-size: 11px; text-align: left; order: 5; flex: 1 1 auto; }
	}
</style>
