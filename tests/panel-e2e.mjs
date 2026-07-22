// Panel end-to-end tests: the side panel rendering a snip result and a history list.
//
// This drives the real built side panel, dist/index.html, in a headless chromium with the
// extension loaded, so react, the storage layer, and the rendering all run as they ship.
// Results are delivered the way the content script delivers them, as a runtime message, and
// the assertions read the rendered dom. Requires `npm run build` so dist/ is current.
// Run with `npm run test:panel`.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(HERE, '..', 'dist');

let context;
let userDataDir;
let extensionId;
let worker;

before(async () => {
	try {
		await fs.access(path.join(EXT_DIR, 'manifest.json'));
	} catch {
		throw new Error('dist/ is not built. Run `npm run build` first.');
	}
	userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snipcode-panel-'));
	context = await chromium.launchPersistentContext(userDataDir, {
		channel: 'chromium',
		args: ['--headless=new', '--no-sandbox', `--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
	});
	// The extension id is only knowable once its service worker registers. The worker doubles
	// as the message sender below, since chrome.runtime.sendMessage never delivers to the
	// context it was called from, so the panel cannot post a result to itself.
	worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
	extensionId = new URL(worker.url()).host;
});

after(async () => {
	await context?.close();
	if (userDataDir) await fs.rm(userDataDir, { recursive: true, force: true });
});

/** Open a fresh side panel with the given snippets already in storage. */
async function openPanel(snippets = []) {
	const page = await context.newPage();
	await page.goto(`chrome-extension://${extensionId}/index.html`);
	await page.evaluate(async (records) => await chrome.storage.local.set({ snippets: records }), snippets);
	await page.reload();
	await page.waitForSelector('nav button');
	return page;
}

/** Send a runtime message from the service worker, which the panel receives as the real thing. */
async function send(message) {
	await worker.evaluate(async (msg) => {
		await chrome.runtime.sendMessage(msg).catch(() => {});
	}, message);
}

/** Deliver a snip result the way the content script does, then wait for it to render. */
async function shipResult(page, payload) {
	await send({ type: 'SNIP_RESULT', payload });
	await page.waitForSelector('pre code, [role="tablist"]', { timeout: 5000 });
}

/** A minimal stored record, shaped as storeSnippet writes it. */
function record(id, title, saved) {
	const rec = {
		id,
		capturedAt: '2026-07-01T10:00:00.000Z',
		page: { url: `https://example.com/${id}`, title, viewport: { width: 800, height: 600, devicePixelRatio: 1 }, userAgent: 'ua' },
		element: { tagName: 'div', selector: '#x', rect: { x: 0, y: 0, width: 10, height: 10 } },
		output: { format: 'html', html: `<p>${id}</p>` },
		screenshot: '',
	};
	if (saved) rec.saved = true;
	return rec;
}

/** A single-snip result payload, as runPipelineOne returns it. */
function single(snippetId, html = '<p>one</p>') {
	return { mode: 'snip', format: 'html', html, css: 'p{color:red}', output: `<!doctype html>${html}`, snippetId, warnings: [] };
}

test('a single snip renders its code and an unsaved bookmark', async () => {
	const page = await openPanel();
	await shipResult(page, single('id-1'));

	assert.match(await page.textContent('pre code'), /<p>one<\/p>/);
	const save = page.locator('button[aria-label="Save snippet"]');
	assert.equal(await save.count(), 1);
	assert.equal(await save.getAttribute('aria-pressed'), 'false');
	// One file means no tab bar, exactly as before this feature.
	assert.equal(await page.locator('[role="tablist"]').count(), 0);
	await page.close();
});

test('the bookmark toggles the stored saved flag both ways', async () => {
	const page = await openPanel([record('id-1', 'Example')]);
	await shipResult(page, single('id-1'));

	await page.click('button[aria-label="Save snippet"]');
	await page.waitForSelector('button[aria-label="Unsave snippet"]');
	let stored = await page.evaluate(async () => (await chrome.storage.local.get('snippets')).snippets);
	assert.equal(stored[0].saved, true);

	await page.click('button[aria-label="Unsave snippet"]');
	await page.waitForSelector('button[aria-label="Save snippet"]');
	stored = await page.evaluate(async () => (await chrome.storage.local.get('snippets')).snippets);
	assert.equal(stored[0].saved, false);
	await page.close();
});

test('a batch renders folder-style tabs over every component', async () => {
	const page = await openPanel();
	await shipResult(page, {
		mode: 'snip',
		warnings: ['component 3 skipped: built with framer'],
		components: [
			{ mode: 'snip', format: 'html', output: '<p>a</p>', snippetId: 'id-a', files: [
				{ name: 'index.html', language: 'html', text: '<p>a</p>' },
				{ name: 'icon-1.svg', language: 'svg', text: '<svg id="a"/>' },
			] },
			{ mode: 'snip', format: 'html', output: '<p>b</p>', snippetId: 'id-b', files: [
				{ name: 'index.html', language: 'html', text: '<p>b</p>' },
				{ name: 'icon-1.svg', language: 'svg', text: '<svg id="b"/>' },
			] },
		],
	});

	const labels = await page.locator('[role="tab"]').allTextContents();
	assert.deepEqual(labels, ['component-1/index.html', 'component-1/icon-1.svg', 'component-2/index.html', 'component-2/icon-1.svg']);
	// Same-named files across components stay distinct, which flat file-name keys would break.
	assert.match(await page.textContent('pre code'), /<p>a<\/p>/);
	await page.locator('[role="tab"]').nth(3).click();
	await page.waitForFunction(() => document.querySelector('pre code').textContent.includes('svg id="b"'));
	// The batch warning about the skipped element is surfaced, no new error ui.
	assert.match(await page.textContent('body'), /1 Warning/);
	await page.close();
});

test('the bookmark saves the active component of a batch', async () => {
	const page = await openPanel([record('id-a', 'A'), record('id-b', 'B')]);
	await shipResult(page, {
		mode: 'snip',
		components: [
			{ mode: 'snip', format: 'html', output: '<p>a</p>', snippetId: 'id-a' },
			{ mode: 'snip', format: 'html', output: '<p>b</p>', snippetId: 'id-b' },
		],
	});

	await page.locator('[role="tab"]').nth(1).click(); // Switch to component 2
	await page.click('button[aria-label="Save snippet"]');
	await page.waitForSelector('button[aria-label="Unsave snippet"]');
	const stored = await page.evaluate(async () => (await chrome.storage.local.get('snippets')).snippets);
	assert.equal(stored.find((r) => r.id === 'id-b').saved, true);
	assert.ok(!stored.find((r) => r.id === 'id-a').saved); // Only the active component was saved

	// Switching back to component 1 shows its own, still unsaved, bookmark.
	await page.locator('[role="tab"]').nth(0).click();
	await page.waitForSelector('button[aria-label="Save snippet"]');
	await page.close();
});

test('a batch where every element failed shows the empty state and its reasons', async () => {
	const page = await openPanel();
	await send({
		type: 'SNIP_RESULT',
		payload: { mode: 'snip', components: [], warnings: ['component 1 skipped: built with framer', 'component 2 failed: boom'] },
	});
	await page.waitForFunction(() => document.body.textContent.includes('2 Warnings'));
	assert.equal(await page.locator('pre code').count(), 0);
	await page.close();
});

test('history splits into Saved and History with live counts', async () => {
	const page = await openPanel([record('h1', 'First'), record('s1', 'Kept', true), record('h2', 'Second')]);
	await page.click('nav button[aria-label="History"]');
	await page.waitForSelector('.sc-history-card');

	const sections = await page.locator('.sc-section-title').allTextContents();
	assert.deepEqual(sections, ['Saved (1)', 'History (2)']);
	// Newest first inside each section.
	const titles = await page.locator('.sc-history-card').allTextContents();
	assert.match(titles[0], /Kept/);
	assert.match(titles[1], /Second/);
	assert.match(titles[2], /First/);
	await page.close();
});

test('saving from a history card moves it into the Saved section', async () => {
	const page = await openPanel([record('h1', 'First'), record('h2', 'Second')]);
	await page.click('nav button[aria-label="History"]');
	await page.waitForSelector('.sc-history-card');
	assert.deepEqual(await page.locator('.sc-section-title').allTextContents(), ['History (2)']);

	// The first card is the newest, Second.
	await page.locator('.sc-history-card').first().locator('button[aria-label="Save snippet"]').click();
	await page.waitForFunction(() => document.querySelectorAll('.sc-section-title').length === 2);
	assert.deepEqual(await page.locator('.sc-section-title').allTextContents(), ['Saved (1)', 'History (1)']);
	const stored = await page.evaluate(async () => (await chrome.storage.local.get('snippets')).snippets);
	assert.equal(stored.find((r) => r.id === 'h2').saved, true);
	await page.close();
});

test('clear history keeps the saved snippets', async () => {
	const page = await openPanel([record('h1', 'First'), record('s1', 'Kept', true), record('h2', 'Second')]);
	await page.click('nav button[aria-label="History"]');
	await page.waitForSelector('.sc-history-card');

	const clear = page.getByRole('button', { name: 'Clear History' });
	assert.equal(await clear.count(), 1);
	await clear.click();
	await page.waitForFunction(() => document.querySelectorAll('.sc-history-card').length === 1);
	assert.deepEqual(await page.locator('.sc-section-title').allTextContents(), ['Saved (1)']);
	const stored = await page.evaluate(async () => (await chrome.storage.local.get('snippets')).snippets);
	assert.deepEqual(stored.map((r) => r.id), ['s1']);
	await page.close();
});

test('an empty store still shows the history empty state', async () => {
	const page = await openPanel([]);
	await page.click('nav button[aria-label="History"]');
	await page.waitForTimeout(200);
	assert.equal(await page.locator('.sc-history-card').count(), 0);
	assert.equal(await page.locator('.sc-section-title').count(), 0);
	await page.close();
});
