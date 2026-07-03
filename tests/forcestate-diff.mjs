// Forced-state neutrality check: force a pseudo-state on a marker in two output.html files,
// the pre- and post-change renders from the same capture, and pixel-diff the result. Used to
// verify a transform the resting oracle cannot see, such as the withheld-rule merge (M4),
// leaves the interactive-state render unchanged. Zero diff is the pass.
//
// Usage: node tests/forcestate-diff.mjs <pre.html> <post.html> <markerSelector> <w> <h> <state>
//   state is a comma list of forced pseudo-classes, e.g. hover  or  focus-visible  or  hover,active
import { chromium } from 'playwright';
import pixelmatch from 'pixelmatch';
import sharp from 'sharp';
import { pathToFileURL } from 'node:url';

const [preHtml, postHtml, selector, w = '400', h = '300', state = 'hover'] = process.argv.slice(2);
const width = Number(w), height = Number(h);

async function forcedShot(browser, htmlPath) {
	const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
	const page = await context.newPage();
	await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
	await page.evaluate(() => document.fonts.ready);
	const client = await context.newCDPSession(page);
	await client.send('DOM.enable'); await client.send('CSS.enable');
	const { root } = await client.send('DOM.getDocument', { depth: -1 });
	const { nodeIds } = await client.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector });
	if (!nodeIds || nodeIds.length === 0) throw new Error(`marker not found: ${selector}`);
	for (const nodeId of nodeIds) await client.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: state.split(',') });
	await page.waitForTimeout(600);
	// animations: 'disabled' finishes any hover transition to its end state and freezes it, so
	// the comparison is of the settled state the hover lands on, not a timing-dependent frame.
	const buf = await page.screenshot({ animations: 'disabled', caret: 'hide' });
	await context.close();
	return buf;
}
async function raw(buf) { const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); return { data, w: info.width, h: info.height }; }

const browser = await chromium.launch({ headless: true });
try {
	const a = await raw(await forcedShot(browser, preHtml));
	const b = await raw(await forcedShot(browser, postHtml));
	if (a.w !== b.w || a.h !== b.h) console.log(`SIZE MISMATCH ${a.w}x${a.h} vs ${b.w}x${b.h}`);
	else console.log(`forced-[${state}] pre-vs-post diff: ${pixelmatch(a.data, b.data, null, a.w, a.h, { threshold: 0.1, includeAA: false })}px`);
} finally { await browser.close(); }
