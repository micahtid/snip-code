/**
 * minimize/colorize.ts: rewrite computed color notations to hex
 *
 * Pipeline position: minimize, last, after format
 * Reads from Captured: nothing
 * Writes to Captured: nothing; transforms the formatted stylesheet string
 *
 * Why this exists: the reproduce phase emits colors in whatever notation the engine
 * computed them to, verbose rgb(83, 58, 253) triples and rgba(31, 35, 40, 0.04)
 * functions. A human writes #533afd and #1f232809. This phase rewrites every rgb() and
 * rgba() function to a short hex, using the canvas 2d context as the authority: setting
 * fillStyle to the color yields the engine's own canonical form, so the rewrite is the
 * same color the browser would paint, by construction, with no color math here and no
 * gamut guesswork. Wide-gamut lab() and color() notations are never matched, so they keep
 * their spelling rather than being clamped to the srgb gamut.
 *
 * It is a pure string transform and runs last, after format, for two reasons. First, it
 * needs no render oracle: an rgb()/rgba() function and its canvas-canonical hex paint the
 * identical pixel, so the rewrite cannot move the render, in a resting rule, a state rule,
 * a shadow, or a gradient alike. Second, a cssom round-trip re-serializes a standalone hex
 * back to rgb(), so any phase that re-parses the sheet, format among them, would undo the
 * rewrite; operating on the already-formatted text as a plain string sidesteps that and
 * preserves the indentation format produced.
 *
 * Two boundaries keep the rewrite paint-exact rather than merely close. It is segment-aware:
 * quoted strings and url() spans are matched as whole units and left untouched, so an
 * `rgba(` sequence that is text (a `content` value, an svg data uri) is never mistaken for
 * a color. And a color is only rewritten when the text right after it is a delimiter: a
 * function ends in `)`, but a bare hex does not, so a color packed against the next token
 * (tailwind serializes gradient stops as `rgb(25, 25, 29)0px`) would glue into one invalid
 * hash token; such a color keeps its delimited functional form.
 */

/**
 * Rewrites every rgb()/rgba() color function in a stylesheet to hex. Graceful by contract:
 * returns the input unchanged when a canvas context is unavailable, and leaves any function
 * the context does not accept as a color exactly as it was.
 *
 * @param css - the formatted stylesheet
 * @returns the stylesheet with rgb()/rgba() functions rewritten to hex
 */
export function colorizeCss(css: string): string {
	if (!css.trim()) return css;
	const ctx = colorContext();
	if (!ctx) return css;
	// Tokenize into quoted strings, url() spans, and color functions, in that order, so a
	// string or url is consumed as one unit and any color-looking text inside it is never
	// seen as a color. A color function never contains a nested paren in a computed value,
	// so [^)]* delimits it exactly.
	return css.replace(COLOR_OR_PROTECTED, (match, offset: number, whole: string) => {
		if (!/^rgba?\(/i.test(match)) return match; // Protected string or url span; leave verbatim.
		const converted = colorize(match, ctx);
		// A hex has no trailing delimiter, but the color function's `)` did. When the color
		// abutted a name char with no delimiter (tailwind packs gradient stops as
		// `rgb(25, 25, 29)0px`), the two were already separate tokens; insert a space so the
		// hex stays distinct rather than gluing into one invalid hash token.
		if (converted[0] === '#') {
			const next = whole[offset + match.length];
			if (next !== undefined && NAME_CHAR.test(next)) return `${converted} `;
		}
		return converted;
	});
}

/**
 * Matches, in priority order, a double-quoted string, a single-quoted string, a url() span,
 * or an rgb()/rgba() color function. The string and url alternatives come first so their
 * contents are swallowed before a color function inside them can match on its own.
 */
const COLOR_OR_PROTECTED = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\burl\((?:[^)"']|"[^"]*"|'[^']*')*\)|rgba?\([^)]*\)/gi;

/** A css name-continuation code point, the set that would extend a hash token past a hex. */
const NAME_CHAR = /[-\w\u0080-\uffff]/;

/**
 * One rgb()/rgba() function rewritten to hex, or unchanged when the context does not accept
 * it as a lone color. The canvas context is the authority: assigning the function to
 * fillStyle yields the engine's canonical spelling, a #rrggbb hex for an opaque color and an
 * rgba() for a translucent one; an opaque color becomes the shortest hex and a translucent
 * one an eight-digit hex, both the same pixels the context would paint.
 *
 * @param fn - a single rgb() or rgba() color function
 * @param ctx - a 2d context used to canonicalize colors
 */
function colorize(fn: string, ctx: CanvasRenderingContext2D): string {
	// Relative-color syntax, rgb(from ...), resolves against another color; the [^)]* match
	// can also clip one whose base is a var(). Leave any from-color exactly as written.
	if (/\bfrom\b/i.test(fn)) return fn;
	const probe = '#000001';
	ctx.fillStyle = probe;
	ctx.fillStyle = fn;
	const canonical = ctx.fillStyle;
	if (canonical === probe) return fn; // Not a color the context accepted; leave it.
	if (canonical.startsWith('#')) return shortHex(canonical);
	const rgba = canonical.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/i);
	if (rgba) return hex8(rgba);
	return fn; // A form the context kept as a function; leave it.
}

/**
 * An rgba() match as #rrggbbaa, dropping the alpha byte to #rrggbb when fully opaque. The
 * alpha byte is round(a*255), which is exactly how the engine quantizes a fractional alpha
 * to 8 bits, so #rrggbbaa paints the identical pixel the rgba() would.
 */
function hex8(rgba: RegExpMatchArray): string {
	const byte = (n: number): string => Math.round(n).toString(16).padStart(2, '0');
	const [r, g, b] = [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])];
	const a = Math.round(Number(rgba[4]) * 255);
	const base = `#${byte(r)}${byte(g)}${byte(b)}`;
	return a === 255 ? shortHex(base) : `${base}${byte(a)}`;
}

/** Shortens a #rrggbb hex to #rgb when each channel is a doubled nibble. */
function shortHex(hex: string): string {
	if (hex.length === 7 && hex[1] === hex[2] && hex[3] === hex[4] && hex[5] === hex[6]) {
		return `#${hex[1]}${hex[3]}${hex[5]}`;
	}
	return hex;
}

/** A reusable 1x1 2d context for canonicalizing colors, or null when canvas is unavailable. */
let sharedContext: CanvasRenderingContext2D | null | undefined;
function colorContext(): CanvasRenderingContext2D | null {
	if (sharedContext !== undefined) return sharedContext;
	try {
		sharedContext = document.createElement('canvas').getContext('2d');
	} catch {
		sharedContext = null;
	}
	return sharedContext;
}
