// Minimize-loop: measure the deterministic minimize phase over the training-data corpus.
//
// For each bundle this harness snips once through the built extension, which returns both
// the pre-minimize shipped document and the minimized one from that single capture, then:
//   1. reads the minimizer's own stats: declarations and chars before and after, and the
//      minimize wall time,
//   2. runs the tolerant pixel backstop: renders the pre-minimize and minimized documents
//      full-page and requires zero diff pixels at pixelmatch threshold 0.1, so any render
//      change the per-element oracle missed is caught here,
//   3. records one JSONL row.
//
// The backstop compares pre against post minimization from the same capture, so it
// measures exactly what minimization changed and is immune to live-capture drift.
// Determinism of the transform is gated separately by tests/fixtures.mjs on drift-free
// local pages, so this harness does not re-check it.
//
// Requires `npm run build` so dist/ is current. Run: `node tests/minimize-loop.mjs`
// (optionally `--only <substring>` to restrict to one cluster).

import { chromium } from 'playwright';
import pixelmatch from 'pixelmatch';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findBundles, readSource, snipOne, launchExtensionContext, ensureBuilt } from './run-pipeline.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_PATH = path.join(HERE, 'minimize-scores.jsonl');

/** Render a document full-page in headless chromium at the capture viewport and dpr. */
async function fullPageShot(browser, htmlPath, viewport, dpr) {
	const context = await browser.newContext({ viewport, deviceScaleFactor: dpr, reducedMotion: 'reduce' });
	const page = await context.newPage();
	try {
		await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
		await page.evaluate(() => document.fonts.ready);
		return await page.screenshot({ type: 'png', fullPage: true, animations: 'disabled', caret: 'hide' });
	} finally {
		await context.close();
	}
}

/** Decode a png buffer to raw rgba with its dimensions. */
async function decode(buf) {
	const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	return { data, width: info.width, height: info.height };
}

/**
 * The tolerant pixel backstop: zero diff pixels at threshold 0.1 between the pre-minimize
 * and post-minimize renders. Returns the diff-pixel count, or -1 when the two renders
 * differ in size, which is itself a failure.
 */
async function backstopDiff(before, after) {
	const a = await decode(before);
	const b = await decode(after);
	if (a.width !== b.width || a.height !== b.height) return -1;
	return pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1, includeAA: false });
}

async function measureBundle(extContext, refBrowser, bundle, tmpDir, dpr) {
	const src = readSource(bundle.source);
	const viewport = { width: src.viewport.width || 1280, height: src.viewport.height || 800 };

	const on = await snipOne(extContext, bundle);
	const stats = on.minimize;
	if (!stats) throw new Error('minimize stats absent; is the build current?');
	if (!on.htmlBaseline) throw new Error('pre-minimize baseline absent; is the build current?');

	// Drift-free backstop: pre-minimize and post-minimize documents come from the SAME
	// capture, so any pixel difference is minimization, never a live-site change between snips.
	const key = `${bundle.tier}-${bundle.name}`;
	const beforePath = path.join(tmpDir, `${key}.before.html`);
	const afterPath = path.join(tmpDir, `${key}.after.html`);
	await fs.writeFile(beforePath, on.htmlBaseline, 'utf8');
	await fs.writeFile(afterPath, on.html, 'utf8');
	const beforeShot = await fullPageShot(refBrowser, beforePath, viewport, dpr);
	const afterShot = await fullPageShot(refBrowser, afterPath, viewport, dpr);
	const diffPixels = await backstopDiff(beforeShot, afterShot);

	const declRemovalPct = stats.declsBefore ? (100 * (stats.declsBefore - stats.declsAfter)) / stats.declsBefore : 0;
	const charShrinkPct = stats.charsBefore ? (100 * (stats.charsBefore - stats.charsAfter)) / stats.charsBefore : 0;
	return {
		tier: bundle.tier,
		name: bundle.name,
		declsBefore: stats.declsBefore,
		declsAfter: stats.declsAfter,
		declRemovalPct,
		charsBefore: stats.charsBefore,
		charsAfter: stats.charsAfter,
		charShrinkPct,
		ms: stats.ms,
		diffPixels,
		backstopPass: diffPixels === 0,
		warnings: on.warnings,
	};
}

