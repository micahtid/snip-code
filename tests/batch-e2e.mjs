// Batch end-to-end test: a real multi-select snip through the built extension.
//
// The picker suite covers the pin mechanics and the panel suite covers rendering, but the
// sequential batch runner in content/index.ts only exists when the whole extension is
// loaded. This drives it for real: the built extension runs on a local page, the picker is
// started the way the panel starts it, two elements are shift-pinned with real input, and
// the shipped SNIP_RESULT is read back from the service worker. Requires `npm run build`.
// Run with `npm run test:batch`.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(HERE, '..', 'dist');

// Two plain cards, far enough apart that a click lands unambiguously in each, plus a third
// carrying a framer fingerprint so a batch can contain a builder-gated element. The gate is
// subtree-scoped, so one card on an otherwise ordinary page is genuinely gated on its own.
const PAGE = `<!doctype html><meta charset="utf-8"><title>batch fixture</title><style>
	body { margin: 0; font: 14px system-ui; background: #fff; }
	.card { position: absolute; top: 40px; width: 200px; height: 120px; border-radius: 8px; }
	#one { left: 40px; background: #dbeafe; color: #1e3a8a; }
	#two { left: 300px; background: #dcfce7; color: #14532d; }
	#three { left: 560px; background: #fee2e2; color: #7f1d1d; }
</style>
<div class="card" id="one">first card</div>
<div class="card" id="two">second card</div>
<div class="card" id="three" data-framer-name="Hero">framer card</div>`;

let context;
let worker;
let server;
let origin;
let userDataDir;

