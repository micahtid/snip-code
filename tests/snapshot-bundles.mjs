// Snapshot-bundles: for each bundle in training-data/, navigate to the captured
// url at the captured viewport, locate the element by the captured css selector,
// and screenshot just that element (tight crop). Saves as original.jpg next to
// source.json (was 0-screenshot.jpg in v1).
//
// Run once after capturing a fresh set of source.json files; the grader then has
// a clean ground truth.

import { chromium } from 'playwright';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_DATA_DIR = path.join(os.homedir(), 'Downloads', 'training-data');
const SETTLE_MS = 400; // Beat after fonts.ready for heavy layout/animation libs.

/** Read source.json supporting both the flat bundle schema and the nested assistive schema. */
function readSource(source) {
	return {
		url: source.url ?? source.page?.url,
		selector: source.selector ?? source.element?.selector,
		viewport: source.viewport ?? source.page?.viewport ?? {},
	};
}

async function findBundles(dataDir) {
	const bundles = [];
	const tiers = await fs.readdir(dataDir, { withFileTypes: true });
	for (const tier of tiers) {
		if (!tier.isDirectory()) continue;
		const tierDir = path.join(dataDir, tier.name);
		const cases = await fs.readdir(tierDir, { withFileTypes: true });
		for (const c of cases) {
			if (!c.isDirectory()) continue;
			const sourcePath = path.join(tierDir, c.name, 'source.json');
			try {
				let raw = await fs.readFile(sourcePath, 'utf8');
				if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
				bundles.push({ tier: tier.name, name: c.name, dir: path.join(tierDir, c.name), source: JSON.parse(raw) });
			} catch {
				// Skip
			}
		}
	}
	bundles.sort((a, b) => (a.tier + a.name).localeCompare(b.tier + b.name));
	return bundles;
}

/**
 * Removes every foreign element painting over the target before the screenshot, so no
 * page chrome (cookie banner, consent modal, sticky nav, chat widget, promo) pollutes the
 * reference. The snipped element never includes them, so a reference that does is wrong
 * ground truth.
 *
 * Universal by construction: an overlay is found by how it paints, never by a name or
 * class pattern (which only ever catches the banners we happened to list). An element is
 * "foreign" when it is neither the target, a descendant (part of the snip), nor an
 * ancestor (removing it would remove the snip). Two paint signals together catch any
 * overlay:
 *  - any foreign element pinned to the viewport (position fixed or sticky), because such
 *    an element pins over an element screenshot at every scroll offset (the sticky-nav
 *    case); and
 *  - any foreign element the browser's own hit-test reports painting above the target
 *    anywhere inside its box (absolute overlays, modal backdrops, top-layer dialogs).
 * Each match is removed at its outermost foreign container, so the whole banner goes, not
 * a leaf. Runs to convergence over a few passes, because removing one layer can reveal
 * another and some banners re-mount on mutation. Must run after the target is scrolled to
 * its final screenshot position, since a sticky overlay's overlap depends on scroll.
 * Never throws; a page with no overlay is unchanged.
 *
 * @param page - the loaded page, already scrolled to the screenshot position
 * @param selector - the target element's css selector
 */
async function removeOverlays(page, selector) {
	for (let pass = 0; pass < 4; pass++) {
		const removed = await page.evaluate((sel) => {
			const target = document.querySelector(sel);
			if (!target) return 0;
			// Foreign: outside the snip's own subtree and not one of its ancestors.
			const isForeign = (el) => !!el && el !== target && !target.contains(el) && !el.contains(target);
			// The outermost still-foreign ancestor, so a whole banner is removed, not a leaf.
			const outermostForeign = (el) => {
				let node = el;
				while (isForeign(node.parentElement)) node = node.parentElement;
				return node;
			};
			const roots = new Set();

			// Signal 1: viewport-pinned chrome pollutes an element screenshot at any scroll.
			for (const el of document.documentElement.querySelectorAll('*')) {
				if (!isForeign(el)) continue;
				const position = getComputedStyle(el).position;
				if (position === 'fixed' || position === 'sticky') roots.add(outermostForeign(el));
			}

			// Signal 2: anything the hit-test paints above the target inside its box.
			const rect = target.getBoundingClientRect();
			if (rect.width > 0 && rect.height > 0) {
				const STEP = 20; // Sample density in px, fine enough to catch a thin banner edge.
				const right = Math.min(window.innerWidth - 1, rect.right);
				const bottom = Math.min(window.innerHeight - 1, rect.bottom);
				for (let y = Math.max(0, rect.top); y <= bottom; y += STEP) {
					for (let x = Math.max(0, rect.left); x <= right; x += STEP) {
						const stack = document.elementsFromPoint(x, y);
						// Hits before the target (or all hits, if the target is fully covered here)
						// paint above it.
						const hit = stack.findIndex((el) => el === target || target.contains(el));
						const above = hit === -1 ? stack.length : hit;
						for (let i = 0; i < above; i++) {
							if (isForeign(stack[i])) roots.add(outermostForeign(stack[i]));
						}
					}
				}
			}

			for (const el of roots) el.remove();
			return roots.size;
		}, selector).catch(() => 0);
		if (!removed) break; // Converged: nothing foreign paints over the target.
		await page.waitForTimeout(200); // Let a re-mount settle before the next pass.
	}
}

