// Drift-free corpus grader. The standing corpus flow captures each bundle's
// original.jpg (snapshot-bundles) and its output.html (run-pipeline) in separate
// browser sessions, often far apart in time, so a live site that changed between the
// two shows up as a score gap that is drift, not a pipeline defect. SSIM against a
// stale reference therefore cannot be trusted to measure fidelity.
//
// This harness removes the drift. For each bundle it loads the live page ONCE in the
// extension context, screenshots the target element (the ground truth) and snips it in
// that same page state, then grades the snip against that fresh reference in memory.
// Any remaining gap is real pipeline behavior, not drift. Nothing on disk is touched.
// This is a measurement, not a re-capture.
//
// Requires `npm run build`. Run: `node tests/corpus-fair.mjs [--only <substr>]`.

import { chromium } from 'playwright';
import sharp from 'sharp';
import ssimLib from 'ssim.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderTarget, toRawRGBA, inkCoverage } from './render-diff.mjs';

const ssim = ssimLib.default ?? ssimLib;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(HERE, '..', 'dist');
const DATA_DIR = path.join(os.homedir(), 'Downloads', 'training-data');
const SCORES_PATH = path.join(HERE, 'scores.jsonl');
const RUNNER_TIMEOUT_MS = 60_000;
const SETTLE_MS = 400;
const INK_FLOOR = 0.02;
const REF_INK_MIN = 0.02;

function readSource(source) {
	return {
		url: source.url ?? source.page?.url,
		selector: source.selector ?? source.element?.selector,
		viewport: source.viewport ?? source.page?.viewport ?? {},
	};
}

async function findBundles(dataDir, only) {
	const bundles = [];
	for (const tier of await fs.readdir(dataDir, { withFileTypes: true })) {
		if (!tier.isDirectory()) continue;
		const tierDir = path.join(dataDir, tier.name);
		for (const c of await fs.readdir(tierDir, { withFileTypes: true })) {
			if (!c.isDirectory()) continue;
			try {
				let raw = await fs.readFile(path.join(tierDir, c.name, 'source.json'), 'utf8');
				if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
				bundles.push({ tier: tier.name, name: c.name, source: JSON.parse(raw) });
			} catch {
				// The source.json is missing or unreadable, so skip it.
			}
		}
	}
	const filtered = only ? bundles.filter((b) => `${b.tier}/${b.name}`.includes(only)) : bundles;
	filtered.sort((a, b) => (a.tier + a.name).localeCompare(b.tier + b.name));
	return filtered;
}

// Load the page once, screenshot the element (reference), then snip it in the same
// page state. Both reflect the identical live render, so there is no drift between them.
async function captureAndSnip(context, bundle, tmpDir) {
	const src = readSource(bundle.source);
	const viewport = { width: src.viewport.width || 1280, height: src.viewport.height || 800 };
	const page = await context.newPage();
	await page.setViewportSize(viewport);
	try {
		await page.goto(src.url, { waitUntil: 'load', timeout: 30000 });
		await page.evaluate(() => document.fonts.ready);
		await page.waitForTimeout(SETTLE_MS);

		const locator = page.locator(src.selector).first();
		if ((await locator.count()) === 0) throw new Error(`selector matched 0 elements: ${src.selector}`);
		// This is non-fatal. An element that never settles (a looping carousel) would time
		// out, but the snip's own settle still scrolls it, so grade it rather than dropping
		// the bundle.
		await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
		await page.waitForTimeout(SETTLE_MS);
		const refPng = await locator.screenshot({ type: 'png', timeout: 15000 });

		const result = await page.evaluate(
			({ selector, timeoutMs }) =>
				new Promise((resolve) => {
					const handler = (ev) => {
						document.removeEventListener('snip-extension:result', handler);
						clearTimeout(to);
						resolve(ev.detail);
					};
					const to = setTimeout(() => {
						document.removeEventListener('snip-extension:result', handler);
						resolve({ ok: false, error: 'timeout' });
					}, timeoutMs);
					document.addEventListener('snip-extension:result', handler);
					document.dispatchEvent(new CustomEvent('snip-runner:snip', { detail: { selector, mode: 'snip' } }));
				}),
			{ selector: src.selector, timeoutMs: RUNNER_TIMEOUT_MS },
		);
		if (!result?.ok) throw new Error(result?.error || 'snip failed');
		if (result.status === 'unsupported') throw new Error('builder gate: unsupported');

		const outPath = path.join(tmpDir, `${bundle.tier}-${bundle.name}.html`);
		await fs.writeFile(outPath, result.html, 'utf8');
		return { refPng, outPath, probe: result.probe, warnings: result.warnings || [] };
	} finally {
		await page.close();
	}
}

