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
	fitWorld(c: number, pts: [number, number][], opts?: { padding?: number; maxZoom?: number; animate?: boolean }): void;
	resize(): void;
	setLayer(name: 'terrain' | 'zoneArt' | 'labels' | 'grid', on: boolean): void;
	destroy(): void;
	on(event: 'marker', fn: (e: { marker: Marker }) => void): () => void;
	on(event: 'pick', fn: (e: { hit: unknown }) => void): () => void;
}

export function createMapView(canvas: HTMLCanvasElement, opts: { artBase: string }): MapViewApi {
	return new JsMapView(canvas, opts) as MapViewApi;
}
