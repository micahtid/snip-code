// Local fixture harness: the drift-free regression gate from FIDELITY-PLAN.md.
//
// The 23-bundle live corpus drifts run to run (sites change, captures vary), so a
// raw SSIM delta there can mislead. These fixtures are static local pages served
// over loopback http, so a snip's output is a pure function of the pipeline code:
// zero drift, any score change is a real code effect. Each fixture isolates one
// root cause (token resolution, inherited typography, background image, lazy image,
// scroll reveal).
//
// For each fixture this harness:
//   1. captures the native browser render of the element (the ground truth),
//   2. snips it through the built extension and grades the output against that truth,
//   3. snips it a second time and asserts the two outputs are byte-identical
//      (the determinism gate: the transform must be deterministic).
//
// Requires `npm run build` so dist/ is current. Run: `node tests/fixtures.mjs`.

import { chromium } from 'playwright';
import sharp from 'sharp';
import ssimLib from 'ssim.js';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderTarget, toRawRGBA, inkCoverage } from './render-diff.mjs';

const ssim = ssimLib.default ?? ssimLib;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, 'fixtures');
const EXT_DIR = path.resolve(HERE, '..', 'dist');
const OUT_DIR = path.join(FIXTURE_DIR, '.out'); // Generated artifacts (gitignored).
const RUNNER_TIMEOUT_MS = 30_000;
const SETTLE_MS = 400;

/**
 * One fixture per root cause. `settle` describes how the native reference is brought
 * to its visible state (scroll for reveal-gated content); the snip path must reach
 * the same state on its own once the relevant change lands.
 */
const FIXTURES = [
	{ name: 'token', selector: '.card', viewport: { width: 900, height: 600 } },
	{ name: 'inherited-font', selector: '.text', viewport: { width: 900, height: 520 } },
	{ name: 'bg-image', selector: '.hero', viewport: { width: 900, height: 520 } },
	{ name: 'lazy-img', selector: '.shot', viewport: { width: 900, height: 520 } },
	{ name: 'reveal', selector: '.panel', viewport: { width: 900, height: 760 }, scroll: true },
	{ name: 'dead-font', selector: '.card', viewport: { width: 900, height: 520 } },
	{ name: 'escaped-gradient', selector: '.card', viewport: { width: 900, height: 360 } },
	{ name: 'object-fit-img', selector: '.cell img', viewport: { width: 900, height: 400 } },
	{ name: 'escaped-bg-tile', selector: '.card', viewport: { width: 900, height: 360 } },
];

/** Generate the shared tile.png the bg-image and lazy-img fixtures reference, if absent. */
async function ensureTile() {
	const tile = path.join(FIXTURE_DIR, 'tile.png');
	try {
		await fs.access(tile);
		return;
	} catch {
		// Generate a distinctive two-tone tile so a lost image reads as obviously blank.
		const w = 240, h = 240;
		const buf = Buffer.alloc(w * h * 3);
		for (let y = 0; y < h; y++) {
			for (let x = 0; x < w; x++) {
				const i = (y * w + x) * 3;
				const diag = (x + y) % 80 < 40;
				buf[i] = diag ? 31 : 111;
				buf[i + 1] = diag ? 111 : 60;
				buf[i + 2] = diag ? 235 : 173;
			}
		}
		await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toFile(tile);
	}
}