async function gradeOne(renderBrowser, refPng, outPath, dpr) {
	const meta = await sharp(refPng).metadata();
	const { width, height } = meta;
	const renderBuf = await renderTarget(renderBrowser, outPath, width, height, dpr);
	const refRaw = await toRawRGBA(refPng, width, height);
	const renderRaw = await toRawRGBA(renderBuf, width, height);
	const ssimScore = ssim({ data: refRaw, width, height }, { data: renderRaw, width, height }).mssim;
	return { ssimScore, ink: inkCoverage(renderRaw, width, height), refInk: inkCoverage(refRaw, width, height) };
}

async function main() {
	const argv = process.argv.slice(2);
	let only, note = 'phase3 fair (drift-free)';
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--only') only = argv[++i];
		else if (argv[i] === '--note') note = argv[++i];
	}
	const bundles = await findBundles(DATA_DIR, only);
	if (bundles.length === 0) throw new Error('no bundles found');

	const byDpr = new Map();
	for (const b of bundles) {
		const dpr = readSource(b.source).viewport.devicePixelRatio || 1;
		if (!byDpr.has(dpr)) byDpr.set(dpr, []);
		byDpr.get(dpr).push(b);
	}

	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snip-fair-'));
	const renderBrowser = await chromium.launch({ headless: true });
	const cases = [];
	try {
		for (const [dpr, group] of byDpr) {
			const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), `snip-fair-ctx-${dpr}-`));
			const context = await chromium.launchPersistentContext(userDataDir, {
				headless: false,
				deviceScaleFactor: dpr,
				args: ['--headless=new', '--no-sandbox', `--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
			});
			try {
				for (const bundle of group) {
					process.stdout.write(`fair ${bundle.tier}/${bundle.name} ... `);
					try {
						const { refPng, outPath, probe } = await captureAndSnip(context, bundle, tmpDir);
						const g = await gradeOne(renderBrowser, refPng, outPath, readSource(bundle.source).viewport.devicePixelRatio || 1);
						const blank = g.ink < INK_FLOOR && g.refInk >= REF_INK_MIN;
						cases.push({ tier: bundle.tier, name: bundle.name, ...g, blank, droppedProps: probe?.droppedProps, droppedEls: probe?.droppedEls });
						console.log(`ssim ${g.ssimScore.toFixed(4)} ink ${(g.ink * 100).toFixed(1)}%${blank ? '  BLANK' : ''}`);
					} catch (err) {
						console.log(`error: ${err.message}`);
						cases.push({ tier: bundle.tier, name: bundle.name, error: err.message });
					}
				}
			} finally {
				await context.close();
				await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
			}
		}
	} finally {
		await renderBrowser.close();
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}

	const scored = cases.filter((c) => !c.error);
	const meanSsim = scored.reduce((s, c) => s + c.ssimScore, 0) / (scored.length || 1);
	const blanks = scored.filter((c) => c.blank);
	const below = scored.filter((c) => !c.blank && c.ssimScore < 0.9);

	console.log('\nper-case (drift-free):');
	for (const c of cases) {
		if (c.error) console.log(`  ${c.tier.padEnd(12)} ${c.name.padEnd(18)} error: ${c.error}`);
		else console.log(`  ${c.tier.padEnd(12)} ${c.name.padEnd(18)} ssim ${c.ssimScore.toFixed(4)}  ink ${(c.ink * 100).toFixed(1)}%${c.blank ? '  BLANK' : ''}`);
	}
	console.log(`\nmean ssim (n=${scored.length}, failed=${cases.length - scored.length}): ${meanSsim.toFixed(4)}`);
	console.log('success criteria:');
	console.log(`  no blanks:        ${blanks.length === 0 ? 'PASS' : `FAIL (${blanks.map((c) => `${c.tier}/${c.name}`).join(', ')})`}`);
	console.log(`  mean ssim >=0.97: ${meanSsim >= 0.97 ? 'PASS' : `FAIL (${meanSsim.toFixed(4)})`}`);
	console.log(`  all ssim >=0.90:  ${below.length === 0 ? 'PASS' : `FAIL (${below.map((c) => `${c.tier}/${c.name}=${c.ssimScore.toFixed(2)}`).join(', ')})`}`);

	await fs.appendFile(SCORES_PATH, JSON.stringify({ ranAt: new Date().toISOString(), note, fair: true, cases, aggregate: { cases: scored.length, meanSsim } }) + '\n');
	console.log(`\nappended to ${SCORES_PATH}`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
