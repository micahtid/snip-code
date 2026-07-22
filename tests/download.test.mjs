// Download unit tests: the shared zip builder in utils/download.ts.
//
// buildZip is the one place a multi-file download is assembled, for both the history
// export and a multi-select snip, so these check folder paths, text and binary payloads,
// and that an empty entry is skipped rather than written blank. Run with `npm run test:unit`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { load } from './load-ts.mjs';

const mod = await load('utils/download.ts');

/** Unzip a blob back into a { path: text } map, for asserting on its contents. */
async function readZip(blob) {
	const zip = await JSZip.loadAsync(Buffer.from(await blob.arrayBuffer()));
	const out = {};
	for (const [path, entry] of Object.entries(zip.files)) {
		if (!entry.dir) out[path] = await entry.async('string');
	}
	return out;
}

test('buildZip writes text entries at their given paths', async () => {
	const blob = await mod.buildZip([
		{ path: 'component-1/index.html', text: '<p>one</p>' },
		{ path: 'component-2/index.html', text: '<p>two</p>' },
	]);
	const files = await readZip(blob);
	assert.deepEqual(Object.keys(files).sort(), ['component-1/index.html', 'component-2/index.html']);
	assert.equal(files['component-1/index.html'], '<p>one</p>');
	assert.equal(files['component-2/index.html'], '<p>two</p>');
});

test('buildZip keeps same-named files apart when they sit in different folders', async () => {
	// This is the whole point of the folder prefix: every component ships an index.html.
	const blob = await mod.buildZip([
		{ path: 'component-1/index.html', text: 'a' },
		{ path: 'component-1/icon-1.svg', text: '<svg/>' },
		{ path: 'component-2/index.html', text: 'b' },
		{ path: 'component-2/icon-1.svg', text: '<svg/>' },
	]);
	const files = await readZip(blob);
	assert.equal(Object.keys(files).length, 4);
	assert.equal(files['component-1/index.html'], 'a');
	assert.equal(files['component-2/index.html'], 'b');
});

test('buildZip decodes a base64 entry back to its bytes', async () => {
	const base64 = Buffer.from('binary-payload').toString('base64');
	const blob = await mod.buildZip([{ path: 'shot.png', base64 }]);
	const files = await readZip(blob);
	assert.equal(files['shot.png'], 'binary-payload');
});

test('buildZip skips an entry with no content and keeps an empty string', async () => {
	const blob = await mod.buildZip([
		{ path: 'nothing.txt' },
		{ path: 'empty.txt', text: '' },
	]);
	const files = await readZip(blob);
	assert.deepEqual(Object.keys(files), ['empty.txt']);
	assert.equal(files['empty.txt'], '');
});

test('dataUrlToBase64 extracts the payload and rejects a plain url', () => {
	assert.equal(mod.dataUrlToBase64('data:image/png;base64,AAAB'), 'AAAB');
	assert.equal(mod.dataUrlToBase64('https://example.com/a.png'), '');
	assert.equal(mod.dataUrlToBase64(''), '');
});
