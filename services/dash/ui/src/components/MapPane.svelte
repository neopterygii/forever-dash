<script lang="ts">
	// The map: Polestar's MapView with the dashboard's trails, pins and events, and the playtime
	// scrubber. The view is redrawn from the state whenever the data or the time changes.
	import { onMount } from 'svelte';
	import { dash, FOCUS_BUFFERS, OVERVIEW_BUFFERS, PIN } from '../lib/dash.svelte';
	import type { DashEvent } from '../lib/api';
	import { continentOffset, createMapView, type MapViewApi } from '../lib/mapview';
	import { TrailOverlay, type OverlayEvent, type OverlayLine, type OverlayPin } from '../lib/overlay';
	import { installWorldMap, mapChoices, mapOf, showMap, shownMap, type MapChoice } from '../lib/worldmap';
	import { inSessions, posAt, split } from '../lib/timeline';
	import { day, hhmm } from '../lib/format';

	/** Event badge colours (the overview shows level, death and mark; a focus every journal kind). */
	const EVENT_COLOR: Record<string, string> = {
		death: '#f57373', mark: '#e6ba66', accept: '#ffd673', turnin: '#ffd673', explore: '#f5ad85', enter: '#a385ff', encounter: '#a385ff',
		taxi: '#94c9ff', bind: '#94c9ff', learn: '#78dbed', rare: '#ff8052', abandon: '#9ba2b9',
	};
	const OVERVIEW_EVENTS = new Set(['level', 'death', 'mark', 'milestone']);
	const levelOf = (text: string) => /level (\d+)/i.exec(text)?.[1];

	let { visible }: { visible: boolean } = $props();
	let canvas: HTMLCanvasElement;
	let overlayCanvas: HTMLCanvasElement;
	let overlay = $state.raw<TrailOverlay | null>(null);
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
				// Trails, events and pins are ours (lib/overlay.ts), drawn over the map: clicks are hit-tested there.
				view.on('pick', ({ sx, sy }) => {
					const hit = overlay?.hit(sx, sy) ?? null;
					if (hit?.kind === 'pin') dash.run(dash.showFocus(hit.pin.id));
					else if (hit?.kind === 'event') info = hit.event.data as DashEvent;
					else info = null;
				});
				overlay = new TrailOverlay(overlayCanvas, view);
				map = view;
			})
			.catch(() => (noGL = true));
		return () => {
			overlay?.destroy();
			view.destroy();
		};
	});

	// Draw: everything the overlay shows at dash.t.
	$effect(() => {
		if (!overlay) return;
		const t = dash.t;
		const live = !!dash.timeline && t >= dash.timeline.end - 1;
		const lines: OverlayLine[] = [];
		const events: OverlayEvent[] = [];
		const pins: OverlayPin[] = [];
		const addLines = (id: string, trails: Parameters<typeof split>[0]) => {
			const color = dash.colorOf(id);
			const from = lines.length;
			for (const r of split(trails, t)) lines.push({ c: r.c, pts: r.pts, color, faint: r.state === 'future', style: r.mode });
			join(from);
		};
		const addEvents = (list: DashEvent[], id: string, all: boolean) => {
			const mine: OverlayEvent[] = [];
			for (const e of list) {
				if (e.kind === 'milestone' || e.t > t || e.pos?.c === undefined || (!all && !OVERVIEW_EVENTS.has(e.kind))) continue;
				if (e.kind !== 'level' && !EVENT_COLOR[e.kind]) continue;
				mine.push({ c: e.pos.c, wx: e.pos.wx!, wy: e.pos.wy!, kind: e.kind, label: e.kind === 'level' ? levelOf(e.text) : undefined, color: EVENT_COLOR[e.kind] ?? dash.colorOf(id), data: e });
			}
			// Firsts and round numbers: a star of their own, or one on the badge of the event that was
			// the first (a first death, a first flight). Round levels are the level's starburst already.
			for (const m of list) {
				if (m.kind !== 'milestone' || m.milestone === 'level' || m.t > t || m.pos?.c === undefined) continue;
				const on = mine.find((o) => Math.abs((o.data as DashEvent).t - m.t) < 1);
				if (on) {
					const d = on.data as DashEvent;
					on.first = m.text;
					on.data = { ...d, first: d.first ? `${d.first} · ${m.text}` : m.text };
				} else mine.push({ c: m.pos.c, wx: m.pos.wx!, wy: m.pos.wy!, kind: 'milestone', color: '#fff1c2', data: m });
			}
			events.push(...mine);
		};
		// A trail that goes on from one line into the next (walking into riding, past into future)
		// carries the points either side of the join, so the smoothing keeps its direction there.
		const join = (from: number) => {
			for (let i = from + 1; i < lines.length; i++) {
				const a = lines[i - 1], b = lines[i];
				const kin = a.style === b.style || (a.style !== 'ghost' && a.style !== 'flight' && b.style !== 'ghost' && b.style !== 'flight');
				const n = a.pts.length;
				if (a.c !== b.c || !kin || n < 4 || b.pts.length < 4 || a.pts[n - 2] !== b.pts[0] || a.pts[n - 1] !== b.pts[1]) continue;
				a.post = [b.pts[2], b.pts[3]];
				b.pre = [a.pts[n - 4], a.pts[n - 3]];
			}
		};
		const level = (id: string) => dash.chars.find((c) => c.id === id)?.level ?? null;
		if (dash.mode === 'overview' && dash.overview) {
			for (const c of dash.overview.characters) {
				if (dash.hidden.includes(c.char)) continue;
				addLines(c.char, c.trails);
				addEvents(c.events, c.char, false);
				const p = posAt(c.trails, t);
				if (p) pins.push({ id: c.char, c: p.c, wx: p.wx, wy: p.wy, name: dash.name(c.char), level: level(c.char), color: dash.colorOf(c.char), online: inSessions(c.sessions, t) || live });
			}
		} else if (dash.mode === 'focus' && dash.focus) {
			const f = dash.focus;
			for (const c of dash.overview?.characters ?? []) {
				if (c.char === f.id || dash.hidden.includes(c.char)) continue;
				const p = posAt(c.trails, t);
				if (p) pins.push({ id: c.char, c: p.c, wx: p.wx, wy: p.wy, name: dash.name(c.char), level: level(c.char), color: dash.colorOf(c.char), online: false });
			}
			addLines(f.id, f.trails);
			addEvents(f.events, f.id, true);
			const a = posAt(f.trails, t);
			if (a) pins.push({ id: f.id, c: a.c, wx: a.wx, wy: a.wy, name: dash.name(f.id), level: level(f.id), color: dash.colorOf(f.id), online: inSessions(f.sessions, t) || live, heading: a.heading });
		}
		// All play: translucent lines that build up where the character often went (hubs glow).
		overlay.set({ lines, events, pins, dense: dash.mode === 'focus' && dash.focus?.buffer === 'all' });
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
		// With the journal open, its side of the map is kept clear (the panel is 400 px + margins).
		map.fitWorld(c0, pairs, { padding: 90, maxZoom: 1.2, right: dash.journalOpen ? 424 : 0 });
		info = null;
	});

	// A journal event clicked: go to its spot at region-to-ground zoom (zone art meeting the terrain),
	// centred in the part of the map the journal panel leaves visible. Runs after the fit above (the
	// replay's own), so the event wins.
	const EVENT_ZOOM = 0.45;
	$effect(() => {
		const p = dash.focusPoint;
		if (!map || !p) return;
		dash.focusPoint = null;
		const choice = mapOf(map, p.c);
		if (choice !== shown) {
			shown = choice;
			showMap(map, choice, false);
		}
		// Screen x = -wy (east is right): the panel's half width, in yards, shifts the centre east.
		const shift = dash.journalOpen ? 212 / EVENT_ZOOM : 0;
		queueMicrotask(() => map!.setView({ c: p.c, wx: p.wx, wy: p.wy - shift, zoom: EVENT_ZOOM }, { animate: true }));
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
	const legendIds = $derived(dash.mode === 'focus' && dash.focus ? [dash.focus.id] : (dash.overview?.characters.map((c) => c.char).filter((id) => !dash.hidden.includes(id)) ?? []));
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
	<canvas class="overlay" bind:this={overlayCanvas}></canvas>
	{#if choices.length > 1}
		<select class="mapsel" aria-label="Map" value={String(shown)} onchange={(e) => pickMap(e.currentTarget.value)}>
			{#each choices as c (c.value)}<option value={String(c.value)}>{c.name}</option>{/each}
		</select>
	{/if}
	<div class="legend">
		{#each legendIds as id (id)}
			<span><b class="sw" style:background={dash.colorOf(id)}></b>{dash.name(id)}</span>
		{/each}
		<span><b class="sw mount"></b>mounted</span>
		<span><b class="sw flight"></b>flight</span>
		<span><b class="sw ghost"></b>ghost run</span>
		<span><b class="star">★</b>level</span>
		<span><b class="first">★</b>first</span>
	</div>
	{#if info}
		<div class="info"><time>{day(info.t)} {hhmm(info.t)} · {dash.name(info.char)}</time>{#if info.first}<b class="firstline">★ {info.first}</b>{/if}{info.text}</div>
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
	canvas.overlay { pointer-events: none; }
	.mapsel { position: absolute; top: 12px; left: 12px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 5px 8px; font-weight: 600; box-shadow: var(--window-shadow); }
	.info { top: 52px !important; }
	.legend { position: absolute; top: 12px; right: 12px; transition: opacity 0.15s; display: flex; gap: 12px; flex-wrap: wrap; padding: 6px 10px; border-radius: 8px; background: var(--well); font-size: 11px; color: var(--textDim); pointer-events: none; }
	.legend span { display: inline-flex; align-items: center; gap: 5px; }
	.sw { display: inline-block; width: 16px; height: 3px; border-radius: 2px; }
	.sw.mount { height: 6px; background: linear-gradient(var(--textDim) 0 2.4px, #fff 2.4px 3.6px, var(--textDim) 3.6px); }
	.sw.flight { height: 2px; background: repeating-linear-gradient(90deg, var(--textDim) 0 5px, transparent 5px 9px); }
	.sw.ghost { background: repeating-linear-gradient(90deg, var(--textDim) 0 2px, transparent 2px 6px); }
	.star { color: #f6c544; font-size: 12px; }
	.first { color: #fff1c2; font-size: 12px; -webkit-text-stroke: 0.6px #3a2a08; }
	.info .firstline { display: block; font-weight: 600; color: var(--accent); }
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
		/* Play, the slider and the speed on one line, the slider taking the room; the time under them. */
		.scrub { flex: 1 1 0; min-width: 100px; }
		.clock { min-width: 0; font-size: 11px; text-align: left; order: 5; flex: 1 1 100%; }
	}
</style>
