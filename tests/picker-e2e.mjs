// Picker end-to-end tests: the shift multi-select mechanics in content/capture/picker.ts.
//
// The picker is pure dom and pointer behaviour, so it is exercised in a real headless
// chromium rather than a fake dom: the module is bundled on its own with esbuild, loaded
// into a plain page next to a chrome.runtime stub that answers CAPTURE_SCREENSHOT, and
// driven with real mouse and keyboard input so every event carries the shiftKey bit the
// finish rule reads. Run with `npm run test:picker`.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';
import { chromium } from 'playwright';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PICKER_SRC = path.resolve(HERE, '..', 'src', 'content', 'capture', 'picker.ts');
// A 1x1 transparent png, the fake viewport capture the stubbed background worker returns.
const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Three cards in a row plus a button nested inside the first, so a test can pin siblings
// and a parent/child pair. Fixed positions keep the click coordinates predictable.
const PAGE = `<!doctype html><meta charset="utf-8"><style>
	body { margin: 0; background: #fff; }
	.card { position: absolute; top: 40px; width: 160px; height: 120px; background: #eef; }
	#a { left: 40px; } #b { left: 240px; } #c { left: 440px; }
	#inner { position: absolute; left: 20px; top: 70px; width: 100px; height: 30px; background: #99f; }
</style>
<div class="card" id="a"><div id="inner"></div></div>
<div class="card" id="b"></div>
<div class="card" id="c"></div>`;

/** Click points inside each fixture element, in page coordinates. */
const AT = {
	a: { x: 120, y: 70 },
	inner: { x: 110, y: 125 },
	b: { x: 320, y: 100 },
	c: { x: 520, y: 100 },
	empty: { x: 700, y: 300 },
};

let browser;
let bundle;
let server;
let origin;

