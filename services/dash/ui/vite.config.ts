import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

// Polestar's design tokens (docs/DESIGN.md) from the planner's stylesheet in this fork, at build time:
// only its @font-face rules and :root custom properties. The rest of that stylesheet is the planner's
// own layout, whose global class names (.play, .scrub, .legend...) would leak into ours.
function polestarTokens(): Plugin {
	const file = new URL('../../../tools/planner/public/style.css', import.meta.url);
	const id = 'virtual:polestar-tokens.css';
	return {
		name: 'polestar-tokens',
		resolveId: (source) => (source === id ? '\0polestar-tokens.css' : null),
		load(resolved) {
			if (resolved !== '\0polestar-tokens.css') return null;
			this.addWatchFile(file.pathname);
			const css = readFileSync(file, 'utf8');
			const root = css.match(/:root\s*\{[^}]*\}/)?.[0];
			if (!root) throw new Error(`${file.pathname}: no :root tokens`);
			return [...(css.match(/@font-face\s*\{[^}]*\}/g) ?? []), root].join('\n');
		},
	};
}

// The server (forever-dash serve --web ui/dist) serves the build. `pnpm dev` proxies the API and the
// files the server provides (fonts, map art) to a running server.
const server = process.env.DASH_SERVER || 'http://127.0.0.1:8790';
const proxied = ['/api', '/v1', '/fonts', '/art'];

export default defineConfig({
	plugins: [polestarTokens(), svelte()],
	clearScreen: false,
	server: {
		port: 5175,
		strictPort: true,
		host: true,
		proxy: Object.fromEntries(proxied.map((p) => [p, server])),
		// MapView is imported from the fork's planner (src/lib/mapview.ts).
		fs: { allow: ['.', '../../../tools/planner/public'] },
	},
	build: { target: ['es2021', 'chrome105', 'safari15'], assetsInlineLimit: 4096 },
});
