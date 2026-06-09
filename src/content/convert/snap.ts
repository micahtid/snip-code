/**
 * convert/snap.ts — value snapper
 *
 * Phase: e (convert) — see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: 4 — convert
 * Reads from Captured: nothing (operates on property/value pairs)
 * Writes to Captured: nothing (pure value transform)
 *
 * Principles applied: none directly; a readability/normalization pass feeding the
 * tailwind converter (commit 12).
 *
 * Why this exists: baked values are exact computed pixels (e.g. "16px", "rgb(15,
 * 23, 42)"). before tailwind matching they read better and map to utilities more
 * cleanly when normalized: px lengths to rem (tailwind's spacing unit), opaque
 * rgb() to hex (tailwind's palette form). it deliberately does NOT snap to a
 * design grid or a type scale — v1 learned that snapping 13px->12px or 15px->14px
 * causes visible ~8% drift, so exact values are preserved, only the unit/format
 * changes. ported from v1 value-snapper.ts, trimmed ~50% (dropped the html-string
 * inline parser — v2 snaps the bakedStyles maps directly — plus oklab math, grid-
 * track fr conversion, and the animation-artifact detector).
 *
 * which properties keep px (border/outline widths, shadows, spacing) vs convert
 * to rem is decided by a spec-category predicate, not a property-name Set
 * (forbidden pattern #1); border widths are a px-native css mechanism.
 */

const PX_LEN = /(-?\d*\.?\d+)px\b/g;
const RGB_FN = /rgba?\(([^)]+)\)/gi;
const ROOT_FONT_SIZE = 16; // px; tailwind/browser default root.

/** the result of a snap: the (possibly) transformed value and whether it changed. */
export interface SnapResult {
	value: string;
	snapped: boolean;
}

/**
 * normalizes one declaration's value: px lengths to rem (or rounded px for
 * px-native properties), and opaque rgb() to hex. multi-token values (e.g.
 * "10px 20px") snap each length independently.
 *
 * @param property — the css property (decides px-vs-rem treatment)
 * @param value — the declaration value
 */
export function snapValue(property: string, value: string): SnapResult {
	let result = value;

	// colors first: opaque rgb()/rgba() -> hex, regardless of property.
	result = result.replace(RGB_FN, (match, body: string) => rgbToHex(match, body));

	// lengths: skip values that carry css functions we must not rewrite blindly.
	if (!/\bvar\(|\bcalc\(|\bclamp\(|\bmin\(|\bmax\(/.test(result)) {
		if (pixelNative(property)) {
			result = result.replace(PX_LEN, (_m, n: string) => `${Math.round(parseFloat(n))}px`);
		} else {
			result = result.replace(PX_LEN, (_m, n: string) => pxToRem(parseFloat(n)));
		}
	}

	return { value: result, snapped: result !== value };
}

/**
 * true for properties whose lengths read best left in px: border/outline widths
 * and offsets, shadows, and table border-spacing. radius is excluded — it reads
 * better in rem. this is a css-spec category predicate (border width is a
 * px-native mechanism), not a curated property Set.
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

/** px -> rem string (÷16), trimmed of trailing zeros; "0" stays unitless. */
function pxToRem(px: number): string {
	if (px === 0) return '0';
	const rem = px / ROOT_FONT_SIZE;
	// up to 4 decimals, no trailing zeros.
	return `${parseFloat(rem.toFixed(4))}rem`;
}

/** convert an opaque rgb()/rgba() to #hex; preserve rgba() when it carries alpha. */
function rgbToHex(original: string, body: string): string {
	const parts = body.split(/[\s,/]+/).filter(Boolean);
	const r = Number(parts[0]);
	const g = Number(parts[1]);
	const b = Number(parts[2]);
	const a = parts[3] !== undefined ? Number(parts[3]) : 1;
	if (![r, g, b].every((n) => Number.isFinite(n) && n >= 0 && n <= 255)) return original;
	if (Number.isFinite(a) && a < 1) return original; // keep alpha as rgba()
	const hex = [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');
	return `#${hex}`;
}