before(async () => {
	// The fixture is served from 127.0.0.1 rather than set inline, because about:blank is not
	// a secure context and the picker mints its message ids with crypto.randomUUID, which
	// only exists in one. Loopback counts as secure, so this matches a real https page.
	server = http.createServer((_req, res) => {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end(PAGE);
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	origin = `http://127.0.0.1:${server.address().port}/`;

	const built = await esbuild.build({
		entryPoints: [PICKER_SRC],
		bundle: true,
		format: 'iife',
		globalName: 'SnipPicker',
		platform: 'browser',
		target: 'es2022',
		write: false,
		logLevel: 'silent',
	});
	bundle = built.outputFiles[0].text;
	browser = await chromium.launch({ headless: true });
});

after(async () => {
	await browser?.close();
	await new Promise((resolve) => server.close(resolve));
});

/**
 * Open a page with the picker loaded and activated.
 *
 * @param options - { multi } forwarded to the picker, so a test can check both modes
 * @returns the playwright page, with window.__events recording every callback
 */
async function openPicker({ multi = true } = {}) {
	const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
	await page.goto(origin);
	await page.addScriptTag({ content: bundle });
	await page.evaluate(
		({ png, multi }) => {
			window.__events = { selected: [], many: null, cancelled: 0 };
			// What the picker chrome looked like each time a capture was requested. Every piece
			// of chrome is a fixed-position body child, so a visible one here would mean the
			// outline leaked into the screenshot.
			window.__chromeVisibleAtCapture = [];
			window.chrome = {
				runtime: {
					sendMessage: async () => {
						window.__chromeVisibleAtCapture.push(
							Array.from(document.body.children).filter(
								(el) => el.style.position === 'fixed' && el.style.display !== 'none',
							).length,
						);
						return { ok: true, result: { dataUrl: png } };
					},
				},
			};
			const picker = new window.SnipPicker.ElementPicker({
				multi,
				onSelect: (element, screenshot) => window.__events.selected.push({ id: element.id, screenshot }),
				onSelectMany: (picks) => {
					window.__events.many = picks.map((p) => ({ id: p.element.id, screenshot: p.screenshot }));
				},
				onCancel: () => (window.__events.cancelled += 1),
			});
			window.__picker = picker;
			picker.activate();
		},
		{ png: PNG_1X1, multi },
	);
	return page;
}

/** Shift-click a fixture point, waiting for the pin's queued screenshot to land. */
async function shiftClick(page, at) {
	await page.keyboard.down('Shift');
	await page.mouse.move(at.x, at.y);
	await page.mouse.click(at.x, at.y);
	await page.waitForFunction(() => window.__picker.pins.every((pin) => pin.screenshot !== ''));
}

/** The badge text of every pin box currently in the dom, in pin order. */
function badges(page) {
	return page.evaluate(() => window.__picker.pins.map((pin) => pin.badge.textContent));
}

test('a plain click still snips one element', async () => {
	const page = await openPicker();
	await page.mouse.move(AT.b.x, AT.b.y);
	await page.mouse.click(AT.b.x, AT.b.y);
	await page.waitForFunction(() => window.__events.selected.length === 1);

	const events = await page.evaluate(() => window.__events);
	assert.equal(events.selected[0].id, 'b');
	assert.ok(events.selected[0].screenshot.startsWith('data:image/png'));
	assert.equal(events.many, null);
	// The overlay tears itself down on select.
	assert.equal(await page.evaluate(() => document.getElementById('snipcode-overlay')), null);
	await page.close();
});

test('shift-click pins instead of snipping, and releasing shift ships the batch in pin order', async () => {
	const page = await openPicker();
	await shiftClick(page, AT.b);
	await shiftClick(page, AT.c);

	// Still selecting: nothing has been snipped and both pins are outlined and numbered.
	assert.deepEqual(await page.evaluate(() => window.__events.selected), []);
	assert.deepEqual(await badges(page), ['1', '2']);

	await page.keyboard.up('Shift');
	await page.waitForFunction(() => window.__events.many !== null);
	const many = await page.evaluate(() => window.__events.many);
	assert.deepEqual(many.map((p) => p.id), ['b', 'c']);
	assert.ok(many.every((p) => p.screenshot.startsWith('data:image/png')));
	// The batch ships through onSelectMany only, never as single selects.
	assert.deepEqual(await page.evaluate(() => window.__events.selected), []);
	// Overlay and every pin box are gone once the selection finishes.
	assert.equal(await page.evaluate(() => document.querySelectorAll('div[style*="fixed"]').length), 0);
	await page.close();
});

test('every pin is captured with the picker chrome hidden', async () => {
	const page = await openPicker();
	await shiftClick(page, AT.b);
	await shiftClick(page, AT.c);
	const visible = await page.evaluate(() => window.__chromeVisibleAtCapture);
	assert.equal(visible.length, 2);
	assert.deepEqual(visible, [0, 0]); // No overlay, guide, tooltip, or pin box on screen
	await page.close();
});

test('shift-clicking a pinned element unpins it and the badges re-flow', async () => {
	const page = await openPicker();
	await shiftClick(page, AT.b);
	await shiftClick(page, AT.c);
	await shiftClick(page, AT.b); // Toggle the first pin back off
	assert.deepEqual(await badges(page), ['1']);
	assert.deepEqual(await page.evaluate(() => window.__picker.pins.map((p) => p.element.id)), ['c']);

	await page.keyboard.up('Shift');
	await page.waitForFunction(() => window.__events.many !== null);
	assert.deepEqual(await page.evaluate(() => window.__events.many.map((p) => p.id)), ['c']);
	await page.close();
});

test('releasing shift with no pins leaves single-click mode running', async () => {
	const page = await openPicker();
	await page.keyboard.down('Shift');
	await page.mouse.move(AT.b.x, AT.b.y);
	await page.keyboard.up('Shift');
	await page.mouse.move(AT.b.x + 2, AT.b.y);

	assert.equal(await page.evaluate(() => window.__events.many), null);
	assert.ok(await page.evaluate(() => document.getElementById('snipcode-overlay') !== null));

	// The picker is still live, so a plain click snips as usual.
	await page.mouse.click(AT.b.x, AT.b.y);
	await page.waitForFunction(() => window.__events.selected.length === 1);
	assert.equal(await page.evaluate(() => window.__events.selected[0].id), 'b');
	await page.close();
});

test('nested pins are allowed, a parent and its child both ship', async () => {
	const page = await openPicker();
	await shiftClick(page, AT.inner); // The nested button
	await page.keyboard.down('Shift');
	await page.mouse.move(AT.a.x, AT.a.y);
	// The cursor sits over the card itself here, not the nested button, so this pins the card.
	await page.mouse.click(AT.a.x, AT.a.y);
	await page.waitForFunction(() => window.__picker.pins.length === 2 && window.__picker.pins.every((p) => p.screenshot !== ''));

	await page.keyboard.up('Shift');
	await page.waitForFunction(() => window.__events.many !== null);
	assert.deepEqual(await page.evaluate(() => window.__events.many.map((p) => p.id)), ['inner', 'a']);
	await page.close();
});

test('esc cancels the whole selection, pins included', async () => {
	const page = await openPicker();
	await shiftClick(page, AT.b);
	await shiftClick(page, AT.c);
	await page.keyboard.press('Escape');

	assert.equal(await page.evaluate(() => window.__events.cancelled), 1);
	assert.equal(await page.evaluate(() => window.__events.many), null);
	assert.equal(await page.evaluate(() => window.__picker.pins.length), 0);
	assert.equal(await page.evaluate(() => document.querySelectorAll('div[style*="fixed"]').length), 0);
	await page.close();
});

test('a panel-side cancel clears the pins too', async () => {
	const page = await openPicker();
	await shiftClick(page, AT.b);
	await page.evaluate(() => window.__picker.deactivate()); // What CANCEL_PICKER runs
	assert.equal(await page.evaluate(() => window.__picker.pins.length), 0);
	assert.equal(await page.evaluate(() => document.querySelectorAll('div[style*="fixed"]').length), 0);
	await page.close();
});

test('pinned outlines are re-measured after a scroll', async () => {
	const page = await openPicker();
	await page.evaluate(() => (document.body.style.height = '2000px'));
	await shiftClick(page, AT.b);
	const before = await page.evaluate(() => window.__picker.pins[0].box.style.transform);

	await page.evaluate(() => window.scrollTo(0, 200));
	// The picker settles 150ms after the last scroll event, then repositions.
	await page.waitForFunction(
		(prev) => window.__picker.pins[0].box.style.transform !== prev && window.__picker.pins[0].box.style.opacity === '1',
		before,
		{ timeout: 3000 },
	);
	const after = await page.evaluate(() => ({
		boxTop: window.__picker.pins[0].box.getBoundingClientRect().top,
		elementTop: window.__picker.pins[0].element.getBoundingClientRect().top,
	}));
	assert.ok(Math.abs(after.boxTop - after.elementTop) < 2, 'the pin box tracks its element after a scroll');
	await page.close();
});

test('without multi, shift-click snips a single element as before', async () => {
	// Assistive mode keeps single-pick behaviour: n clipboard writes would overwrite each other.
	const page = await openPicker({ multi: false });
	await page.keyboard.down('Shift');
	await page.mouse.move(AT.b.x, AT.b.y);
	await page.mouse.click(AT.b.x, AT.b.y);
	await page.waitForFunction(() => window.__events.selected.length === 1);
	assert.equal(await page.evaluate(() => window.__events.selected[0].id), 'b');
	assert.equal(await page.evaluate(() => window.__events.many), null);
	await page.close();
});

test('the arrow climb still works while pinning', async () => {
	const page = await openPicker();
	await page.keyboard.down('Shift');
	await page.mouse.move(AT.inner.x, AT.inner.y);
	await page.keyboard.press('ArrowUp'); // Climb from the nested button to its card
	await page.mouse.click(AT.inner.x, AT.inner.y);
	await page.waitForFunction(() => window.__picker.pins.length === 1 && window.__picker.pins[0].screenshot !== '');
	assert.equal(await page.evaluate(() => window.__picker.pins[0].element.id), 'a');
	await page.close();
});