before(async () => {
	try {
		await fs.access(path.join(EXT_DIR, 'manifest.json'));
	} catch {
		throw new Error('dist/ is not built. Run `npm run build` first.');
	}
	server = http.createServer((_req, res) => {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end(PAGE);
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	origin = `http://127.0.0.1:${server.address().port}/`;

	userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snipcode-batch-'));
	context = await chromium.launchPersistentContext(userDataDir, {
		channel: 'chromium',
		args: ['--headless=new', '--no-sandbox', `--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
	});
	worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));

	// The side panel is what normally receives these, and it is closed here, so the worker
	// records them instead. Every panel-bound signal rides chrome.runtime.onMessage.
	await worker.evaluate(() => {
		self.__snipMessages = [];
		chrome.runtime.onMessage.addListener((message) => {
			self.__snipMessages.push(message);
			return false;
		});
	});
});

after(async () => {
	await context?.close();
	await new Promise((resolve) => server.close(resolve));
	if (userDataDir) await fs.rm(userDataDir, { recursive: true, force: true });
});

/** Click points inside each fixture card, in page coordinates. */
const AT = { one: { x: 140, y: 100 }, two: { x: 400, y: 100 }, three: { x: 660, y: 100 } };

/**
 * Run one multi-select snip: open the fixture, start the picker the way the panel does, pin
 * each point in order, press enter, and wait for the batch result.
 *
 * @param points - the fixture points to pin, in pin order
 * @returns every panel-bound message the worker saw, newest run last
 */
async function runBatch(points) {
	await worker.evaluate(() => (self.__snipMessages = []));
	const page = await context.newPage({ viewport: { width: 800, height: 600 } });
	await page.goto(origin);
	await page.waitForFunction(() => document.documentElement.getAttribute('data-snip-injected') === '1');

	await worker.evaluate(async (url) => {
		const [tab] = await chrome.tabs.query({ url: `${url}*` });
		await chrome.tabs.sendMessage(tab.id, { type: 'SNIPCODE_START_PICKER', mode: 'snip' });
	}, origin);
	// The overlay is built hidden and only paints once the pointer moves, so wait for the
	// node rather than for visibility.
	await page.waitForSelector('#snipcode-overlay', { state: 'attached' });

	// The first click is shift-held to latch multi-select on. Every one after it is plain,
	// which is the whole point of latching: shift never has to stay down.
	await page.keyboard.down('Shift');
	await page.mouse.move(points[0].x, points[0].y);
	await page.mouse.click(points[0].x, points[0].y);
	await page.keyboard.up('Shift');
	await page.waitForTimeout(300); // Let the pin's screenshot capture finish
	for (const at of points.slice(1)) {
		await page.mouse.move(at.x, at.y);
		await page.mouse.click(at.x, at.y);
		await page.waitForTimeout(300);
	}
	await page.keyboard.press('Enter');

	// The overlay tears down as soon as the selection finishes, before the pipeline runs.
	await page.waitForFunction(() => document.getElementById('snipcode-overlay') === null);

	// One full pipeline run per element, sequentially, so allow generous time.
	await worker.evaluate(
		() =>
			new Promise((resolve, reject) => {
				const started = Date.now();
				const tick = () => {
					if (self.__snipMessages.some((m) => m.type === 'SNIP_RESULT')) resolve();
					else if (Date.now() - started > 90000) reject(new Error('no SNIP_RESULT within 90s'));
					else setTimeout(tick, 250);
				};
				tick();
			}),
		null,
	);
	const seen = await worker.evaluate(() => self.__snipMessages);
	await page.close();
	return seen;
}

test('shift-pinning two elements snips both and ships them as one batch result', async () => {
	const seen = await runBatch([AT.one, AT.two]);
	const result = seen.find((m) => m.type === 'SNIP_RESULT').payload;
	assert.equal(result.mode, 'snip');
	assert.equal(result.components.length, 2, `both elements snipped: ${JSON.stringify(result.warnings)}`);
	// Each component is a plain single result, never a nested batch.
	for (const component of result.components) {
		assert.equal(component.components, undefined);
		assert.ok((component.output ?? '').length > 0, 'component carries a self-contained document');
		assert.equal(typeof component.snippetId, 'string');
	}
	// Pin order is preserved, so component 1 is the card that was pinned first.
	assert.match(result.components[0].output, /first card/);
	assert.match(result.components[1].output, /second card/);

	// Selection finished exactly once, and progress was reported per element.
	assert.equal(seen.filter((m) => m.type === 'SNIPCODE_PICKER_SELECTED').length, 1);
	const progress = seen.filter((m) => m.type === 'SNIPCODE_SNIP_PROGRESS').map((m) => m.payload);
	assert.deepEqual(progress, [{ done: 0, total: 2 }, { done: 1, total: 2 }]);

	// Each component was persisted as its own history record, under the id it shipped.
	const stored = await worker.evaluate(async () => (await chrome.storage.local.get('snippets')).snippets ?? []);
	assert.equal(stored.length, 2);
	assert.deepEqual(
		stored.map((r) => r.id).sort(),
		result.components.map((c) => c.snippetId).sort(),
	);
	assert.ok(stored.every((r) => r.saved === undefined), 'a fresh snip lands unsaved');
});

test('a builder-gated element is skipped and the batch carries on', async () => {
	const seen = await runBatch([AT.one, AT.three, AT.two]);
	const result = seen.find((m) => m.type === 'SNIP_RESULT').payload;

	// The gated element contributes no files, and the other two still ship.
	assert.equal(result.components.length, 2);
	assert.match(result.components[0].output, /first card/);
	assert.match(result.components[1].output, /second card/);
	// Its reason rides the existing warnings line, numbered by pin position.
	assert.equal(result.warnings.length, 1);
	assert.match(result.warnings[0], /^component 2 skipped: /);
	assert.match(result.warnings[0], /framer/i);
	// The batch ran all three slots, so progress still counted to the full total.
	const progress = seen.filter((m) => m.type === 'SNIPCODE_SNIP_PROGRESS').map((m) => m.payload);
	assert.deepEqual(progress, [{ done: 0, total: 3 }, { done: 1, total: 3 }, { done: 2, total: 3 }]);
});
