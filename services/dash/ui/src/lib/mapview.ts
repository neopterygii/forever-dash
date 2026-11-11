// Polestar's planner MapView (tools/planner/public/map/mapview.js in this fork), bundled from the
// fork's own source so the dashboard always ships the MapView of the commit it was built from.
// The module is plain JS; this file gives the part of its API the dashboard uses a type.
// @ts-expect-error untyped JS module
import { MapView as JsMapView } from '../../../../../tools/planner/public/map/mapview.js';
import type { Route } from './timeline';

export interface Marker {
	c: number;
	wx: number;
	wy: number;
	icon: null;
	glyph: string;
	/** A colour token name (accent, danger, npc...). */
	tint: string;
	label?: string;
	active?: boolean;
	done?: boolean;
	/** Identifies the marker (label keys). */
	step: string;
	[extra: string]: unknown;
}

export interface Dot {
	c: number;
	wx: number;
	wy: number;
	tint: string;
}

export interface MapViewApi {
	init(): Promise<MapViewApi>;
	setRoute(routes: Route[]): void;
	setScene(scene: { markers?: Marker[]; dots?: Dot[] }): void;
	setCharacter(ch: { c: number; wx: number; wy: number; heading: number } | null): void;
	setContinent(c: number): void;
	setMode(mode: 'world' | 'continent'): void;
	/** The view now: the continent under the centre, the centre in its plane (x = -wy, y = -wx) and world yards, CSS px per yard. */
	readonly view: { mode: string; c: number; x: number; y: number; wx: number; wy: number; zoom: number };
	/** x, y: the centre in the continent's plane (x = -wy, y = -wx). */
	setView(v: { c?: number; wx?: number; wy?: number; x?: number; y?: number; zoom?: number }, opts?: { animate?: boolean }): void;
	fitWorld(c: number, pts: [number, number][], opts?: { padding?: number; maxZoom?: number; animate?: boolean; right?: number }): void;
	resize(): void;
	toScreen(c: number, wx: number, wy: number): { x: number; y: number } | null;
	setLayer(name: 'terrain' | 'zoneArt' | 'labels' | 'grid', on: boolean): void;
	destroy(): void;
	on(event: 'marker', fn: (e: { marker: Marker }) => void): () => void;
	on(event: 'pick', fn: (e: { hit: unknown; sx: number; sy: number }) => void): () => void;
	on(event: 'view', fn: (v: { mode: string; c: number; zoom: number }) => void): () => void;
}

export function createMapView(canvas: HTMLCanvasElement, opts: { artBase: string }): MapViewApi {
	return new JsMapView(canvas, opts) as MapViewApi;
}
