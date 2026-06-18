// Run-pipeline: drive the built snipcode v2 extension on each training-data
// bundle and save its deterministic output as output.html (was 4-final-ai.html
// in v1). Uses the headless snip bridge in src/content/index.ts: the runner
// dispatches a "snip-runner:snip" CustomEvent on the page document, the content
// script runs capture -> reconcile -> resolve -> convert(html), and dispatches
// the result on "snip-extension:result". The byok llm polish step is not run,
// so this measures the deterministic pipeline.
//
// window.postMessage and chrome.runtime messages do not cross the content
// script's isolated world; CustomEvents on `document` do (page + content script
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
				if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // Strip utf-8 bom
				bundles.push({ tier: tier.name, name: c.name, dir: path.join(tierDir, c.name), source: JSON.parse(raw) });
			} catch {
				// No source.json or unreadable; skip
			}
		}
	}
	bundles.sort((a, b) => (a.tier + a.name).localeCompare(b.tier + b.name));
	return bundles;
}

async function snipOne(context, bundle) {
	const src = readSource(bundle.source);
	const viewport = { width: src.viewport.width || 1280, height: src.viewport.height || 800 };
	const page = await context.newPage();
	await page.setViewportSize(viewport);
	try {
		await page.goto(src.url, { waitUntil: 'load', timeout: 30000 });
		await page.evaluate(() => document.fonts.ready);
		await page.waitForTimeout(400); // Settle post-load layout (animation libs, etc.)

		const injected = await page.evaluate(
			() => document.documentElement.getAttribute('data-snip-injected') === '1',
		);
		if (!injected) throw new Error('extension content script did not inject');

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

		if (!result?.ok) throw new Error(result?.error || 'unknown failure');
		if (result.status === 'unsupported') throw new Error(`builder gate: unsupported (${(result.warnings || []).join(',')})`);
		return { html: result.html, htmlBem: result.htmlBem, warnings: result.warnings || [] };
	} finally {
		await page.close();
	}
}

export async function runAll(opts = {}) {
	const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
	const bundles = await findBundles(dataDir);
	if (bundles.length === 0) throw new Error(`no bundles with source.json found under ${dataDir}`);
	try {
		await fs.access(path.join(EXT_DIR, 'manifest.json'));
	} catch {
		throw new Error(`extension build not found at ${EXT_DIR}. run "npm run build" first.`);
	}

	// One persistent context per devicePixelRatio (dpr is fixed at context creation).
	const byDpr = new Map();
	for (const b of bundles) {
		const dpr = readSource(b.source).viewport.devicePixelRatio || 1;
		if (!byDpr.has(dpr)) byDpr.set(dpr, []);
		byDpr.get(dpr).push(b);
	}

	const results = [];
	for (const [dpr, group] of byDpr) {
		const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), `snip-run-${dpr}-`));
		// Classic headless does not run extensions; --headless=new does. Pass
		// headless:false to suppress the old flag, then add --headless=new ourselves.
		const context = await chromium.launchPersistentContext(userDataDir, {
			headless: false,
			deviceScaleFactor: dpr,
			args: ['--headless=new', '--no-sandbox', `--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
		});
		try {
			for (const bundle of group) {
				process.stdout.write(`pipeline ${bundle.tier}/${bundle.name} ... `);
				try {
					const { html, htmlBem, warnings } = await snipOne(context, bundle);
					await fs.writeFile(path.join(bundle.dir, 'output.html'), html, 'utf8');
					// The bem variant grades the formatter's class-display reflow path, which
					// the inline-styled html output never exercises (see render-diff --target).
					if (htmlBem) await fs.writeFile(path.join(bundle.dir, 'output-bem.html'), htmlBem, 'utf8');
					console.log(`${(html.length / 1024).toFixed(1)} KB` + (warnings.length ? ` (${warnings.length} warn)` : ''));
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
	const results = await runAll();
	const ok = results.filter((r) => r.ok).length;
	console.log(`\ndone. ${ok} ok, ${results.length - ok} failed.`);
	if (results.length - ok > 0) process.exit(1);
}
