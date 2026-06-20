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
 * Dismisses cookie/consent popups before the screenshot so they do not pollute the
 * reference (the snipped element never includes them). Best-effort and conservative:
 * clicks the common accept buttons, then removes only elements whose id/class matches a
 * consent pattern AND that float over the page (fixed/sticky/high z-index) or are a
 * fixed modal dialog. Never throws; a page with no popup is unchanged.
 *
 * @param page - the loaded page
 */
async function dismissConsent(page) {
	// Two passes with a wait between: cookie banners and chat widgets often mount after
	// load, so a single early pass misses them.
	for (let pass = 0; pass < 2; pass++) {
		const acceptSelectors = ['#onetrust-accept-btn-handler', '#truste-consent-button', '[aria-label="Accept all"]', '[aria-label="Accept All"]', '[aria-label="Accept all cookies"]'];
		for (const sel of acceptSelectors) {
			await page.locator(sel).first().click({ timeout: 700 }).catch(() => {});
		}
		for (const re of [/^accept all/i, /^accept all cookies/i, /^accept cookies/i, /^accept$/i, /^i agree/i, /^got it/i, /^allow all/i]) {
			await page.getByRole('button', { name: re }).first().click({ timeout: 700 }).catch(() => {});
		}
		await page.evaluate(() => {
			// Consent banners and floating chat/support widgets, neither of which is part
			// of a snipped component. Matched only when they float over the page.
			const pat = /(cookie|consent|gdpr|onetrust|truste|\bcmp\b|cky-|privacy-banner|usercentrics|cookiebot|livechat|intercom|drift|zendesk|zsiq|olark|tawk|chat-widget|chat-launcher|messenger|helpscout|beacon)/i;
			const floats = (cs) => cs.position === 'fixed' || cs.position === 'sticky' || Number(cs.zIndex) > 100;
			for (const el of Array.from(document.querySelectorAll('[id],[class]'))) {
				const id = el.id || '';
				const cls = typeof el.className === 'string' ? el.className : '';
				if (!pat.test(id) && !pat.test(cls)) continue;
				if (floats(getComputedStyle(el))) el.remove();
			}
			for (const el of Array.from(document.querySelectorAll('[role="dialog"],[aria-modal="true"]'))) {
				if (getComputedStyle(el).position === 'fixed') el.remove();
			}
			// Floating widgets are often bare iframes (live chat); drop fixed ones.
			for (const f of Array.from(document.querySelectorAll('iframe'))) {
				const cs = getComputedStyle(f);
				if (cs.position === 'fixed' && (Number(cs.zIndex) > 100 || cs.bottom !== 'auto')) f.remove();
			}
		}).catch(() => {});
		await page.waitForTimeout(pass === 0 ? 900 : 300);
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
		await dismissConsent(page);

		const locator = page.locator(src.selector).first();
		if ((await locator.count()) === 0) throw new Error(`selector matched 0 elements: ${src.selector}`);
		await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
		// Settle again after scrolling: a reveal-on-scroll animation only fires once its
		// element enters the viewport, so shooting immediately captures a mid-fade frame
		// (a washed-out, low-opacity reference). The same wait the snip side now uses.
		await page.waitForTimeout(SETTLE_MS);
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
