// Forced-state fidelity check for the measured-interactive-states work. Renders a static
// output.html, screenshots it at rest, then forces :hover (and optionally :active) on a marker
// element via Playwright's own CDP — the artifact is static, so its state is reproduced exactly
// by forcing the pseudo — and screenshots again. The before/after pair is the re-runnable
// fidelity measurement the feedback loop reads by eye (the corpus grader only scores resting).
//
// Usage: node tests/verify-state.mjs <output.html> <markerSelector> [width] [height] [state]
//   e.g. node tests/verify-state.mjs .../hoverdev-3/output.html '[data-snip-state="1"]' 360 240 hover

import { chromium } from 'playwright';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [htmlPath, selector, w = '420', h = '260', state = 'hover'] = process.argv.slice(2);
if (!htmlPath || !selector) {
	console.error('usage: node tests/verify-state.mjs <output.html> <markerSelector> [width] [height] [state]');
	process.exit(1);
}
const width = Number(w);
const height = Number(h);
const outDir = process.env.SHOT_DIR || path.dirname(htmlPath);

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
const page = await context.newPage();
try {
	await page.goto(pathToFileURL(path.resolve(htmlPath)).href, { waitUntil: 'load' });
	await page.evaluate(() => document.fonts.ready);
	await page.screenshot({ path: path.join(outDir, 'state-rest.png') });

	const client = await context.newCDPSession(page);
	await client.send('DOM.enable');
	await client.send('CSS.enable');
	const { root } = await client.send('DOM.getDocument', { depth: -1 });
	const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector });
	if (!nodeId) throw new Error(`marker not found: ${selector}`);
	await client.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: state.split(',') });
	// Let any baked transition settle to its end value before the shot.
	await page.waitForTimeout(500);
	await page.screenshot({ path: path.join(outDir, `state-${state.replace(/,/g, '-')}.png`) });
	console.log(`wrote state-rest.png and state-${state.replace(/,/g, '-')}.png to ${outDir}`);
} finally {
	await context.close();
	await browser.close();
}
