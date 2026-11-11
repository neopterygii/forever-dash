<script lang="ts">
	// The map: Polestar's MapView with the dashboard's trails, pins and events, and the playtime
	// scrubber. What there is to draw goes to the overlay when the data changes; the replay time and
	// the pins go to it on their own, so playing redraws and nothing more.
	import { onMount, untrack } from 'svelte';
	import { dash, FOCUS_BUFFERS, OVERVIEW_BUFFERS } from '../lib/dash.svelte';
	import type { DashEvent, Trail } from '../lib/api';
	import { createMapView, type MapViewApi } from '../lib/mapview';
	import { TrailOverlay, type Hit, type OverlayEvent, type OverlayLine, type OverlayPin } from '../lib/overlay';
	import { installWorldMap, mapChoices, mapOf, showMap, shownMap, type MapChoice } from '../lib/worldmap';
	import { inSessions, posAt, styleOf } from '../lib/timeline';
	import { day, hhmm } from '../lib/format';

	/** Event badge colours (the overview shows level, death and mark; a focus every journal kind). */
	const EVENT_COLOR: Record<string, string> = {
		death: '#f57373', mark: '#e6ba66', accept: '#ffd673', turnin: '#ffd673', explore: '#f5ad85', enter: '#a385ff', encounter: '#a385ff',
		taxi: '#94c9ff', bind: '#94c9ff', learn: '#78dbed', rare: '#ff8052', abandon: '#9ba2b9',
	};
	const OVERVIEW_EVENTS = new Set(['level', 'death', 'mark', 'milestone']);
	const levelOf = (text: string) => /level (\d+)/i.exec(text)?.[1];
	const STYLE_LABEL: Record<string, string> = { walk: 'on foot', mount: 'mounted', ghost: 'ghost run', flight: 'in flight' };
	/** Seen this recently (seconds): probably still playing (the sidebar's green dot says the same). */
	const RECENT = 600;
	/** How many events of one badge the hover lists before "and more". */
	const TIP_MAX = 6;

	let { visible }: { visible: boolean } = $props();
	let canvas: HTMLCanvasElement;
	let overlayCanvas: HTMLCanvasElement;
	let playerEl: HTMLDivElement;
	let overlay = $state.raw<TrailOverlay | null>(null);
	let map = $state.raw<MapViewApi | null>(null);
	let noGL = $state(false);
	/** The events of the badge clicked (kept open until something else is clicked). */
	let info = $state.raw<DashEvent[] | null>(null);
	/** What the pointer is over, and where (CSS px of the map). */
	let hover = $state.raw<{ x: number; y: number; w: number; h: number; hit: NonNullable<Hit> } | null>(null);
	let speed = $state(120);
	/** The map shown (Azeroth, or Zephras Isle, a battleground...), and the choices. */
	let shown = $state<MapChoice>('azeroth');
	let choices = $state.raw<{ value: MapChoice; name: string }[]>([]);
	/** When each event on the map happened, in order: what "previous / next event" steps through. */
	let stepTimes: number[] = [];

	function pickMap(v: string) {
		if (!map) return;
		shown = v === 'azeroth' ? 'azeroth' : Number(v);
		showMap(map, shown);
	}

	/** A click on the map: a pin selects its character, a badge keeps its events open, a spot on a
	 *  trail takes the replay to the moment the character was there. */
	function act(hit: Hit) {
		info = null;
		if (hit?.kind === 'pin') {
			if (!(dash.mode === 'focus' && dash.focus?.id === hit.pin.id)) dash.run(dash.showFocus(hit.pin.id));
		} else if (hit?.kind === 'event') info = hit.events.map((e) => e.data as DashEvent);
		else if (hit?.kind === 'trail') {
			dash.playing = false;
			dash.t = hit.t;
		}
	}

	function onMove(e: PointerEvent) {
		if (e.pointerType === 'touch' || e.buttons) return void (hover = null);
		const r = canvas.getBoundingClientRect();
		const hit = overlay?.hit(e.clientX - r.left, e.clientY - r.top) ?? null;
		hover = hit ? { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height, hit } : null;
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
				view.on('pick', ({ sx, sy }) => act(overlay?.hit(sx, sy) ?? null));
				overlay = new TrailOverlay(overlayCanvas, view);
				map = view;
			})
			.catch(() => (noGL = true));
		return () => {
			overlay?.destroy();
			view.destroy();
		};
	});

	// What there is to draw: every trail whole and every event. The overlay shows them up to the
	// replay time, so this runs when the data changes, not while playing.
	$effect(() => {
		if (!overlay) return;
		const lines: OverlayLine[] = [];
		const events: OverlayEvent[] = [];
		const addLines = (id: string, trails: Trail[]) => {
			const color = dash.colorOf(id);
			const from = lines.length;
			for (const s of trails) lines.push({ id, c: s.c, pts: s.f32, ts: s.ts, color, style: styleOf(s) });
			// A trail that goes on from one line into the next (walking into riding) carries the points
			// either side of the join, so the smoothing keeps its direction there.
			for (let i = from + 1; i < lines.length; i++) {
				const a = lines[i - 1], b = lines[i];
				const kin = a.style === b.style || (a.style !== 'ghost' && a.style !== 'flight' && b.style !== 'ghost' && b.style !== 'flight');
				const n = a.pts.length;
				if (a.c !== b.c || !kin || n < 4 || b.pts.length < 4 || a.pts[n - 2] !== b.pts[0] || a.pts[n - 1] !== b.pts[1]) continue;
				a.post = [b.pts[2], b.pts[3]];
				b.pre = [a.pts[n - 4], a.pts[n - 3]];
			}
		};
		const addEvents = (list: DashEvent[], id: string, all: boolean) => {
			const mine: OverlayEvent[] = [];
			for (const e of list) {
				if (e.kind === 'milestone' || e.pos?.c === undefined || (!all && !OVERVIEW_EVENTS.has(e.kind))) continue;
				if (e.kind !== 'level' && !EVENT_COLOR[e.kind]) continue;
				mine.push({ c: e.pos.c, wx: e.pos.wx!, wy: e.pos.wy!, t: e.t, kind: e.kind, label: e.kind === 'level' ? levelOf(e.text) : undefined, color: EVENT_COLOR[e.kind] ?? dash.colorOf(id), data: e });
			}
			// Firsts and round numbers: a star of their own, or one on the badge of the event that was
			// the first (a first death, a first flight). Round levels are the level's starburst already.
			for (const m of list) {
				if (m.kind !== 'milestone' || m.milestone === 'level' || m.pos?.c === undefined) continue;
				const on = mine.find((o) => Math.abs(o.t - m.t) < 1);
				if (on) {
					const d = on.data as DashEvent;
					on.first = m.text;
					on.data = { ...d, first: d.first ? `${d.first} · ${m.text}` : m.text };
				} else mine.push({ c: m.pos.c, wx: m.pos.wx!, wy: m.pos.wy!, t: m.t, kind: 'milestone', color: '#fff1c2', data: m });
			}
			events.push(...mine);
		};
		if (dash.mode === 'overview' && dash.overview) {
			for (const c of dash.overview.characters) {
				if (dash.hidden.includes(c.char)) continue;
				addLines(c.char, c.trails);
				addEvents(c.events, c.char, false);
			}
		} else if (dash.mode === 'focus' && dash.focus) {
			addLines(dash.focus.id, dash.focus.trails);
			addEvents(dash.focus.events, dash.focus.id, true);
		}
		stepTimes = [...new Set(events.map((e) => e.t))].sort((a, b) => a - b);
		// All play: translucent lines that build up where the character often went (hubs glow).
		overlay.set({ lines, events, dense: dash.mode === 'focus' && dash.focus?.buffer === 'all' });
	});

	// The replay time: where everyone is then. At the latest moment every pin is bright and the
	// green dot means seen in the last minutes; replaying, a character not playing then is dimmed.
	$effect(() => {
		if (!overlay) return;
		const t = dash.t;
		const live = dash.atLatest;
		const now = Date.now() / 1000;
		const pins: OverlayPin[] = [];
		const who = (id: string) => dash.chars.find((c) => c.id === id);
		const recent = (id: string) => now - (who(id)?.last ?? 0) < RECENT;
		const f = dash.mode === 'focus' ? dash.focus : null;
		for (const c of dash.overview?.characters ?? []) {
			if (c.char === f?.id || dash.hidden.includes(c.char) || (dash.mode !== 'overview' && !f)) continue;
			const p = posAt(c.trails, t);
			if (!p) continue;
			const on = inSessions(c.sessions, t);
			pins.push({ id: c.char, c: p.c, wx: p.wx, wy: p.wy, name: dash.name(c.char), level: who(c.char)?.level ?? null, color: dash.colorOf(c.char), dim: f ? true : !live && !on, playing: live ? recent(c.char) : on });
		}
		if (f) {
			const a = posAt(f.trails, t);
			if (a) pins.push({ id: f.id, c: a.c, wx: a.wx, wy: a.wy, name: dash.name(f.id), level: who(f.id)?.level ?? null, color: dash.colorOf(f.id), dim: false, playing: live ? recent(f.id) : inSessions(f.sessions, t), heading: a.heading });
		}
		overlay.setTime(t, pins);
	});

	/** The part of the map nothing covers (CSS px in from each edge): the map picker and legend on
	 *  top, the player at the bottom, the journal on the right where it sits beside the map (on a
	 *  phone it covers it). */
	function clear() {
		const r = canvas.getBoundingClientRect();
		const beside = r.width > 720 && dash.journalOpen;
		return { w: r.width, h: r.height, l: 40, t: 58, r: beside ? 452 : 40, b: (playerEl?.offsetHeight ?? 56) + 30 };
	}

	/** Frames a box (the continent's plane: x = -wy, y = -wx) in the clear part of the map. */
	function frame(m: MapViewApi, c: number, x0: number, y0: number, x1: number, y1: number, maxZoom: number) {
		const i = clear();
		const w = Math.max(40, i.w - i.l - i.r), h = Math.max(40, i.h - i.t - i.b);
		const zoom = Math.min(maxZoom, w / Math.max(x1 - x0, 1), h / Math.max(y1 - y0, 1));
		m.setView({ c, x: (x0 + x1) / 2 - (i.l - i.r) / 2 / zoom, y: (y0 + y1) / 2 - (i.t - i.b) / 2 / zoom, zoom }, { animate: true });
	}

	/** Brings a spot to the middle of the clear part of the map, at the zoom given (or the current one). */
	function centre(m: MapViewApi, p: { c: number; wx: number; wy: number }, zoom = m.view.zoom) {
		const i = clear();
		m.setView({ c: p.c, x: -p.wy + (i.r - i.l) / 2 / zoom, y: -p.wx + (i.b - i.t) / 2 / zoom, zoom }, { animate: true });
	}

	// Fit the view when new data asks for it (and only then: opening the journal or scrubbing leaves
	// the view alone): the trails on the map with the most of them (Azeroth, or an other map such as
	// Zephras Isle, which is then shown). Azeroth's other continent is carried into the first one's
	// frame by how far apart MapView draws them. A short trail fits close in, where the terrain
	// shows (lib/worldmap.ts).
	$effect(() => {
		dash.fitRequest;
		const m = map;
		if (!m) return;
		untrack(() => {
			const trails = dash.mode === 'focus' ? (dash.focus?.trails ?? []) : (dash.overview?.characters ?? []).filter((c) => !dash.hidden.includes(c.char)).flatMap((c) => c.trails);
			if (!trails.length) return;
			const byMap = new Map<string, number>();
			for (const s of trails) byMap.set(String(mapOf(m, s.c)), (byMap.get(String(mapOf(m, s.c))) ?? 0) + s.ts.length);
			const best = [...byMap.entries()].sort((a, b) => b[1] - a[1])[0][0];
			const choice: MapChoice = best === 'azeroth' ? 'azeroth' : Number(best);
			shown = choice;
			showMap(m, choice, false);
			const mine = trails.filter((s) => String(mapOf(m, s.c)) === best);
			const by = new Map<number, number>();
			for (const s of mine) by.set(s.c, (by.get(s.c) ?? 0) + s.ts.length);
			const c0 = [...by.entries()].sort((a, b) => b[1] - a[1])[0][0];
			// Where continent c lies from c0, in plane yards: both drawn at world 0, 0, a zoom apart.
			const zoom = m.view.zoom, at0 = m.toScreen(c0, 0, 0);
			let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
			for (const s of mine) {
				const at = s.c === c0 ? at0 : m.toScreen(s.c, 0, 0);
				if (!at || !at0 || !zoom) continue;
				const dx = (at.x - at0.x) / zoom, dy = (at.y - at0.y) / zoom;
				for (let i = 0; i + 1 < s.pts.length; i += 2) {
					const x = -s.pts[i + 1] + dx, y = -s.pts[i] + dy;
					x0 = Math.min(x0, x); x1 = Math.max(x1, x);
					y0 = Math.min(y0, y); y1 = Math.max(y1, y);
				}
			}
			if (x0 <= x1) frame(m, c0, x0, y0, x1, y1, 1.2);
			info = null;
			hover = null;
		});
	});

	// A journal event clicked: go to its spot at region-to-ground zoom (zone art meeting the terrain),
	// centred in the part of the map left clear. Runs after the fit above (the replay's own), so the
	// event wins.
	const EVENT_ZOOM = 0.45;
	$effect(() => {
		const p = dash.focusPoint;
		if (!map || !p) return;
		dash.focusPoint = null;
		const m = map;
		const choice = mapOf(m, p.c);
		if (choice !== untrack(() => shown)) {
			shown = choice;
			showMap(m, choice, false);
		}
		queueMicrotask(() => untrack(() => centre(m, p, EVENT_ZOOM)));
	});

	// The map was hidden behind the journal: re-measure when it shows again.
	$effect(() => {
		if (visible) map?.resize();
	});

	/** Keeps the selected character on the map: when it has left the middle of the clear part (or
	 *  `now`: wherever it is off it), the view glides to it, on the map it is on. */
	let followed = 0;
	function reveal(now = false) {
		const m = map, f = dash.mode === 'focus' ? dash.focus : null;
		if (!m || !f) return;
		const a = posAt(f.trails, dash.t);
		if (!a) return;
		const choice = mapOf(m, a.c);
		if (choice !== shown) {
			shown = choice;
			showMap(m, choice, false);
		}
		const s = m.toScreen(a.c, a.wx, a.wy), i = clear();
		const mx = now ? 0 : Math.min(140, (i.w - i.l - i.r) / 4), my = now ? 0 : Math.min(110, (i.h - i.t - i.b) / 4);
		if (s && s.x > i.l + mx && s.x < i.w - i.r - mx && s.y > i.t + my && s.y < i.h - i.b - my) return;
		const at = performance.now();
		if (!now && at - followed < 700) return;
		followed = at;
		centre(m, a);
	}

	// Playback over playtime. The time is read and written inside the frame callback only, so this
	// starts once per play and each frame counts (reading it here would restart it every frame).
	$effect(() => {
		if (!dash.playing) return;
		const tl = untrack(() => dash.timeline);
		if (!tl) return;
		untrack(() => {
			if (dash.t >= tl.end) dash.t = tl.start;
		});
		let last = 0;
		let raf = requestAnimationFrame(function tick(now) {
			const dt = last ? Math.min(0.25, (now - last) / 1000) : 0;
			last = now;
			const t = tl.advance(dash.t, dt * speed);
			dash.t = t;
			if (dash.follow) reveal();
			if (t >= tl.end) dash.playing = false;
			else raf = requestAnimationFrame(tick);
		});
		return () => cancelAnimationFrame(raf);
	});

	const live = $derived(dash.atLatest);
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

	/** The replay moves by seconds of play (offline gaps skipped), stopping. */
	function step(seconds: number) {
		const tl = dash.timeline;
		if (!tl) return;
		dash.playing = false;
		dash.t = tl.advance(dash.t, seconds);
		reveal(true);
	}

	/** To the event before (-1) or after (1) the replay time; past the last one, to the end. */
	function stepEvent(dir: 1 | -1) {
		const tl = dash.timeline;
		if (!tl) return;
		const t = dash.t;
		const to = dir > 0 ? stepTimes.find((x) => x > t + 0.5) : [...stepTimes].reverse().find((x) => x < t - 0.5);
		dash.playing = false;
		dash.t = Math.max(tl.start, Math.min(tl.end, to ?? (dir > 0 ? tl.end : tl.start)));
		reveal(true);
	}

	// Keys: Space plays and pauses, the arrows step a minute of play (ten with Shift), [ and ] go to
	// the event before and after, Home and End to the ends. Not while typing, nor behind a window.
	function onkey(e: KeyboardEvent) {
		if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || dash.sheet || dash.people || !dash.timeline) return;
		const el = e.target as HTMLElement | null;
		const tag = el?.tagName ?? '';
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
		if (tag === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) return;
		const tl = dash.timeline;
		if (e.key === ' ') dash.playing = !dash.playing;
		else if (e.key === 'ArrowLeft') step(e.shiftKey ? -600 : -60);
		else if (e.key === 'ArrowRight') step(e.shiftKey ? 600 : 60);
		else if (e.key === '[') stepEvent(-1);
		else if (e.key === ']') stepEvent(1);
		else if (e.key === 'Home') scrub(0);
		else if (e.key === 'End') (dash.playing = false), (dash.t = tl.end);
		else return;
		e.preventDefault();
	}

	const tipEvents = $derived(hover?.hit.kind === 'event' ? hover.hit.events.map((e) => e.data as DashEvent) : []);
