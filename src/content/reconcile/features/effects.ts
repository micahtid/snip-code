/**
 * features/effects.ts: filters, masks, clip-path, blend, shadow
 *
 * Pipeline position: reconcile
 * Reads from Captured: root, clone, bakedStyles
 * Writes to Captured: bakedStyles + clone (bakes non-default effect properties)
 *
 * Principles applied: extends the "ship what renders" rule to visual-effect
 * properties the authored cascade often omits.
 *
 * CSS/spec reference: https://developer.mozilla.org/en-US/docs/Web/CSS/filter
 * (also backdrop-filter, clip-path, mask, mix-blend-mode, box-shadow)
 * Detection criterion: an element with a non-default value for one of the effect
 * properties. Per-element early-return otherwise.
 * Transform contract: bakes those computed values onto the matching clone
 * element, absolutizing any url() (mask-image, clip-path: url(#...)). Mutates
 * bakedStyles + clone inline styles only.
 * Test bundle: TODO, add later (glassmorphism backdrop, clip-path hero).
 *
 * Why this exists: filter/backdrop-filter/clip-path/mask/mix-blend-mode and
 * multi-layer/inset box-shadow are central to a component's look but frequently
 * applied via a class that does not survive, so without baking the snip loses its
 * blur, glass, or clipped shape. These properties are per-frame stable, so baking
 * the computed value is pixel-safe.
 */
import type { Captured } from '../../types';
import { pairedSubtrees } from '../match';

const URL_IN_VALUE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/**
 * The visual-effect properties this handler preserves, the bounded css-spec
 * surface for filters/masking/compositing (a feature-handler spec set, not a
 * hardcoded property list). Vendor-prefixed forms are included
 * because chrome still computes some masks/clips under -webkit-.
 */
const EFFECT_PROPS = [
	'filter', 'backdrop-filter', '-webkit-backdrop-filter',
	'clip-path', '-webkit-clip-path',
	'mask', 'mask-image', '-webkit-mask', '-webkit-mask-image',
	'mix-blend-mode', 'background-blend-mode', 'box-shadow',
];

/** Computed values that mean "default" and need no baking. */
function isDefault(value: string): boolean {
	const v = value.trim();
	return v === '' || v === 'none' || v === 'normal';
}

/**
 * Bakes non-default visual-effect properties onto each element.
 *
 * @param captured - bakedStyles + clone are mutated in place
 */
export function apply(captured: Captured): Captured {
	const base = document.baseURI || location.href;
	for (const [original, clone] of pairedSubtrees(captured.root, captured.clone)) {
		const computed = getComputedStyle(original);
		const baked = captured.bakedStyles.get(clone) ?? new Map<string, string>();
		for (const prop of EFFECT_PROPS) {
			if (baked.has(prop)) continue;
			const raw = computed.getPropertyValue(prop);
			if (isDefault(raw)) continue;
			const value = raw.includes('url(') ? absolutizeUrls(raw, base) : raw;
			baked.set(prop, value);
			try {
				(clone as HTMLElement).style.setProperty(prop, value);
			} catch {
				// Invalid for this element; skip.
			}
		}
		captured.bakedStyles.set(clone, baked);
	}
	return captured;
}

/** Rewrite relative url()s to absolute; keep fragment refs (clip-path: url(#x)) and data/blob. */
function absolutizeUrls(value: string, base: string): string {
	return value.replace(URL_IN_VALUE, (match, quote: string, url: string) => {
		if (/^(data:|blob:|https?:|#)/i.test(url)) return match;
		try {
			return `url(${quote}${new URL(url, base).href}${quote})`;
		} catch {
			return match;
		}
	});
}
