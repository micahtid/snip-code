// Run-pipeline: drive the built snipcode v2 extension on each training-data
// bundle and save its deterministic output as output.html (was 4-final-ai.html
// in v1). Uses the headless snip bridge in src/content/index.ts. The runner
// dispatches a "snip-runner:snip" CustomEvent on the page document, the content
// script runs capture -> reconcile -> resolve -> convert(html), and dispatches
// the result on "snip-extension:result". The byok llm polish step is not run,
// so this measures the deterministic pipeline.
//
// window.postMessage and chrome.runtime messages do not cross the content
// script's isolated world. CustomEvents on `document` do (page + content script
// share the document). The script signals readiness via data-snip-injected.
//
// Requires `npm run build` so dist/ is current. Chromium loads extensions only
// via a persistent context, and only under the new headless mode.

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(HERE, '..', 'dist');
const DEFAULT_DATA_DIR = path.join(os.homedir(), 'Downloads', 'training-data');
const RUNNER_TIMEOUT_MS = 60_000;
const SETTLE_MS = 400; // Post-load / post-scroll wait for layout and reveal animations to settle.

/** Read source.json supporting both the flat bundle schema and the nested assistive schema. */
export function readSource(source) {
	return {
		url: source.url ?? source.page?.url,
		selector: source.selector ?? source.element?.selector,
		viewport: source.viewport ?? source.page?.viewport ?? {},
	};
}

export async function findBundles(dataDir = DEFAULT_DATA_DIR) {
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
				if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // Strip utf-8 bom
				bundles.push({ tier: tier.name, name: c.name, dir: path.join(tierDir, c.name), source: JSON.parse(raw) });
			} catch {
				// No source.json, or it is unreadable, so skip
			}
		}
	}
	bundles.sort((a, b) => (a.tier + a.name).localeCompare(b.tier + b.name));
	return bundles;
}

/**
 * Snip one bundle through the built extension. extraDetail is merged into the
 * snip-runner:snip event detail, which is how a caller opts a snip into a phase, such as
 * { minimize: true }, without changing the default grader path.
 */
export async function snipOne(context, bundle, extraDetail = {}) {
	const src = readSource(bundle.source);
	const viewport = { width: src.viewport.width || 1280, height: src.viewport.height || 800 };
	const page = await context.newPage();
	await page.setViewportSize(viewport);
	try {
		await page.goto(src.url, { waitUntil: 'load', timeout: 30000 });
		await page.evaluate(() => document.fonts.ready);
		await page.waitForTimeout(SETTLE_MS); // Settle post-load layout (animation libs, etc.)

		const injected = await page.evaluate(
			() => document.documentElement.getAttribute('data-snip-injected') === '1',
		);
		if (!injected) throw new Error('extension content script did not inject');

		// Scroll the target into view before snipping, the same as snapshot-bundles and
		// corpus-fair do. A reveal-on-scroll animation only fires once its element enters
		// the viewport, so snipping a still-off-screen element captures its pre-reveal
		// state (opacity 0, translated) and the output renders blank. This is non-fatal. An
		// element that never settles is still snipped, just without the extra wait.
		const locator = page.locator(src.selector).first();
		await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
		await page.waitForTimeout(SETTLE_MS);

		const result = await page.evaluate(
			({ selector, timeoutMs, extra }) =>
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
					document.dispatchEvent(new CustomEvent('snip-runner:snip', { detail: { selector, mode: 'snip', ...extra } }));
				}),
			{ selector: src.selector, timeoutMs: RUNNER_TIMEOUT_MS, extra: extraDetail },
		);

		if (!result?.ok) throw new Error(result?.error || 'unknown failure');
		if (result.status === 'unsupported') throw new Error(`builder gate: unsupported (${(result.warnings || []).join(',')})`);
		return { html: result.html, htmlBaseline: result.htmlBaseline, files: result.files, warnings: result.warnings || [], probe: result.probe, emittedProbe: result.emittedProbe, minimize: result.minimize };
	} finally {
		await page.close();
	}
}

/** Throw with a build hint unless dist/ carries a built extension manifest. */
export async function ensureBuilt() {
	try {
		await fs.access(path.join(EXT_DIR, 'manifest.json'));
	} catch {
		throw new Error(`extension build not found at ${EXT_DIR}. run "npm run build" first.`);
	}
}

/**
 * Launch a persistent chromium context with the built extension loaded at the given dpr,
 * returning the context and its temp user-data dir for cleanup. Chromium runs extensions
 * only under a persistent context and only in the new headless mode, so headless:false
 * suppresses the classic flag and --headless=new is passed explicitly. Dpr is fixed at
 * context creation, so one context serves one dpr.
 */
