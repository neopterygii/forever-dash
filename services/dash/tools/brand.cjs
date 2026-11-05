// Forever Dash's mark and wordmark, drawn in Polestar's visual language (docs/DESIGN.md tokens, the
// night tile of tools/readme/brand.js) but its own shape: a dotted trail walking up to a small
// four-point star, for "where we've been". The wordmark is Cinzel (SIL OFL 1.1, tools/media/fonts),
// drawn as outlines with Polestar's Outliner so the SVGs need no web font.
//
//   node services/dash/tools/brand.cjs        -> services/dash/ui/public/brand/{mark,wordmark,favicon}.svg
const fs = require('node:fs');
const path = require('node:path');
const { Outliner } = require('../../../tools/readme/outline');

const C = { accent: '#e6ba66', accentLight: '#ffeec2', navy: '#0a0d16', text: '#f7f8fd', textMuted: '#9ba2b9' };
const OUT = path.join(__dirname, '..', 'ui', 'public', 'brand');

// A four-point star centred at (cx, cy): tips ry up/down, rx left/right, waist w.
const star = (cx, cy, rx, ry, w) =>
	`M${[[cx, cy - ry], [cx + w, cy - w], [cx + rx, cy], [cx + w, cy + w], [cx, cy + ry], [cx - w, cy + w], [cx - rx, cy], [cx - w, cy - w]].map(([x, y]) => `${+x.toFixed(2)} ${+y.toFixed(2)}`).join('L')}Z`;

// The mark's layers on a 64 grid (no tile): the trail, its start ring and the star.
function markBody({ small = false } = {}) {
	const trail = small ? 'M23.5 42C26 39 26 37 30.5 35S38 31 37 29' : 'M22.5 43.5C25 40.5 24 38 28.5 36S37 32.5 37.5 28';
	const dots = small ? 'stroke-width="5" stroke-dasharray="0 8"' : 'stroke-width="3.2" stroke-dasharray="0 5.6"';
	return [
		`<path d="${trail}" fill="none" stroke="${C.accent}" stroke-opacity="0.85" stroke-linecap="round" ${dots}/>`,
		`<circle cx="15" cy="49" r="${small ? 5 : 3.4}" fill="none" stroke="${C.accent}" stroke-width="${small ? 3 : 1.8}"/>`,
		`<path fill="${C.accent}" d="${small ? star(44, 20, 12, 17, 4.4) : star(44, 20, 9, 14, 2.8)}"/>`,
		small ? '' : `<path fill="${C.accentLight}" d="${star(44, 20, 3.6, 6.4, 1.1)}"/>`,
	].join('\n');
}

function tile(id) {
	return `<defs><radialGradient id="${id}" cx="44" cy="20" r="34" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${C.accent}" stop-opacity="0.32"/><stop offset="1" stop-color="${C.accent}" stop-opacity="0"/></radialGradient></defs>
<rect x="2" y="2" width="60" height="60" rx="12" fill="${C.navy}"/>
<rect x="2" y="2" width="60" height="60" rx="12" fill="url(#${id})"/>
<rect x="2.5" y="2.5" width="59" height="59" rx="11.5" fill="none" stroke="#fff" stroke-opacity="0.07"/>`;
}

function markSvg() {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 64 64" role="img" aria-label="Forever Dash">
<title>Forever Dash</title>
${tile('glow')}
${markBody()}
</svg>
`;
}

function faviconSvg() {
	return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 64 64">
${tile('g')}
${markBody({ small: true })}
</svg>
`;
}

// The mark (64) beside FOREVER DASH in Cinzel, on a transparent background, for the page header.
function wordmarkSvg() {
	const o = new Outliner('w');
	const capH = 20, tracking = 0.12, x = 80, h = 64;
	const word = o.text('FOREVER DASH', { font: 'cinzel', capHeight: capH, tracking, x, y: h / 2 + capH / 2, fill: C.text, stroke: 0.6 });
	const w = Math.ceil(x + o.width('FOREVER DASH', { font: 'cinzel', size: (capH / 700) * 1000, tracking }) + 4);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${w * 2}" height="${h * 2}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Forever Dash">
<title>Forever Dash</title>
<defs>
${o.defs()}
</defs>
${tile('glow')}
${markBody()}
${word}
</svg>
`;
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'mark.svg'), markSvg());
fs.writeFileSync(path.join(OUT, 'favicon.svg'), faviconSvg());
fs.writeFileSync(path.join(OUT, 'wordmark.svg'), wordmarkSvg());
console.log(`wrote ${OUT}/{mark,favicon,wordmark}.svg`);
