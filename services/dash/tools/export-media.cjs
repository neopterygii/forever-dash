// Exports the planner's on-the-fly art as static files for the dashboard: every Polestar glyph
// (64 px) and the Nav textures MapView's pin atlas loads. Run from anywhere:
//   node services/dash/tools/export-media.cjs services/dash/ui/public
const fs = require('node:fs');
const path = require('node:path');
const glyphs = require('../../../tools/planner/glyphs');
const ui = require('../../../tools/media/ui');
const out = process.argv[2];
fs.mkdirSync(path.join(out, 'glyph'), { recursive: true });
fs.mkdirSync(path.join(out, 'media', 'Nav'), { recursive: true });
let n = 0;
const names = new Set([...Object.keys(ui.GLYPHS || {}), 'character', 'clock', 'map', 'route', 'play', 'pause']);
for (const name of names) {
	const png = glyphs.renderGlyph(name, 64);
	if (png) { fs.writeFileSync(path.join(out, 'glyph', `${name}.png`), png); n++; }
}
for (const t of ['arrow', 'arrow-glow', 'glow', 'pin', 'pin-fill', 'ring']) {
	const png = glyphs.mediaPng('Nav', t);
	if (png) fs.writeFileSync(path.join(out, 'media', 'Nav', `${t}.png`), png);
}
console.log(`${n} glyphs -> ${out}`);