export async function launchExtensionContext(dpr = 1) {
	const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), `snip-run-${dpr}-`));
	const context = await chromium.launchPersistentContext(userDataDir, {
		headless: false,
		deviceScaleFactor: dpr,
		args: ['--headless=new', '--no-sandbox', `--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
	});
	return { context, userDataDir };
}

/**
 * Write a split-asset file set into a bundle directory: index.html plus each lifted
 * icon-N.svg / image-N.ext / font-N.ext, so the training data carries the same split the
 * sidebar ships. Text files (html, svg) write verbatim. Binary files (images, fonts) decode
 * their data uri to bytes, base64 or url-encoded, and write binary, so the relative
 * references in index.html resolve.
 */
async function writeBundleFiles(dir, files) {
	for (const file of files) {
		const target = path.join(dir, file.name);
		if (file.dataUrl) {
			const comma = file.dataUrl.indexOf(',');
			const meta = file.dataUrl.slice(0, comma);
			const payload = file.dataUrl.slice(comma + 1);
			const bytes = /;base64/i.test(meta) ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
			await fs.writeFile(target, bytes);
		} else if (file.text !== undefined) {
			await fs.writeFile(target, file.text, 'utf8');
		}
	}
}

export async function runAll(opts = {}) {
	const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
	let bundles = await findBundles(dataDir);
	// --only <substring>: restrict to bundles whose "tier/name" contains the substring,
	// so a single cluster can be re-snipped cheaply during the measurement loop.
	if (opts.only) bundles = bundles.filter((b) => `${b.tier}/${b.name}`.includes(opts.only));
	if (bundles.length === 0) throw new Error(`no bundles with source.json found under ${dataDir}` + (opts.only ? ` matching "${opts.only}"` : ''));
	await ensureBuilt();

	// One persistent context per devicePixelRatio (dpr is fixed at context creation).
	const byDpr = new Map();
	for (const b of bundles) {
		const dpr = readSource(b.source).viewport.devicePixelRatio || 1;
		if (!byDpr.has(dpr)) byDpr.set(dpr, []);
		byDpr.get(dpr).push(b);
	}

	const results = [];
	for (const [dpr, group] of byDpr) {
		const { context, userDataDir } = await launchExtensionContext(dpr);
		try {
			for (const bundle of group) {
				process.stdout.write(`pipeline ${bundle.tier}/${bundle.name} ... `);
				try {
					const { html, files, warnings, probe, emittedProbe } = await snipOne(context, bundle);
					await fs.writeFile(path.join(bundle.dir, 'output.html'), html, 'utf8');
					// Also persist the split delivery shape (index.html + lifted assets), the
					// same files the sidebar presents, so the training data exercises that path.
					if (files) await writeBundleFiles(bundle.dir, files);
					// Sidecar: the completeness-probe counts the grader folds in (drift-free).
					if (probe) {
						await fs.writeFile(
							path.join(bundle.dir, 'probe.json'),
							JSON.stringify({ droppedProps: probe.droppedProps, droppedEls: probe.droppedEls, unresolvedResources: probe.unresolvedResources, topProps: probe.topProps, samples: probe.samples }, null, 2),
							'utf8',
						);
					}
					// Sidecar: the emitted-artifact probe, diffing the shipped BEM artifact vs
					// live (delta A) and vs the inline clone (delta B), aggregated by classify.mjs.
					if (emittedProbe) {
						await fs.writeFile(path.join(bundle.dir, 'emitted-probe.json'), JSON.stringify(emittedProbe, null, 2), 'utf8');
					}
					const probeNote = probe ? ` [drop ${probe.droppedProps}p/${probe.droppedEls}e/res${probe.unresolvedResources ?? 0}]` : '';
					const emitNote = emittedProbe ? ` [emit A${emittedProbe.deltaA.droppedProps}/B${emittedProbe.deltaB.droppedProps}/abs${emittedProbe.absentProps}]` : '';
					console.log(`${(html.length / 1024).toFixed(1)} KB` + (warnings.length ? ` (${warnings.length} warn)` : '') + probeNote + emitNote);
					results.push({ ok: true, tier: bundle.tier, name: bundle.name, bytes: html.length });
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					console.log(`error: ${msg}`);
					results.push({ ok: false, tier: bundle.tier, name: bundle.name, error: msg });
				}
			}
		} finally {
			await context.close();
			await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
		}
	}
	return results;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	const argv = process.argv.slice(2);
	let only;
	for (let i = 0; i < argv.length; i++) if (argv[i] === '--only') only = argv[++i];
	const results = await runAll({ only });
	const ok = results.filter((r) => r.ok).length;
	console.log(`\ndone. ${ok} ok, ${results.length - ok} failed.`);
	if (results.length - ok > 0) process.exit(1);
}
