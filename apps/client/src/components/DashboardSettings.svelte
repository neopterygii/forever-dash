<script lang="ts">
	// forever-dash: the player's own dashboard server (src-tauri/src/dash.rs). Sharing with Polestar
	// ("Share my play", under Recording) is separate: off unless the player turns it on.
	import { onDestroy } from 'svelte';
	import { api, message } from '../lib/backend';
	import { toast } from '../lib/toast.svelte';
	import type { DashStatus, Snapshot } from '../lib/types';

	let { snapshot }: { snapshot: Snapshot } = $props();
	let status = $state<DashStatus | null>(null);
	let url = $state('');
	let token = $state('');
	let busy = $state(false);
	let loaded = false;

	async function refresh() {
		try {
			status = await api.dashStatus();
			if (!loaded) {
				url = status.url;
				loaded = true;
			}
		} catch {
			/* the window outlives a reload of the backend; the next tick tries again */
		}
	}
	refresh();
	const timer = window.setInterval(refresh, 5000);
	onDestroy(() => clearInterval(timer));

	async function save(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		try {
			status = await api.setDash(url, token ? token : null);
			url = status.url;
			token = '';
			toast(status.url ? 'Dashboard saved: sending starts in a few seconds.' : 'Dashboard turned off.');
		} catch (err) {
			toast(message(err), 'warning');
		} finally {
			busy = false;
		}
	}

	const ago = (ms: number) => {
		const s = Math.max(0, (Date.now() - ms) / 1000);
		return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
	};
	const line = $derived.by((): string => {
		if (!status) return '';
		if (!status.url) return 'Not set: nothing goes to a dashboard.';
		if (status.paused) return 'Paused.';
		if (status.lastError) return status.lastError + (status.retryAt ? ` Trying again ${new Date(status.retryAt).toLocaleTimeString()}.` : '');
		const sent = Object.values(status.installs).reduce((n: number, i) => n + i.acked, 0);
		return status.lastAt ? `Sent ${ago(status.lastAt)}. ${sent} recording parts on the server.` : 'Waiting for the game to save (log out or /reload).';
	});
</script>

<section class="section">
	<h2>Dashboard</h2>
	<p class="lead">Sends your recordings, gear and bags to your own Forever Dash server. Sharing with Polestar (Recording, below) is separate, and off unless you turn it on.</p>
	<form class="rows" onsubmit={save}>
		<label class="row">
			<span class="label">Server address</span>
			<input type="url" placeholder="http://dash.example:8790" bind:value={url} spellcheck="false" />
		</label>
		<label class="row">
			<span class="label">Device token</span>
			<input type="password" placeholder={status?.tokenSet ? 'unchanged' : 'if the server asks for one'} bind:value={token} autocomplete="off" />
		</label>
		<div class="row">
			<span class="label status" class:warn={!!status?.lastError}>{line}</span>
			<button class="btn" type="submit" disabled={busy || (url === (status?.url ?? '') && !token)}>Save</button>
		</div>
		{#if status?.url}
			<div class="row" title="Stops sending (to the dashboard and to Polestar) until you resume. The Recorder keeps recording in the game.">
				<span class="label">Pause uploads</span>
				<button class="toggle" type="button" role="switch" aria-checked={snapshot.paused} aria-label="Pause uploads" onclick={() => api.setPaused(!snapshot.paused).catch((e) => toast(message(e), 'warning'))}></button>
			</div>
		{/if}
	</form>
</section>

<style>
	.lead { margin: 0 0 10px; color: var(--textDim); font-size: 12px; }
	input { flex: 1; min-width: 0; max-width: 320px; background: var(--well); border: 1px solid var(--border); border-radius: 6px; padding: 5px 8px; }
	.status { color: var(--textDim); font-weight: 500; white-space: normal; }
	.status.warn { color: var(--warning); }
</style>
