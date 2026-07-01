/**
 * convert/snap.ts: value snapper
 *
 * Pipeline position: convert
 * Reads from Captured: nothing; operates on property/value pairs
 * Writes to Captured: nothing; a pure value transform
 *
 * A readability and normalization pass feeding the tailwind converter.
 *
 * Why this exists: baked values are exact computed pixels, for example "16px" or "rgb(15,
 * 23, 42)". Before tailwind matching they read better and map to utilities more
 * cleanly when normalized: px lengths to rem, tailwind's spacing unit, and opaque
 * rgb() to hex, tailwind's palette form. It deliberately does NOT snap to a
 * design grid or a type scale, v1 learned that snapping 13px->12px or 15px->14px
 * causes visible ~8% drift, so exact values are preserved, only the unit/format
 * changes. Ported from v1 value-snapper.ts, trimmed ~50%: it dropped the html-string
 * inline parser, since v2 snaps the bakedStyles maps directly, plus oklab math, grid-
 * track fr conversion, and the animation-artifact detector.
 *
 * Which properties keep px, namely border/outline widths, shadows, and spacing, vs convert
 * to rem is decided by a category predicate, not a hardcoded property-name list;
 * border widths are a px-native css mechanism.
 */

const PX_LEN = /(-?\d*\.?\d+(?:e[+-]?\d+)?)px\b/gi;
const RGB_FN = /rgba?\(([^)]+)\)/gi;
const ROOT_FONT_SIZE = 16; // Px; tailwind/browser default root.

/** The result of a snap: the possibly transformed value and whether it changed. */
export interface SnapResult {
	value: string;
	snapped: boolean;
}

/**
 * Normalizes one declaration's value for cleaner output: opaque rgb() to hex, and px
 * lengths to rem, though a px-native property such as a border width keeps its exact px, never
 * rounded. Multi-token values such as "10px 20px" snap each length independently. A
 * custom property, or any value carrying a css function, passes through untouched, since
 * rewriting it could change what it means once substituted; see the body.
 *
 * @param property - the css property, which decides px-vs-rem treatment
 * @param value - the declaration value
 */
export function snapValue(property: string, value: string): SnapResult {
	let result = value;

	// Custom properties are opaque substitution tokens: their value is dropped verbatim
	// into every consumer, whose context is unknown here. Normalizing it can change
	// meaning, e.g. snapping `0px` to unitless `0` makes a consumer's `max(22px, var(--x))`
	// mix a length with a number, which is invalid and drops the whole declaration. So a
	// custom property passes through untouched.
	if (property.startsWith('--')) {
		return { value, snapped: false };
	}

	// A value carrying a css function is left untouched: the RGB_FN/PX_LEN regexes match
	// a single level of parentheses, so a nested function, such as the modern
	// `rgb(R G B / var(--opacity))` color form or `calc()` inside a length, would be
	// truncated at the inner `)` and rewritten into an invalid value the css parser then
	// silently drops. The exact computed value renders identically to its snapped form, so
	// skipping it costs only readability, never a pixel, and never a dropped declaration.
	if (/\bvar\(|\bcalc\(|\bclamp\(|\bmin\(|\bmax\(/.test(value)) {
		return { value, snapped: false };
	}

	// Colors: opaque rgb()/rgba() -> hex, regardless of property.
	result = result.replace(RGB_FN, (match, body: string) => rgbToHex(match, body));

	// Lengths: a px-native property, such as a border/outline width, shadow, or spacing, keeps its
	// exact px, which reads well and is render-identical to the baked value. It is
	// deliberately NOT rounded to an integer: rounding changes the rendered value, since
	// letter-spacing -0.374px -> 0px loses the tracking and a shadow blur 1.899px -> 2px
	// shifts the shadow, which breaks render-equivalence with the inline clone. Every
	// other length converts to rem, which is exactly ÷16 against the artifact's 16px root
	// so it reproduces the same px.
	if (!pixelNative(property)) {
		result = result.replace(PX_LEN, (_m, n: string) => pxToRem(parseFloat(n)));
	}

	return { value: result, snapped: result !== value };
}

/**
 * True for properties whose lengths read best left in px: border/outline widths
 * and offsets, shadows, and table border-spacing. Radius is excluded, it reads
 * better in rem. This is a category predicate, since a border width is a
 * px-native mechanism, not a curated property list.
 */
function pixelNative(property: string): boolean {
	if (/radius/.test(property)) return false;
	return (
		/(?:^|-)(?:border|outline)(?:$|-)/.test(property) ||
		/shadow/.test(property) ||
		/spacing/.test(property) ||
		/outline-offset/.test(property)
	);
}

/** Px -> rem string (÷16), trimmed of trailing zeros; "0" stays unitless. */
function pxToRem(px: number): string {
	if (px === 0) return '0';
	const rem = px / ROOT_FONT_SIZE;
	// Up to 6 decimals, no trailing zeros. Six, not four, so the rem reproduces the
	// source px within getComputedStyle's own quantization: at 4 decimals the ÷16/×16
	// round-trip drifts up to ~0.0008px, which a per-element computed-style diff reads as
	// a divergence, for example line-height 21.0012px -> 21.0016px, even though it is invisible.
	return `${parseFloat(rem.toFixed(6))}rem`;
}

/** Convert an opaque rgb()/rgba() to #hex; preserve rgba() when it carries alpha. */
function rgbToHex(original: string, body: string): string {
	const parts = body.split(/[\s,/]+/).filter(Boolean);
	const r = Number(parts[0]);
	const g = Number(parts[1]);
	const b = Number(parts[2]);
	const a = parts[3] !== undefined ? Number(parts[3]) : 1;
	if (![r, g, b].every((n) => Number.isFinite(n) && n >= 0 && n <= 255)) return original;
	if (Number.isFinite(a) && a < 1) return original; // Keep alpha as rgba()
	const hex = [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');
	return `#${hex}`;
}