/** Serve the fixture directory over loopback http; returns { server, base }. */
async function serve() {
	const server = http.createServer(async (req, res) => {
		const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
		const file = path.join(FIXTURE_DIR, rel || 'index.html');
		try {
			const body = await fs.readFile(file);
			const ext = path.extname(file);
			const type = ext === '.html' ? 'text/html' : ext === '.png' ? 'image/png' : 'application/octet-stream';
			res.writeHead(200, { 'content-type': type });
			res.end(body);
		} catch {
			res.writeHead(404);
			res.end('not found');
		}
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();
	return { server, base: `http://127.0.0.1:${port}` };
}

/** Native browser render of the fixture element, the drift-free ground truth (jpg). */
async function captureReference(browser, url, fx) {
	const context = await browser.newContext({ viewport: fx.viewport, deviceScaleFactor: 1, reducedMotion: 'reduce' });
	const page = await context.newPage();
	try {
		await page.goto(url, { waitUntil: 'load' });
		await page.evaluate(() => document.fonts.ready);
		await page.waitForTimeout(SETTLE_MS);
		const locator = page.locator(fx.selector).first();
		await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
		await page.waitForTimeout(SETTLE_MS); // Let a scroll-gated reveal finish.
		const pngBuf = await locator.screenshot({ type: 'png' });
		return await sharp(pngBuf).jpeg({ quality: 92 }).toBuffer();
	} finally {
		await context.close();
	}
}

/** Snip the fixture element through the extension; returns { html, probe }. */
async function snipFixture(context, url, fx) {
	const page = await context.newPage();
	await page.setViewportSize(fx.viewport);
	try {
		await page.goto(url, { waitUntil: 'load', timeout: 30000 });
		await page.evaluate(() => document.fonts.ready);
		await page.waitForTimeout(SETTLE_MS);
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
			{ selector: fx.selector, timeoutMs: RUNNER_TIMEOUT_MS },
		);
		if (!result?.ok) throw new Error(result?.error || 'snip failed');
		return { html: result.html, probe: result.probe };
	} finally {
		await page.close();
	}
}

/** Score a rendered output.html (on disk) against the reference jpg buffer. */
async function gradeHtml(browser, htmlPath, refBuf) {
	const meta = await sharp(refBuf).metadata();
	const { width, height } = meta;
	const renderBuf = await renderTarget(browser, htmlPath, width, height);
	const refRaw = await toRawRGBA(refBuf, width, height);
	const renderRaw = await toRawRGBA(renderBuf, width, height);
	const ssimScore = ssim({ data: refRaw, width, height }, { data: renderRaw, width, height }).mssim;
	return { ssimScore, ink: inkCoverage(renderRaw, width, height), refInk: inkCoverage(refRaw, width, height), width, height };
}

export async function runFixtures() {
	try {
		await fs.access(path.join(EXT_DIR, 'manifest.json'));
	} catch {
		throw new Error(`extension build not found at ${EXT_DIR}. run "npm run build" first.`);
	}
	await ensureTile();
	await fs.mkdir(OUT_DIR, { recursive: true });
	const { server, base } = await serve();

	const refBrowser = await chromium.launch({ headless: true });
	const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snip-fx-'));
	const extContext = await chromium.launchPersistentContext(userDataDir, {
		headless: false,
		deviceScaleFactor: 1,
		args: ['--headless=new', '--no-sandbox', `--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
	});

	const rows = [];
	try {
		for (const fx of FIXTURES) {
			const url = `${base}/${fx.name}.html`;
			const row = { name: fx.name };
			try {
				const refBuf = await captureReference(refBrowser, url, fx);
				await fs.writeFile(path.join(OUT_DIR, `${fx.name}.ref.jpg`), refBuf);

				const first = await snipFixture(extContext, url, fx);
				const second = await snipFixture(extContext, url, fx);
				row.deterministic = first.html === second.html;
				row.droppedProps = first.probe?.droppedProps ?? null;
				row.droppedEls = first.probe?.droppedEls ?? null;

				const outPath = path.join(OUT_DIR, `${fx.name}.out.html`);
				await fs.writeFile(outPath, first.html);
				const g = await gradeHtml(refBrowser, outPath, refBuf);
				row.ssim = g.ssimScore;
				row.ink = g.ink;
				row.refInk = g.refInk;
				row.blank = g.ink < 0.02 && g.refInk >= 0.02;
			} catch (err) {
				row.error = err instanceof Error ? err.message : String(err);
			}
			rows.push(row);
		}
	} finally {
		await extContext.close();
		await refBrowser.close();
		await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
		server.close();
	}
	return rows;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	const rows = await runFixtures();
	console.log('\nfixture results:');
	for (const r of rows) {
		if (r.error) {
			console.log(`  ${r.name.padEnd(16)} error: ${r.error}`);
			continue;
		}
		const det = r.deterministic ? 'det' : 'NON-DET';
		const blank = r.blank ? '  BLANK' : '';
		console.log(
			`  ${r.name.padEnd(16)} ssim ${r.ssim.toFixed(4)}  ink ${(r.ink * 100).toFixed(1)}%  drop ${r.droppedProps}p/${r.droppedEls}e  ${det}${blank}`,
		);
	}
	const det = rows.every((r) => r.error || r.deterministic);
	console.log(`\ndeterminism: ${det ? 'PASS (all byte-identical)' : 'FAIL'}`);
}
