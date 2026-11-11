// The map's art by zoom: screenshots of a few places at a ladder of zooms, to compare how sharp each
// area is at each step (README, "Map art by zoom"). Local servers only, like the phone pass.
//
//   node services/dash/tools/map-check.cjs [server=http://127.0.0.1:8799] [out dir=map-check]
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(require.resolve('playwright-core', { paths: [path.join(__dirname, '../ui')] }));

const server = process.argv[2] || 'http://127.0.0.1:8799';
const out = process.argv[3] || 'map-check';
if (!/^(localhost|127\.)/.test(new URL(server).hostname)) {
	console.error(`refusing ${server}: local servers only`);
	process.exit(2);
}
/** Places (continent, world x, world y) picked for contrast: a city inside a small zone, the largest
 *  zone, a city on a zone border, a small zone beside large ones. */
const PLACES = [
	{ name: 'stormwind-elwynn', c: 0, wx: -9000, wy: 300 },
	{ name: 'barrens', c: 1, wx: -1200, wy: -2600 },
	{ name: 'orgrimmar-durotar', c: 1, wx: 1500, wy: -4400 },
	{ name: 'ironforge-dunmorogh', c: 0, wx: -5000, wy: -900 },
];
const ZOOMS = (process.env.ZOOMS || '0.06,0.1,0.15,0.22,0.33,0.5,0.75,1.1,1.7').split(',').map(Number);

function chrome() {
	if (process.env.CHROME) return process.env.CHROME;
	const base = path.join(require('node:os').homedir(), '.cache/ms-playwright');
	const dir = fs.existsSync(base) && fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
	const exe = dir && path.join(base, dir, 'chrome-linux64/chrome');
	if (!exe || !fs.existsSync(exe)) throw new Error('no Chromium: set CHROME or run `npx playwright-core install chromium`');
	return exe;
}

(async () => {
	fs.mkdirSync(out, { recursive: true });
	const browser = await chromium.launch({ executablePath: chrome(), args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
	const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: Number(process.env.DPR || 1) });
	await page.goto(server, { waitUntil: 'networkidle' });
	await page.waitForFunction(() => window.__dashView, null, { timeout: 15000 });
	for (const p of PLACES) {
		for (const zoom of ZOOMS) {
			await page.evaluate(({ p, zoom }) => window.__dashView.setView({ c: p.c, wx: p.wx, wy: p.wy, zoom }, { animate: false }), { p, zoom });
			await page.waitForLoadState('networkidle');
			await page.waitForTimeout(700);
			await page.locator('canvas').first().screenshot({ path: path.join(out, `${p.name}-${String(zoom).replace('.', '_')}.png`) });
		}
	}
	await browser.close();
	console.log(`${PLACES.length * ZOOMS.length} screenshots in ${out}`);
})().catch((e) => {
	console.error(e.message);
	process.exit(1);
});
