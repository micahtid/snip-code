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
	await page.keyboard.up('Shift');
	await page.waitForFunction(() => window.__picker.pins.every((pin) => pin.screenshot !== ''));
}

/** Click a fixture point with no modifier, which pins once multi-select has latched. */
async function plainClick(page, at) {
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

test('shift-click latches multi-select, and enter ships the batch in pin order', async () => {
	const page = await openPicker();
	await shiftClick(page, AT.b);
	// Shift is released between the two, so the second click pins purely because the mode is
	// latched. This is what lets the user scroll, which shift plus wheel would otherwise steal.
	await plainClick(page, AT.c);

	// Still selecting: nothing has been snipped and both pins are outlined and numbered.
	assert.deepEqual(await page.evaluate(() => window.__events.selected), []);
	assert.deepEqual(await badges(page), ['1', '2']);
	// The indicator names the mode, since no held key signals it any more.
	assert.match(await page.textContent('#snipcode-multiselect'), /Multi-Select On · 2 Selected/);

	await page.keyboard.press('Enter');
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

test('the dimming veil keeps a hole for the hover and every pin', async () => {
	const page = await openPicker();
	// One hovered element, no pins yet: the veil has a single hole.
	await page.mouse.move(AT.a.x, AT.a.y);
	await page.waitForFunction(() => document.getElementById('snipcode-scrim')?.style.display === 'block');
	const holesFor = () =>
		page.evaluate(() => {
			// The clip path is one outer rect plus one sub-path per hole; count the extra moves.
			const clip = document.getElementById('snipcode-scrim').style.clipPath;
			return Math.max(0, (clip.match(/M/g) || []).length - 1);
		});
	assert.equal(await holesFor(), 1);

	// Pin b and c, then hover a, a sibling that contains neither: three distinct holes, so the
	// pins stay lit while the pointer is on another element.
	await shiftClick(page, AT.b);
	await plainClick(page, AT.c);
	await page.mouse.move(AT.a.x, AT.a.y);
	await page.waitForFunction(() => window.__picker.current !== null);
	assert.equal(await holesFor(), 3, 'pinned elements lost their holes in the veil');
	await page.close();
});

test('hovering an ancestor of a pin merges its hole instead of blacking it out', async () => {
	const page = await openPicker();
	// Pin the nested button, then hover its containing card.
	await shiftClick(page, AT.inner);
	await page.mouse.move(AT.a.x, AT.a.y);
	await page.waitForFunction(() => window.__picker.current !== null);

	// The card's hole encloses the pinned button, so the two do not become separate holes that
	// would cancel under the even-odd rule and darken the button. One hole lights the whole card.
	const holes = await page.evaluate(() => {
		const clip = document.getElementById('snipcode-scrim').style.clipPath;
		return Math.max(0, (clip.match(/M/g) || []).length - 1);
	});
	assert.equal(holes, 1, 'the ancestor hover and the pin should merge into one hole');
	assert.equal(await page.evaluate(() => window.__picker.pins.length), 1);
	await page.close();
});

test('every pin is captured with the picker chrome hidden', async () => {
	const page = await openPicker();
	await shiftClick(page, AT.b);
	await shiftClick(page, AT.c);
	const visible = await page.evaluate(() => window.__chromeVisibleAtCapture);
	assert.equal(visible.length, 2);
	assert.deepEqual(visible, [0, 0]); // No overlay, scrim, tooltip, or pin box on screen
	await page.close();
});

test('clicking a pinned element unpins it and the badges re-flow', async () => {
	const page = await openPicker();
	await shiftClick(page, AT.b);
	await plainClick(page, AT.c);
	await plainClick(page, AT.b); // Toggle the first pin back off
	assert.deepEqual(await badges(page), ['1']);
	assert.deepEqual(await page.evaluate(() => window.__picker.pins.map((p) => p.element.id)), ['c']);

	await page.keyboard.press('Enter');
	await page.waitForFunction(() => window.__events.many !== null);
	assert.deepEqual(await page.evaluate(() => window.__events.many.map((p) => p.id)), ['c']);
	await page.close();
});

test('unpinning the last element keeps the mode on, and shift then exits it', async () => {
	const page = await openPicker();
	await shiftClick(page, AT.b);
	await plainClick(page, AT.b); // Toggle the only pin back off

	// The mode was entered on purpose, so emptying it is not the same as leaving it.
	assert.equal(await page.evaluate(() => window.__picker.pins.length), 0);
	assert.ok(await page.evaluate(() => document.getElementById('snipcode-multiselect') !== null));

	await page.keyboard.press('Shift');
	await page.waitForFunction(() => document.getElementById('snipcode-multiselect') === null);
	await page.mouse.click(AT.c.x, AT.c.y);
	await page.waitForFunction(() => window.__events.selected.length === 1);
	assert.equal(await page.evaluate(() => window.__events.selected[0].id), 'c');
	await page.close();
});

test('pressing shift again while nothing is selected leaves multi-select', async () => {
	const page = await openPicker();
	await page.mouse.move(AT.b.x, AT.b.y);
	await page.keyboard.press('Shift');
	await page.waitForSelector('#snipcode-multiselect');
	await page.keyboard.press('Shift');
	await page.waitForFunction(() => document.getElementById('snipcode-multiselect') === null);

	// Back in single-click mode, so a plain click snips as usual.
	await page.mouse.click(AT.b.x, AT.b.y);
	await page.waitForFunction(() => window.__events.selected.length === 1);
	assert.equal(await page.evaluate(() => window.__events.selected[0].id), 'b');
	await page.close();
});

test('shift keeps the mode on once something is selected', async () => {
	const page = await openPicker();
	await shiftClick(page, AT.b);
	await page.keyboard.press('Shift'); // Would exit, but a collection is under way.

	assert.equal(await page.evaluate(() => window.__picker.pins.length), 1);
	assert.ok(await page.evaluate(() => document.getElementById('snipcode-multiselect') !== null));
	// Still collecting, so the next plain click pins rather than snipping.
	await plainClick(page, AT.c);
	assert.deepEqual(await badges(page), ['1', '2']);
	assert.deepEqual(await page.evaluate(() => window.__events.selected), []);
	await page.close();
});

test('shift turns multi-select on before any click', async () => {
	const page = await openPicker();
	await page.mouse.move(AT.b.x, AT.b.y);
	await page.keyboard.press('Shift');
	// The mode is on from the key alone, so a plain click after it pins rather than snipping.
	await page.waitForSelector('#snipcode-multiselect');
	// The count shows from the key press, at zero, so the mode is visibly on before any pick.
	assert.match(await page.textContent('#snipcode-multiselect'), /Multi-Select On · 0 Selected/);

	await plainClick(page, AT.b);
	assert.match(await page.textContent('#snipcode-multiselect'), /Multi-Select On · 1 Selected · Enter to Snip/);
	assert.deepEqual(await badges(page), ['1']);
	assert.deepEqual(await page.evaluate(() => window.__events.selected), []);
	await page.close();
});

test('toggleMulti drives the mode the same as a page-side shift', async () => {
	// This is the public method the panel-forwarded TOGGLE_MULTI message invokes, for a shift
	// pressed while the side panel still holds focus, before any pin has moved it to the page.
	const page = await openPicker();
	await page.mouse.move(AT.b.x, AT.b.y);
	await page.evaluate(() => window.__picker.toggleMulti());
	await page.waitForSelector('#snipcode-multiselect');

	// On now: a plain click pins rather than snips.
	await plainClick(page, AT.b);
	assert.deepEqual(await badges(page), ['1']);

	// A pin is down, so toggleMulti must not throw the collection away.
	await page.evaluate(() => window.__picker.toggleMulti());
	assert.equal(await page.evaluate(() => window.__picker.pins.length), 1);
	assert.ok(await page.evaluate(() => document.getElementById('snipcode-multiselect') !== null));
	await page.close();
});

test('the badge stays glued to the corner and clips off with it, never sliding to fit', async () => {
	const page = await openPicker();
	await page.evaluate(() => (document.body.style.height = '2000px'));
	await shiftClick(page, AT.b);
	const before = await page.evaluate(() => window.__picker.pins[0].box.style.transform);
	// Scroll the card's top edge above the viewport. Its top left corner is now off screen.
	await page.evaluate(() => window.scrollTo(0, 120));
	// Wait for the settle to re-measure the box, not just for opacity, which is still 1 from the
	// initial pin until the scroll fade fires a tick later.
	await page.waitForFunction(
		(prev) => window.__picker.pins[0].box.style.transform !== prev && window.__picker.pins[0].box.style.opacity === '1',
		before,
		{ timeout: 3000 },
	);

	const pos = await page.evaluate(() => {
		const badge = window.__picker.pins[0].badge.getBoundingClientRect();
		const el = window.__picker.pins[0].element.getBoundingClientRect();
		return { badgeTop: badge.top, badgeLeft: badge.left, elTop: el.top, elLeft: el.left };
	});
	// The badge sits just above-left of the corner, so it tracks it off screen rather than
	// clamping to y=0 to stay visible. Its top is near the element's top, which is negative.
	assert.ok(pos.elTop < 0, `precondition: element top ${pos.elTop} should be above the viewport`);
	assert.ok(pos.badgeTop < 0, `badge clamped to stay on screen (top ${pos.badgeTop}) instead of tracking the corner`);
	assert.ok(Math.abs(pos.badgeTop - pos.elTop) < 20, 'badge drifted away from the corner it marks');
	await page.close();
});

test('the highlight re-targets itself after a scroll, with no mouse move', async () => {
	const page = await openPicker();
	await page.evaluate(() => (document.body.style.height = '2000px'));
	// Park the cursor over card b, then scroll card c under it without moving the mouse.
	await page.mouse.move(AT.b.x, AT.b.y);
	await page.waitForFunction(() => window.__picker.current?.id === 'b');
	await page.evaluate(() => window.scrollTo(0, 100));

	// The picker settles, then re-hit-tests under the stationary cursor 750ms after the scroll.
	await page.waitForFunction(() => window.__picker.current !== null && window.__picker.overlay.style.opacity === '1', null, { timeout: 5000 });
	await page.close();
});

test('a pin that wraps an existing pin is refused', async () => {
	const page = await openPicker();
	await shiftClick(page, AT.inner); // The nested button
	await page.mouse.move(AT.a.x, AT.a.y);
	// The cursor sits over the card itself here, so this would pin a wrapper of pin 1.
	await page.mouse.click(AT.a.x, AT.a.y);

	assert.equal(await page.evaluate(() => window.__picker.pins.length), 1);
	assert.equal(await page.evaluate(() => document.getElementById('snipcode-tooltip').textContent), 'Contains selection 1');

	// The rejection never ends the batch: the one good pin still ships on enter.
	await page.keyboard.press('Enter');
	await page.waitForFunction(() => window.__events.many !== null);
	assert.deepEqual(await page.evaluate(() => window.__events.many.map((p) => p.id)), ['inner']);
	await page.close();
});

test('a pin nested inside an existing pin is refused', async () => {
	const page = await openPicker();
	await shiftClick(page, AT.a); // The card
	await page.mouse.move(AT.inner.x, AT.inner.y);
	await page.mouse.click(AT.inner.x, AT.inner.y);

	assert.equal(await page.evaluate(() => window.__picker.pins.length), 1);
	assert.equal(await page.evaluate(() => document.getElementById('snipcode-tooltip').textContent), 'Already inside selection 1');
	await page.close();
});

test('esc cancels the whole selection, pins included', async () => {
	const page = await openPicker();
	await shiftClick(page, AT.b);
	await plainClick(page, AT.c);
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
