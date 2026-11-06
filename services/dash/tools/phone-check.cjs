// The phone pass: opens the dashboard at phone sizes, walks every view, saves a screenshot of each and
// checks what a screenshot can hide: the page scrolling sideways, things pushed past the screen's edge,
// controls too small to tap, console errors. Run it after any change to the site (README, "Phone pass"),
// then look at the screenshots.
//
//   node services/dash/tools/phone-check.cjs [server=http://127.0.0.1:8799] [out dir=phone-check]
//
// Needs playwright-core (services/dash/ui devDependency) and a Chromium: $CHROME, else Playwright's
// cached one (~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome). Exit code 1 when a check fails.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(require.resolve('playwright-core', { paths: [path.join(__dirname, '../ui')] }));

const server = process.argv[2] || 'http://127.0.0.1:8799';
const out = process.argv[3] || 'phone-check';
const PHONES = [
	{ name: 'iphone', width: 390, height: 844 },
	{ name: 'small-android', width: 360, height: 780 },
];
/** Smallest comfortable tap target, CSS px (WCAG 2.5.8 asks for 24; phones want more). */
const TAP = 32;

function chrome() {
	if (process.env.CHROME) return process.env.CHROME;
	const base = path.join(require('node:os').homedir(), '.cache/ms-playwright');
	const dir = fs.existsSync(base) && fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
	const exe = dir && path.join(base, dir, 'chrome-linux64/chrome');
	if (!exe || !fs.existsSync(exe)) throw new Error('no Chromium: set CHROME or run `npx playwright-core install chromium`');
	return exe;
}

/** What the screenshot can hide, measured in the page. */
async function measure(page) {
	return page.evaluate((TAP) => {
		const vw = document.documentElement.clientWidth;
		const sideways = document.documentElement.scrollWidth - vw;
		const name = (el) => (el.getAttribute('aria-label') || el.textContent || el.className || el.tagName).toString().trim().replace(/\s+/g, ' ').slice(0, 40);
		const visible = (el) => {
			const r = el.getBoundingClientRect();
			const s = getComputedStyle(el);
			return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
		};
		// Inside a box that scrolls sideways on purpose (a table, code), width is allowed.
		const inScroller = (el) => {
			for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
				const o = getComputedStyle(p).overflowX;
				if (o === 'auto' || o === 'scroll' || o === 'hidden') return true;
			}
			return false;
		};
		const offscreen = [];
		for (const el of document.querySelectorAll('body *')) {
			if (!visible(el) || inScroller(el)) continue;
			const r = el.getBoundingClientRect();
			if (r.right > vw + 1 || r.left < -1) offscreen.push(`${el.tagName.toLowerCase()} "${name(el)}" ${Math.round(r.left)}..${Math.round(r.right)}`);
		}
		const small = [];
		for (const el of document.querySelectorAll('button, a[href], input, select, textarea, [role=button]')) {
			if (!visible(el)) continue;
			const r = el.getBoundingClientRect();
			if (r.width < TAP || r.height < TAP) small.push(`${el.tagName.toLowerCase()} "${name(el)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
		}
		return { sideways, offscreen: offscreen.slice(0, 12), offscreenCount: offscreen.length, small: [...new Set(small)].slice(0, 15), smallCount: small.length };
	}, TAP);
}

// The views, in order; each step leaves the page in the state it names.
const VIEWS = [
	['overview', async () => {}],
	['overview-journal', async (p) => { await p.locator('button.jt').click(); }],
	['focus', async (p) => { await p.locator('button.jt').click(); await p.locator('.chars button.main').first().click(); }],
	['focus-journal', async (p) => { await p.locator('button.jt').click(); }],
	['focus-journal-log-quest', async (p) => {
		const art = p.locator('.journal article').filter({ has: p.locator('.logt') }).first();
		await art.locator('.logt').click();
		const qt = art.locator('button.qt').first();
		if (await qt.count()) await qt.click();
	}],
	['diary-edit', async (p) => { await p.locator('.journal .dbar button', { hasText: 'Edit' }).first().click(); }],
	['sheet-gear', async (p) => {
		await p.locator('.journal .dbar button', { hasText: 'Cancel' }).first().click().catch(() => {});
		await p.locator('button.close').first().click().catch(() => {});
		const gear = p.locator('.chars button:not([disabled])', { hasText: 'Gear' }).first();
		if (await gear.count()) await gear.click();
	}],
	['sheet-bags', async (p) => { await p.locator('[role=dialog] button, .sheet button', { hasText: 'Bags' }).first().click().catch(() => {}); }],
	['sheet-stats', async (p) => { await p.locator('[role=dialog] button, .sheet button', { hasText: 'Stats' }).first().click().catch(() => {}); }],
];

(async () => {
	fs.mkdirSync(out, { recursive: true });
	const browser = await chromium.launch({ executablePath: chrome(), args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
	let failed = false;
	const report = [];
	for (const phone of PHONES) {
		const ctx = await browser.newContext({ viewport: { width: phone.width, height: phone.height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
		const page = await ctx.newPage();
		const errors = [];
		page.on('pageerror', (e) => errors.push(String(e)));
		page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
		// Failed requests by URL; a missing item icon is expected (new Forever items without one: the page
		// shows its placeholder), anything else is not.
		page.on('response', (r) => {
			if (r.status() < 400) return;
			const u = new URL(r.url()).pathname;
			if (!u.startsWith('/art/icons/item/')) errors.push(`${r.status()} ${u}`);
		});
		await page.goto(server, { waitUntil: 'networkidle' });
		await page.waitForTimeout(1200);
		for (const [view, act] of VIEWS) {
			try {
				await act(page);
			} catch (e) {
				report.push(`${phone.name} ${view}: could not reach the view (${e.message.split('\n')[0]})`);
				failed = true;
			}
			await page.waitForTimeout(900);
			const m = await measure(page);
			const file = path.join(out, `${phone.name}-${view}.png`);
			await page.screenshot({ path: file });
			const bad = m.sideways > 1 || m.offscreenCount > 0;
			if (bad) failed = true;
			report.push(
				`${bad ? 'FAIL' : 'ok  '} ${phone.name} ${view}: sideways ${m.sideways}px, offscreen ${m.offscreenCount}, small targets ${m.smallCount}` +
					(m.offscreen.length ? `\n       offscreen: ${m.offscreen.join('; ')}` : '') +
					(m.small.length ? `\n       small: ${m.small.join('; ')}` : ''),
			);
		}
		if (errors.length) {
			failed = true;
			report.push(`FAIL ${phone.name} console errors: ${[...new Set(errors)].join(' | ')}`);
		}
		await ctx.close();
	}
	await browser.close();
	fs.writeFileSync(path.join(out, 'report.txt'), report.join('\n') + '\n');
	console.log(report.join('\n'));
	console.log(`screenshots in ${out}/`);
	process.exit(failed ? 1 : 0);
})();
