// M1 verification: the split index.html must be render-faithful to the inlined output.html.
//
// Both come from the same frozen snip (one capture), so any difference is the asset split's
// doing, never live drift. Externalizing an inline svg to an <img> or a data-uri image to a
// file cannot be pixel-identical: an <img>-rendered svg has an anti-aliasing floor, a
// translucent surface with backdrop-filter over a lifted asset repaints slightly, and an
// inline <img> and an inline <svg> settle a line box a sub-pixel apart. So the gate is
// structural, not pixel-exact: element counts must match, no element may move or resize
// beyond a few pixels of that inline-layout floor, and every lifted image must load. A real
// in-flow regression (a mis-sized lifted asset) cascades into many, growing shifts and is
// still caught; the isolated sub-pixel jitter of a faithful split is not. The pixel diff is
// reported for transparency but does not fail the gate.
//
// Run after `node tests/run-pipeline.mjs` so the split files exist.

// The inline-layout floor: an inline <img> settles within a few pixels of the inline <svg>
// it replaced. A genuine regression exceeds this on many elements at once, not just one.
const SHIFT_TOLERANCE = 8;

import { chromium } from 'playwright';
import pixelmatch from 'pixelmatch';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findBundles, readSource } from './run-pipeline.mjs';

/** Boxes of every element that is neither an svg/img nor inside an svg: the stable page chrome
 * whose layout an asset split must not disturb. Plus the srcs of any <img> that failed to load. */
const PAGE_PROBE = () => {
	const insideSvg = (el) => { for (let p = el.parentElement; p; p = p.parentElement) if (p.tagName.toLowerCase() === 'svg') return true; return false; };
	const chrome = [];
	for (const el of document.querySelectorAll('*')) {
		const tag = el.tagName.toLowerCase();
		if (tag === 'svg' || tag === 'img' || insideSvg(el)) continue;
		const r = el.getBoundingClientRect();
		chrome.push({ tag, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
	}
	const broken = [...document.querySelectorAll('img')].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.getAttribute('src'));
	return { chrome, broken };
};

async function probeAndShoot(browser, htmlPath, viewport, dpr) {
	const context = await browser.newContext({ viewport, deviceScaleFactor: dpr, reducedMotion: 'reduce' });
	const page = await context.newPage();
	try {
		await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
		await page.evaluate(() => document.fonts.ready).catch(() => {});
		const probe = await page.evaluate(PAGE_PROBE);
		const shot = await page.screenshot({ type: 'png', fullPage: true, animations: 'disabled', caret: 'hide' });
		return { probe, shot };
	} finally {
		await context.close();
	}
}

async function pixelDiff(a, b) {
	const dec = async (buf) => { const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); return { data, w: info.width, h: info.height }; };
	const x = await dec(a), y = await dec(b);
	if (x.w !== y.w || x.h !== y.h) return -1;
	return pixelmatch(x.data, y.data, null, x.w, x.h, { threshold: 0.1, includeAA: false });
}

/**
 * Structural verdict for one bundle: the number of chrome elements whose box shifts past the
 * inline-layout tolerance and the largest shift seen. A mismatched element count, or any
 * element beyond tolerance, is a regression; isolated sub-pixel jitter is the floor.
 */
function shiftReport(a, b) {
	if (a.length !== b.length) return { fatal: `element count ${a.length} vs ${b.length}`, over: 0, max: 0 };
	let over = 0, max = 0;
	for (let i = 0; i < a.length; i++) {
		const d = Math.max(Math.abs(a[i].x - b[i].x), Math.abs(a[i].y - b[i].y), Math.abs(a[i].w - b[i].w), Math.abs(a[i].h - b[i].h));
		if (d > max) max = d;
		if (d > SHIFT_TOLERANCE) over++;
	}
	return { fatal: null, over, max };
}

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined;
let bundles = await findBundles();
if (only) bundles = bundles.filter((b) => `${b.tier}/${b.name}`.includes(only));

const browser = await chromium.launch({ headless: true });
const rows = [];
try {
	for (const b of bundles) {
		const inlined = path.join(b.dir, 'output.html');
		const split = path.join(b.dir, 'index.html');
		try { await fs.access(split); } catch { rows.push({ key: `${b.tier}/${b.name}`, skip: 'no index.html' }); continue; }
		const src = readSource(b.source);
		const dpr = src.viewport.devicePixelRatio || 1;
		const viewport = { width: src.viewport.width || 1280, height: src.viewport.height || 800 };
		try {
			const out = await probeAndShoot(browser, inlined, viewport, dpr);
			const idx = await probeAndShoot(browser, split, viewport, dpr);
			const shift = shiftReport(out.probe.chrome, idx.probe.chrome);
			const broken = idx.probe.broken;
			const px = await pixelDiff(out.shot, idx.shot);
			rows.push({ key: `${b.tier}/${b.name}`, shift, broken, px });
		} catch (err) {
			rows.push({ key: `${b.tier}/${b.name}`, error: err.message });
		}
	}
} finally {
	await browser.close();
}

let fails = 0;
for (const r of rows) {
	if (r.skip) { console.log(`  ${r.key.padEnd(26)} SKIP (${r.skip})`); continue; }
	if (r.error) { fails++; console.log(`  ${r.key.padEnd(26)} ERROR ${r.error}`); continue; }
	const structural = !r.shift.fatal && r.shift.over === 0 && r.broken.length === 0;
	if (!structural) fails++;
	const floor = r.px === 0 ? 'exact' : `floor ${r.px}px`;
	const detail = r.shift.fatal ? `SHIFT ${r.shift.fatal}` : r.shift.over ? `SHIFT ${r.shift.over} el >${SHIFT_TOLERANCE}px (max ${r.shift.max})` : r.broken.length ? `BROKEN ${r.broken.join(',')}` : `${floor} (max shift ${r.shift.max}px)`;
	console.log(`  ${r.key.padEnd(26)} ${structural ? 'PASS' : 'FAIL'}  ${detail}`);
}
console.log(`\nsplit-render gate (structural parity): ${fails === 0 ? 'PASS' : `FAIL (${fails} bundles)`}`);
process.exit(fails === 0 ? 0 : 1);