export async function runMinimizeLoop(opts = {}) {
	await ensureBuilt();
	let bundles = await findBundles();
	if (opts.only) bundles = bundles.filter((b) => `${b.tier}/${b.name}`.includes(opts.only));
	if (bundles.length === 0) throw new Error('no bundles found' + (opts.only ? ` matching "${opts.only}"` : ''));

	const byDpr = new Map();
	for (const b of bundles) {
		const dpr = readSource(b.source).viewport.devicePixelRatio || 1;
		if (!byDpr.has(dpr)) byDpr.set(dpr, []);
		byDpr.get(dpr).push(b);
	}

	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snip-min-'));
	const refBrowser = await chromium.launch({ headless: true });
	const rows = [];
	try {
		for (const [dpr, group] of byDpr) {
			const { context, userDataDir } = await launchExtensionContext(dpr);
			try {
				for (const bundle of group) {
					process.stdout.write(`minimize ${bundle.tier}/${bundle.name} ... `);
					try {
						const row = await measureBundle(context, refBrowser, bundle, tmpDir, dpr);
						rows.push(row);
						console.log(
							`decls ${row.declsBefore}->${row.declsAfter} (${row.declRemovalPct.toFixed(0)}%)  ` +
								`chars ${(row.charsBefore / 1024).toFixed(1)}->${(row.charsAfter / 1024).toFixed(1)}KB (${row.charShrinkPct.toFixed(0)}%)  ` +
								`${row.ms.toFixed(0)}ms  backstop ${row.backstopPass ? 'PASS' : `FAIL(${row.diffPixels})`}`,
						);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						console.log(`error: ${msg}`);
						rows.push({ tier: bundle.tier, name: bundle.name, error: msg });
					}
				}
			} finally {
				await context.close();
				await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
			}
		}
	} finally {
		await refBrowser.close();
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}
	return rows;
}

/** Print the corpus aggregate and the declaration-removal gate verdict, and append a history line. */
async function report(rows) {
	const scored = rows.filter((r) => !r.error);
	const meanRemoval = scored.reduce((s, r) => s + r.declRemovalPct, 0) / (scored.length || 1);
	const meanShrink = scored.reduce((s, r) => s + r.charShrinkPct, 0) / (scored.length || 1);
	const backstopFails = scored.filter((r) => !r.backstopPass);
	const maxMs = scored.reduce((m, r) => Math.max(m, r.ms), 0);

	console.log(`\naggregate (n=${scored.length}, errors=${rows.length - scored.length}):`);
	console.log(`  mean decl removal: ${meanRemoval.toFixed(1)}%`);
	console.log(`  mean char shrink:  ${meanShrink.toFixed(1)}%`);
	console.log(`  max minimize time: ${maxMs.toFixed(0)}ms`);
	console.log('\nM1 gate:');
	console.log(`  mean decl removal >=50%:  ${meanRemoval >= 50 ? 'PASS' : `FAIL (${meanRemoval.toFixed(1)}%)`}`);
	console.log(`  zero backstop failures:   ${backstopFails.length === 0 ? 'PASS' : `FAIL (${backstopFails.map((r) => `${r.tier}/${r.name}=${r.diffPixels}`).join(', ')})`}`);

	await fs.appendFile(RESULTS_PATH, JSON.stringify({ ranAt: new Date().toISOString(), rows }) + '\n');
	console.log(`\nappended to ${RESULTS_PATH}`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	const argv = process.argv.slice(2);
	let only;
	for (let i = 0; i < argv.length; i++) if (argv[i] === '--only') only = argv[++i];
	const rows = await runMinimizeLoop({ only });
	await report(rows);
}
