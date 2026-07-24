// Polish unit tests: the grouping comment normalizer in polish/rename.ts.
//
// The prompt asks for a capitalized, article-free noun phrase, but the model drifts, so the
// format is enforced deterministically. These cover the drift cases and confirm an already
// correct comment survives untouched. Run with `npm run test:unit`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load-ts.mjs';

const mod = await load('content/polish/rename.ts');
const { normalizeComment, applyComments } = mod;

test('normalizeComment capitalizes a lowercase comment', () => {
	assert.equal(normalizeComment('product card container'), 'Product card container');
});

test('normalizeComment drops a leading article before casing', () => {
	assert.equal(normalizeComment('the product card'), 'Product card');
	assert.equal(normalizeComment('a nav bar'), 'Nav bar');
	assert.equal(normalizeComment('An icon row'), 'Icon row');
});

test('normalizeComment strips trailing punctuation', () => {
	assert.equal(normalizeComment('Product card.'), 'Product card');
	assert.equal(normalizeComment('Product card!'), 'Product card');
	assert.equal(normalizeComment('Product card:'), 'Product card');
});

test('normalizeComment leaves an already correct comment unchanged', () => {
	assert.equal(normalizeComment('Product card container'), 'Product card container');
});

test('normalizeComment preserves casing after the first character', () => {
	assert.equal(normalizeComment('the CTA button'), 'CTA button');
});

test('normalizeComment collapses internal whitespace', () => {
	assert.equal(normalizeComment('  product   card  '), 'Product card');
});

test('normalizeComment returns empty for empty and whitespace-only input', () => {
	assert.equal(normalizeComment(''), '');
	assert.equal(normalizeComment('   '), '');
});

test('normalizeComment returns empty for punctuation-only input', () => {
	assert.equal(normalizeComment('...'), '');
});

test('applyComments writes the normalized text and strips a comment closer', () => {
	const css = '.card {\n\tcolor: red;\n}\n';
	const out = applyComments(css, { '.card': 'the product */ card.' });
	assert.equal(out, '/* Product card */\n.card {\n\tcolor: red;\n}\n');
});

test('applyComments skips a comment that normalizes to nothing', () => {
	const css = '.card {\n\tcolor: red;\n}\n';
	assert.equal(applyComments(css, { '.card': '  .  ' }), css);
});