async function snapshotBundle(browser, bundle) {
	const src = readSource(bundle.source);
	const viewport = { width: src.viewport.width || 1280, height: src.viewport.height || 800 };
	const context = await browser.newContext({
		viewport,
		deviceScaleFactor: src.viewport.devicePixelRatio || 1,
		reducedMotion: 'reduce',
	});
	const page = await context.newPage();
	try {
		await page.goto(src.url, { waitUntil: 'load', timeout: 30000 });
		await page.evaluate(() => document.fonts.ready);
		await page.waitForTimeout(SETTLE_MS);

		const locator = page.locator(src.selector).first();
		if ((await locator.count()) === 0) throw new Error(`selector matched 0 elements: ${src.selector}`);
		await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
		// Settle again after scrolling: a reveal-on-scroll animation only fires once its
		// element enters the viewport, so shooting immediately captures a mid-fade frame
		// (a washed-out, low-opacity reference). The same wait the snip side now uses.
		await page.waitForTimeout(SETTLE_MS);
		// Strip foreign overlays at the final screenshot position: a sticky nav only overlaps
		// the element once it is scrolled into view, so this must run after the scroll, not
		// before. Re-acquire the element box afterward in case removals shifted layout.
		await removeOverlays(page, src.selector);
		await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
		await page.waitForTimeout(120);
		const pngBuf = await locator.screenshot({ type: 'png', omitBackground: false });

		// Re-encode to jpg (matches the original.jpg convention; q92 keeps edges crisp).
		const jpgBuf = await sharp(pngBuf).jpeg({ quality: 92 }).toBuffer();
		await fs.writeFile(path.join(bundle.dir, 'original.jpg'), jpgBuf);
		const meta = await sharp(jpgBuf).metadata();
		return { ok: true, width: meta.width, height: meta.height, bytes: jpgBuf.length };
	} finally {
		await context.close();
	}
}

export async function snapshotAll(opts = {}) {
	const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
	let bundles = await findBundles(dataDir);
	// --only <substring>: restrict to bundles whose "tier/name" contains it, so a few
	// popup-polluted references can be re-captured without redoing the whole corpus.
	if (opts.only) bundles = bundles.filter((b) => `${b.tier}/${b.name}`.includes(opts.only));
	if (bundles.length === 0) throw new Error(`no bundles with source.json found under ${dataDir}` + (opts.only ? ` matching "${opts.only}"` : ''));

	const browser = await chromium.launch({ headless: true });
	const results = [];
	try {
		for (const bundle of bundles) {
			process.stdout.write(`snapshot ${bundle.tier}/${bundle.name} ... `);
			try {
				const r = await snapshotBundle(browser, bundle);
				results.push({ ...r, tier: bundle.tier, name: bundle.name });
				console.log(`${r.width}x${r.height} (${(r.bytes / 1024).toFixed(1)} KB)`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.log(`error: ${msg}`);
				results.push({ ok: false, error: msg, tier: bundle.tier, name: bundle.name });
			}
		}
	} finally {
		await browser.close();
	}
	return results;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	const argv = process.argv.slice(2);
	let only;
	for (let i = 0; i < argv.length; i++) if (argv[i] === '--only') only = argv[++i];
	const results = await snapshotAll({ only });
	const ok = results.filter((r) => r.ok).length;
	console.log(`\ndone. ${ok} ok, ${results.length - ok} failed.`);
	if (results.length - ok > 0) process.exit(1);
}