</script>

<svelte:window onkeydown={onkey} />

<section class="pane" class:on={visible}>
	<canvas bind:this={canvas} class:hot={!!hover} onpointermove={onMove} onpointerleave={() => (hover = null)} onpointerdown={() => (hover = null)}></canvas>
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
	{#if info?.length}
		<div class="info">
			{#each info as e, i (i)}
				<div class="il"><time>{day(e.t)} {hhmm(e.t)} · {dash.name(e.char)}</time>{#if e.first}<b class="firstline">★ {e.first}</b>{/if}{e.text}</div>
			{/each}
		</div>
	{/if}
	{#if hover}
		<div class="tip" class:left={hover.x > hover.w - 300} class:up={hover.y > hover.h * 0.55} style:left="{hover.x}px" style:top="{hover.y}px" role="tooltip">
			{#if hover.hit.kind === 'event'}
				{#each tipEvents.slice(0, TIP_MAX) as e, i (i)}
					<div class="il"><time>{day(e.t)} {hhmm(e.t)}{dash.mode === 'overview' ? ` · ${dash.name(e.char)}` : ''}</time>{#if e.first}<b class="firstline">★ {e.first}</b>{/if}{e.text}</div>
				{/each}
				{#if tipEvents.length > TIP_MAX}<small>and {tipEvents.length - TIP_MAX} more here: click to keep the list open, or zoom in</small>{/if}
			{:else if hover.hit.kind === 'trail'}
				<div class="il"><time>{day(hover.hit.t)} {hhmm(hover.hit.t)}</time>{dash.name(hover.hit.line.id)} · {STYLE_LABEL[hover.hit.line.style]}</div>
				<small>Click to go to this moment</small>
			{:else}
				<div class="il">{hover.hit.pin.name}{hover.hit.pin.level != null ? ` · level ${hover.hit.pin.level}` : ''}</div>
				{#if !(dash.mode === 'focus' && dash.focus?.id === hover.hit.pin.id)}<small>Click to see this character alone</small>{/if}
			{/if}
		</div>
	{/if}
	<div class="player" bind:this={playerEl}>
		<select aria-label="How much playtime to show" value={bufferValue} onchange={(e) => setBuffer(e.currentTarget.value)}>
			{#each buffers as [v, label] (v)}<option value={v}>{label}</option>{/each}
		</select>
		<button class="play" aria-label={dash.playing ? 'Pause' : 'Play'} title="{dash.playing ? 'Pause' : 'Play'} (Space)" onclick={() => (dash.playing = !dash.playing)}>
			<img src={dash.playing ? '/glyph/pause.png' : '/glyph/play.png'} alt="" />
		</button>
		<button class="icon stepb" aria-label="Previous event" title="Previous event ([)" onclick={() => stepEvent(-1)}><i></i></button>
		<button class="icon stepb next" aria-label="Next event" title="Next event (])" onclick={() => stepEvent(1)}><i></i></button>
		<div class="scrub" title="← → one minute of play · Shift: ten · [ ] previous and next event">
			<input type="range" min="0" max="1000" value={sliderValue} aria-label="Time (playtime; offline gaps skipped)" oninput={(e) => scrub(Number(e.currentTarget.value))} />
			<div class="ticks">{#each ticks as u, i (i)}<b style:left="{(u * 100).toFixed(2)}%"></b>{/each}</div>
		</div>
		<div class="foot">
			<time class="clock">{dash.t ? `${day(dash.t)} ${hhmm(dash.t)}${live ? ' · latest' : offline ? ' · offline' : ''}` : ''}</time>
			{#if dash.mode === 'focus'}
				<button class="follow" class:on={dash.follow} aria-pressed={dash.follow} title="Keep the character in view while the replay plays" onclick={() => dash.setFollow(!dash.follow)}>Follow</button>
			{/if}
		</div>
		<select aria-label="Speed" bind:value={speed}>
			<option value={30}>30×</option><option value={60}>60×</option><option value={120}>120×</option><option value={600}>600×</option>
		</select>
	</div>
	{#if noGL}<div class="nomap">WebGL2 is not available in this browser.</div>{/if}
</section>

<style>
	.pane { display: none; position: relative; min-height: 0; height: 100%; }
	.pane.on { display: block; }
	canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; }
	canvas.overlay { pointer-events: none; }
	canvas.hot { cursor: pointer !important; }
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
	.firstline { display: block; font-weight: 600; color: var(--accent); }
	.info { position: absolute; top: 12px; left: 12px; max-width: min(360px, calc(100% - 24px)); padding: 10px 12px; border-radius: 8px; background: var(--panel); border: 1px solid var(--border); box-shadow: var(--window-shadow); }
	.info { max-height: 45%; overflow: auto; }
	.il + .il { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--divider); }
	.il time { display: block; color: var(--textMuted); font-size: 11px; }
	/* What the pointer is over: beside it, turned away from the map's edges. */
	.tip { position: absolute; z-index: 4; pointer-events: none; max-width: 280px; padding: 8px 10px; border-radius: 8px; background: var(--panel); border: 1px solid var(--border); box-shadow: var(--window-shadow); transform: translate(14px, 16px); }
	.tip.left { transform: translate(calc(-100% - 14px), 16px); }
	.tip.up { transform: translate(14px, calc(-100% - 12px)); }
	.tip.left.up { transform: translate(calc(-100% - 14px), calc(-100% - 12px)); }
	.tip small { display: block; margin-top: 6px; color: var(--textMuted); font-size: 11px; }
	.player { position: absolute; left: 12px; right: 12px; bottom: 12px; display: flex; gap: 10px; align-items: center; padding: 8px 12px; border-radius: 10px; background: var(--panel); border: 1px solid var(--border); box-shadow: var(--window-shadow); }
	select { background: var(--well); border: 1px solid var(--border); border-radius: 6px; padding: 4px 6px; }
	.play { width: 30px; height: 30px; border-radius: 50%; border: 0; background: var(--accent); display: grid; place-items: center; flex: none; }
	.play img { width: 16px; height: 16px; filter: brightness(0); }
	.stepb { flex: none; width: 26px; height: 26px; display: grid; place-items: center; border: 0; border-radius: 6px; background: var(--chip); color: var(--textDim); padding: 0; margin-left: -4px; }
	.stepb:hover { color: var(--text); background: var(--hover); }
	/* A chevron against a bar: to the event before; mirrored, to the one after. */
	.stepb i { width: 14px; height: 14px; background: currentColor; mask: url(/glyph/chevron-left.png) center / contain no-repeat; -webkit-mask: url(/glyph/chevron-left.png) center / contain no-repeat; box-shadow: none; position: relative; }
	.stepb { position: relative; }
	.stepb::after { content: ''; position: absolute; left: 6px; top: 7px; bottom: 7px; width: 2px; border-radius: 1px; background: currentColor; }
	.stepb.next { transform: scaleX(-1); }
	/* The time and Follow: in the row on a wide screen, a line of their own on a phone. */
	.foot { display: contents; }
	.follow { flex: none; background: var(--chip); border: 1px solid transparent; border-radius: 6px; padding: 4px 8px; color: var(--textDim); font-size: 12px; font-weight: 600; }
	.follow.on { color: var(--accent); border-color: var(--accent); }
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
		.foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex: 1 1 100%; order: 5; }
		.clock { min-width: 0; font-size: 11px; text-align: left; }
		.stepb { width: 40px; height: 40px; margin-left: 0; }
		.stepb::after { left: 12px; top: 13px; bottom: 13px; }
		.tip { display: none; }
	}
</style>
