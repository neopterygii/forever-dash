<script lang="ts">
	// The sign-in: a group's code (from whoever runs the site). The server keeps it in a cookie for
	// a year. There is no registration: no code, no site.
	import { dash } from '../lib/dash.svelte';

	let code = $state('');
	let busy = $state(false);
	let wrong = $state(false);

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (!code.trim() || busy) return;
		busy = true;
		wrong = false;
		try {
			wrong = !(await dash.signIn(code.trim()));
		} catch (err) {
			dash.error = err instanceof Error ? err.message : String(err);
		} finally {
			busy = false;
		}
	}
</script>

<main class="signin">
	<form onsubmit={submit}>
		<img class="mark" src="/brand/wordmark.svg" alt="Forever Dash" />
		<label for="code">Group code</label>
		<!-- svelte-ignore a11y_autofocus -->
		<input id="code" bind:value={code} autocomplete="current-password" autocapitalize="off" spellcheck="false" placeholder="xxxx-xxxx-xxxx-xxxx" autofocus aria-invalid={wrong} aria-describedby="hint" />
		<button disabled={busy || !code.trim()}>{busy ? 'Signing in…' : 'Sign in'}</button>
		<p id="hint" class:wrong>{wrong ? 'That code doesn’t match a group.' : 'You see the characters uploaded with your group’s code.'}</p>
	</form>
</main>

<style>
	.signin { min-height: 100%; display: grid; place-items: center; padding: 24px 16px; box-sizing: border-box; background: var(--bg); }
	form { width: min(360px, 100%); display: grid; gap: 10px; padding: 28px 24px; border-radius: 14px; background: var(--panel); border: 1px solid var(--border); box-shadow: var(--window-shadow); }
	.mark { height: 40px; width: auto; justify-self: center; margin-bottom: 10px; }
	label { font-size: 12px; font-weight: 700; color: var(--textDim); }
	input { background: var(--well); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; color: var(--text); font: inherit; font-size: 16px; letter-spacing: 0.04em; }
	input:focus-visible { outline: 1px solid var(--focus); }
	input[aria-invalid='true'] { border-color: var(--danger); }
	button { background: var(--accent); color: var(--onAccent); border: 0; border-radius: 8px; padding: 10px; font-weight: 700; font-size: 14px; cursor: pointer; }
	button:disabled { opacity: 0.6; cursor: default; }
	p { margin: 2px 0 0; font-size: 12px; color: var(--textMuted); line-height: 1.4; }
	p.wrong { color: var(--danger); }
</style>
