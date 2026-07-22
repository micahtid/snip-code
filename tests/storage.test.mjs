// Storage unit tests: the saved-flag rules in utils/storage.ts.
//
// These cover the three behaviours the save feature depends on: the 50-cap counts unsaved
// records only, Clear History keeps saved records, and the save toggle re-applies the cap
// when a record is unsaved. Run with `npm run test:unit`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, stubChromeStorage } from './load-ts.mjs';

const KEY = 'snippets';

/** A minimal stored record. `saved` is left absent unless asked for, as older records are. */
function record(id, saved) {
	const rec = {
		id,
		capturedAt: new Date(2026, 0, 1).toISOString(),
		page: { url: 'https://example.com', title: 't', viewport: { width: 1, height: 1, devicePixelRatio: 1 }, userAgent: 'ua' },
		element: {},
		output: { format: 'html', html: `<p>${id}</p>` },
		screenshot: '',
	};
	if (saved) rec.saved = true;
	return rec;
}

/** Fresh storage module against a fresh stub store, so tests never share state. */
async function fresh(seed) {
	const store = stubChromeStorage(seed ? { [KEY]: seed } : {});
	const mod = await load('utils/storage.ts');
	return { store, mod };
}

test('storeSnippet keeps everything below the cap', async () => {
	const { store, mod } = await fresh([record('a')]);
	await mod.storeSnippet(record('b'));
	assert.deepEqual(store[KEY].map((r) => r.id), ['a', 'b']);
});

test('storeSnippet evicts the oldest unsaved record past the cap', async () => {
	const existing = Array.from({ length: 50 }, (_, i) => record(`u${i}`));
	const { store, mod } = await fresh(existing);
	await mod.storeSnippet(record('new'));
	assert.equal(store[KEY].length, 50);
	assert.equal(store[KEY][0].id, 'u1'); // u0, the oldest unsaved, was dropped
	assert.equal(store[KEY].at(-1).id, 'new');
});

test('storeSnippet never evicts saved records, and the cap counts unsaved only', async () => {
	// 10 saved, then 50 unsaved: already at the cap, with the saved ones exempt.
	const saved = Array.from({ length: 10 }, (_, i) => record(`s${i}`, true));
	const unsaved = Array.from({ length: 50 }, (_, i) => record(`u${i}`));
	const { store, mod } = await fresh([...saved, ...unsaved]);
	await mod.storeSnippet(record('new'));

	const ids = store[KEY].map((r) => r.id);
	assert.equal(store[KEY].length, 60); // 10 saved + 50 unsaved
	assert.equal(ids.filter((id) => id.startsWith('s')).length, 10); // every saved record survived
	assert.ok(!ids.includes('u0')); // the oldest unsaved was dropped
	assert.ok(ids.includes('new'));
	// Chronological order is preserved: saved records stay ahead of the unsaved ones they precede.
	assert.deepEqual(ids.slice(0, 10), saved.map((r) => r.id));
});

test('storeSnippet drops several at once when the list is already over the cap', async () => {
	const existing = Array.from({ length: 53 }, (_, i) => record(`u${i}`));
	const { store, mod } = await fresh(existing);
	await mod.storeSnippet(record('new'));
	assert.equal(store[KEY].length, 50);
	assert.equal(store[KEY][0].id, 'u4');
});

test('clearSnippets keeps saved records and drops the rest', async () => {
	const { store, mod } = await fresh([record('a'), record('s', true), record('b')]);
	await mod.clearSnippets();
	assert.deepEqual(store[KEY].map((r) => r.id), ['s']);
});

test('clearSnippets empties a history with nothing saved', async () => {
	const { store, mod } = await fresh([record('a'), record('b')]);
	await mod.clearSnippets();
	assert.deepEqual(store[KEY], []);
});

test('setSnippetSaved flags and unflags one record', async () => {
	const { store, mod } = await fresh([record('a'), record('b')]);
	await mod.setSnippetSaved('b', true);
	assert.equal(store[KEY].find((r) => r.id === 'b').saved, true);
	assert.ok(!store[KEY].find((r) => r.id === 'a').saved);
	await mod.setSnippetSaved('b', false);
	assert.equal(store[KEY].find((r) => r.id === 'b').saved, false);
});

test('setSnippetSaved is a no-op for an unknown id', async () => {
	const { store, mod } = await fresh([record('a')]);
	await mod.setSnippetSaved('gone', true);
	assert.deepEqual(store[KEY].map((r) => r.id), ['a']);
});

test('unsaving past the cap makes the record evictable again', async () => {
	// 50 unsaved plus one saved: at the cap. Unsaving the saved one pushes unsaved to 51.
	const unsaved = Array.from({ length: 50 }, (_, i) => record(`u${i}`));
	const { store, mod } = await fresh([record('s', true), ...unsaved]);
	await mod.setSnippetSaved('s', false);
	const ids = store[KEY].map((r) => r.id);
	assert.equal(ids.length, 50);
	assert.ok(!ids.includes('s')); // it was the oldest unsaved, so it went first
	assert.ok(ids.includes('u0'));
});

test('listSnippets returns an empty list when nothing is stored', async () => {
	const { mod } = await fresh();
	assert.deepEqual(await mod.listSnippets(), []);
});
