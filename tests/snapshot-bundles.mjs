// snapshot-bundles: for each bundle in training-data/, navigate to the captured
// url at the captured viewport, locate the element by the captured css selector,
// and screenshot just that element (tight crop). saves as original.jpg next to
// source.json (was 0-screenshot.jpg in v1).
//
// run once after capturing a fresh set of source.json files; the grader then has
// a clean ground truth.

import { chromium } from 'playwright';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_DATA_DIR = path.join(os.homedir(), 'Downloads', 'training-data');
const SETTLE_MS = 400; // beat after fonts.ready for heavy layout/animation libs.

/** read source.json supporting both the flat bundle schema and the nested assistive schema. */
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
				// skip
			}
		}
	}
	bundles.sort((a, b) => (a.tier + a.name).localeCompare(b.tier + b.name));
	return bundles;
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
		const pngBuf = await locator.screenshot({ type: 'png', omitBackground: false });

		// re-encode to jpg (matches the original.jpg convention; q92 keeps edges crisp).
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
	const bundles = await findBundles(dataDir);
	if (bundles.length === 0) throw new Error(`no bundles with source.json found under ${dataDir}`);

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
	const results = await snapshotAll();
	const ok = results.filter((r) => r.ok).length;
	console.log(`\ndone. ${ok} ok, ${results.length - ok} failed.`);
	if (results.length - ok > 0) process.exit(1);
}
