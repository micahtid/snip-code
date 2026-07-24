// Scrim union unit tests: the hole-rectangle union in content/capture/picker.ts.
//
// The dimming veil cuts a bright hole per hovered/pinned element with an even-odd clip path.
// Two overlapping holes cancel into a dark patch under that rule, so overlapping rectangles are
// rebuilt into non-overlapping ones covering the same area first. These check that rebuild is
// both disjoint and area-preserving, which is what guarantees no element ever blacks out. The
// module is imported for its pure exports only, so no dom is needed. Run with `npm run test:unit`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load-ts.mjs';

const { rectsOverlap, anyOverlap, unionRects } = await load('content/capture/picker.ts');

/** A rect from left/top/width/height, mirroring the DOMRect fields the union reads. */
function rect(left, top, width, height) {
	return { left, top, right: left + width, bottom: top + height };
}

/** Sum of a rect list's areas. For disjoint rects this equals their covered area. */
function totalArea(rects) {
	return rects.reduce((sum, r) => sum + (r.right - r.left) * (r.bottom - r.top), 0);
}

/** True if any two rects in the list overlap, the property the union must eliminate. */
function hasOverlap(rects) {
	for (let i = 0; i < rects.length; i++) {
		for (let j = i + 1; j < rects.length; j++) if (rectsOverlap(rects[i], rects[j])) return true;
	}
	return false;
}

/** Whether a point lies inside any rect, the membership the union must preserve. */
function coveredBy(rects, x, y) {
	return rects.some((r) => x > r.left && x < r.right && y > r.top && y < r.bottom);
}

test('rectsOverlap is true for a shared area and false for a shared edge', () => {
	assert.equal(rectsOverlap(rect(0, 0, 10, 10), rect(5, 5, 10, 10)), true);
	assert.equal(rectsOverlap(rect(0, 0, 10, 10), rect(10, 0, 10, 10)), false); // touching, not overlapping
});

test('anyOverlap detects a single overlapping pair among many', () => {
	assert.equal(anyOverlap([rect(0, 0, 10, 10), rect(100, 0, 10, 10), rect(5, 5, 10, 10)]), true);
	assert.equal(anyOverlap([rect(0, 0, 10, 10), rect(100, 0, 10, 10)]), false);
});

test('unionRects makes two overlapping rects disjoint without changing the covered area', () => {
	const a = rect(0, 0, 100, 100);
	const b = rect(50, 50, 100, 100);
	const out = unionRects([a, b], 1000, 1000);
	assert.ok(!hasOverlap(out), 'the union pieces must not overlap each other');
	// Inclusion-exclusion: |A ∪ B| = |A| + |B| - |A ∩ B|. The overlap is a 50x50 square.
	assert.equal(totalArea(out), 100 * 100 + 100 * 100 - 50 * 50);
});

test('unionRects preserves exactly which points are covered', () => {
	const out = unionRects([rect(0, 0, 100, 100), rect(50, 50, 100, 100)], 1000, 1000);
	const inside = [
		[10, 10],
		[120, 120],
		[60, 60], // the overlap region, must stay covered rather than blacking out
	];
	const outside = [
		[120, 10], // right of A, above B
		[10, 120], // below A, left of B
		[200, 200],
	];
	for (const [x, y] of inside) assert.ok(coveredBy(out, x, y), `(${x},${y}) should stay covered`);
	for (const [x, y] of outside) assert.ok(!coveredBy(out, x, y), `(${x},${y}) should stay uncovered`);
});

test('unionRects clamps the pieces to the viewport bounds', () => {
	const out = unionRects([rect(-20, -20, 60, 60), rect(20, 20, 60, 60)], 50, 50);
	for (const r of out) {
		assert.ok(r.left >= 0 && r.top >= 0 && r.right <= 50 && r.bottom <= 50, 'a piece escaped the viewport');
	}
	assert.ok(!hasOverlap(out));
});
