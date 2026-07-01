/**
 * resolve/fonts.ts: @font-face resolution
 *
 * Pipeline position: resolve
 * Reads from Captured: root, fonts
 * Writes to Captured: fonts, with absolutized src, narrowed to the faces the snip renders
 *
 * Travel-with-the-snip rule for fonts: a used custom font must carry its
 * @font-face and an absolute src so it loads from the snip's new home.
 *
 * Why this exists: @font-face src urls are usually relative to the source page;
 * pasted elsewhere they 404. This resolves them to absolute urls and narrows the
 * captured @font-face list to the faces the snip actually renders. A source page
 * commonly ships every weight of a family, light through bold, while a snipped
 * component renders only one or two, so narrowing to the used family is not
 * enough: the other weights are dead @font-face rules and dead font downloads.
 * The narrowing therefore matches on the full family, weight, and style that the
 * live subtree renders, resolved through the css-fonts-4 font-matching algorithm
 * so a request the family has no exact face for, such as weight 700 against a 600
 * bold, still keeps the face the browser substitutes. Requests are read from the
 * live computed styles across the root subtree and the generated-content
 * pseudo-elements, which pairs each rendered family with the weight and style it renders at, the
 * same "first family is the one that renders" ground truth assistive/fonts.ts
 * uses. Generic keywords (serif, system-ui,...) never match a captured
 * @font-face family, so they fall out naturally, no banned-keyword set needed.
 * Ported from v1 font-extractor.ts, rewritten.
 */
import type { Captured, FontFace } from '../types';

const URL_IN_SRC = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/**
 * The generated-content pseudo-elements whose own font can differ from the host
 * element's, mirroring the set features/pseudo.ts materializes. Sampling them
 * keeps a face that only a pseudo renders, for example an icon-font ::before.
 */
const PSEUDO_ELEMENTS = ['::before', '::after', '::marker', '::placeholder', '::file-selector-button'];

/** One (weight, style) a family is rendered at somewhere in the subtree. */
interface FaceRequest {
	weight: number; // Numeric css weight (1-1000); normal -> 400, bold -> 700
	style: string; // 'normal' | 'italic' | 'oblique'
}

/** The css2 generic font families; a stack ending in one of these has a safe fallback. */
const GENERIC_FAMILIES = new Set([
	'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif',
	'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji', 'fangsong',
]);

/**
 * Guarantees every baked font-family stack ends in a generic family, so text never
 * falls back to the browser default serif, Times New Roman, when a custom font is
 * unavailable. A stack that already ends in a generic is left untouched; otherwise a
 * generic is appended, inferred from the first family's monospace hint, else sans-serif,
 * the overwhelmingly common case for ui type. Runs after the standalone
 * reconciliation has baked the resolved family stacks.
 *
 * @param captured - every baked font-family value is normalized in place
 */
export function appendGenericFallbacks(captured: Captured): void {
	for (const [clone, baked] of captured.bakedStyles) {
		const stack = baked.get('font-family');
		if (!stack) continue;
		const families = stack.split(',').map((f) => f.trim()).filter(Boolean);
		const last = families[families.length - 1]?.replace(/^["']|["']$/g, '').toLowerCase();
		if (!last || GENERIC_FAMILIES.has(last)) continue; // Already safe.
		const generic = /\bmono(space)?\b/i.test(stack) ? 'monospace' : 'sans-serif';
		const next = `${stack}, ${generic}`;
		baked.set('font-family', next);
		try {
			(clone as HTMLElement).style.setProperty('font-family', next);
		} catch {
			// Invalid for this element; the baked-map entry still ships to emit.
		}
	}
}

/**
 * Narrows captured @font-face entries to the faces the snip renders and
 * absolutizes their src.
 *
 * @param captured - fonts is replaced in place with the resolved, used subset
 */
export function resolveFonts(captured: Captured): void {
	const { requests, codepoints } = faceRequests(captured.root);
	const base = document.baseURI || location.href;
	const seen = new Set<string>();
	const resolved: FontFace[] = [];

	for (const font of keptFaces(captured.fonts, requests, codepoints)) {
		const src = absolutizeSrc(font.src, base);
		const key = `${normalizeFamily(font.family).toLowerCase()}|${src}|${descriptorKey(font)}`;
		if (seen.has(key)) continue; // Dedupe identical faces
		seen.add(key);
		resolved.push({ family: font.family, src, descriptors: font.descriptors });
	}
	captured.fonts = resolved;
}

/**
 * The faces to keep, in their captured order: a face survives when its family is
 * rendered in the subtree and its (weight, style) is the one css font-matching
 * picks for one of that family's requests. A family with no request never
 * renders, so all of its faces drop.
 *
 * unicode-range subsetting is honored: a family split into latin, latin-ext, cyrillic,
 * and further files, the next.js and google-fonts shape. Of the faces at the matched
 * (weight, style), only those whose range covers a codepoint the snip actually renders
 * survive, so a latin snip keeps the latin subset rather than an arbitrary first subset
 * that would render nothing and silently fall back.
 */
function keptFaces(fonts: FontFace[], requests: Map<string, FaceRequest[]>, codepoints: Set<number>): FontFace[] {
	const byFamily = new Map<string, FontFace[]>();
	for (const font of fonts) {
		const family = normalizeFamily(font.family).toLowerCase();
		let faces = byFamily.get(family);
		if (!faces) byFamily.set(family, (faces = []));
		faces.push(font);
	}

	const keep = new Set<FontFace>();
	for (const [family, faces] of byFamily) {
		const reqs = requests.get(family);
		if (!reqs) continue; // Family never renders, drop every weight
		for (const req of reqs) {
			for (const face of selectFaces(req, faces, codepoints)) keep.add(face);
		}
	}
	return fonts.filter((font) => keep.has(font));
}

/** The family, weight, and style requests plus the codepoints the live subtree renders. */
interface SubtreeFaces {
	requests: Map<string, FaceRequest[]>;
	codepoints: Set<number>;
}

/**
 * The family, weight, and style triples the live subtree renders, keyed by lowercased
 * family, plus the set of codepoints it renders, so unicode-range narrowing can keep the
 * subset faces that actually cover the text. Reads element and generated-content text.
 */
function faceRequests(root: Element): SubtreeFaces {
	const requests = new Map<string, FaceRequest[]>();
	const codepoints = new Set<number>();
	addCodepoints(codepoints, root.textContent ?? '');
	const record = (style: CSSStyleDeclaration) => {
		const family = normalizeFamily(style.fontFamily.split(',')[0] ?? '').toLowerCase();
		if (!family) return;
		const request: FaceRequest = { weight: normalizeWeight(style.fontWeight), style: normalizeStyle(style.fontStyle) };
		let list = requests.get(family);
		if (!list) requests.set(family, (list = []));
		if (!list.some((r) => r.weight === request.weight && r.style === request.style)) list.push(request);
	};

	for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
		record(getComputedStyle(el));
		for (const pseudo of renderedPseudos(el)) {
			const cs = getComputedStyle(el, pseudo);
			record(cs);
			const content = cs.getPropertyValue('content');
			if (content && content !== 'none' && content !== 'normal') addCodepoints(codepoints, content.replace(/^["']|["']$/g, ''));
		}
	}
	return { requests, codepoints };
}

/** Adds every codepoint of a string to the set, iterating by code point, not utf-16 unit. */
function addCodepoints(set: Set<number>, text: string): void {
	for (const ch of text) {
		const cp = ch.codePointAt(0);
		if (cp !== undefined) set.add(cp);
	}
}

/** Which pseudo-elements actually generate a box on this element, so their font renders. */
function renderedPseudos(el: Element): string[] {
	const out: string[] = [];
	for (const pseudo of ['::before', '::after'] as const) {
		const content = getComputedStyle(el, pseudo).getPropertyValue('content');
		if (content && content !== 'none' && content !== 'normal') out.push(pseudo);
	}
	if (getComputedStyle(el).display === 'list-item') out.push('::marker');
	if (el.hasAttribute('placeholder')) out.push('::placeholder');
	try {
		if (el.matches('input[type="file"]')) out.push('::file-selector-button');
	} catch {
		// Matches unsupported; ignore.
	}
	return out.filter((pseudo) => PSEUDO_ELEMENTS.includes(pseudo));
}

/**
 * The captured faces one weight request resolves to, empty when the family has none.
 * Faces of the requested style win; if the family has no face in that style the browser
 * synthesizes it from any weight, so all faces stay eligible. The css weight-matching
 * algorithm picks one weight; every face at that matched (weight, style) whose
 * unicode-range covers a rendered codepoint is kept, because subset faces partition the
 * codepoint space and the snip may render glyphs from several subsets. If no subset
 * covers the text, whether an exotic repertoire or an unparseable range, the weight winner is
 * kept as a floor so the family still renders rather than vanishing.
 */
function selectFaces(request: FaceRequest, faces: FontFace[], codepoints: Set<number>): FontFace[] {
	const styled = faces.filter((face) => faceStyle(face) === request.style);
	const pool = styled.length > 0 ? styled : faces;
	const index = matchWeight(request.weight, pool.map(faceWeightRange));
	if (index === -1) return [];
	const winner = pool[index];
	if (!winner) return [];
	const [wlo, whi] = faceWeightRange(winner);
	const covering = pool.filter((face) => {
		const [lo, hi] = faceWeightRange(face);
		return lo === wlo && hi === whi && faceCoversCodepoints(face, codepoints);
	});
	return covering.length > 0 ? covering : [winner];
}

/**
 * Whether a face renders any codepoint the snip shows. A face with no unicode-range
 * descriptor covers the full repertoire, so it always qualifies; otherwise at least one
 * of its declared ranges must contain a rendered codepoint. An empty codepoint set, meaning
 * no text, or an unparseable range qualifies too, so coverage never wrongly drops a face.
 *
 * @param font - the captured face
 * @param codepoints - the codepoints the live subtree renders
 */
function faceCoversCodepoints(font: FontFace, codepoints: Set<number>): boolean {
	const descriptor = font.descriptors['unicode-range'];
	if (!descriptor) return true; // No subsetting: the face covers everything.
	if (codepoints.size === 0) return true; // Nothing to render; do not drop on coverage.
	const ranges = parseUnicodeRange(descriptor);
	if (ranges.length === 0) return true; // Unparseable; keep rather than wrongly drop.
	for (const cp of codepoints) {
		for (const [lo, hi] of ranges) if (cp >= lo && cp <= hi) return true;
	}
	return false;
}

/**
 * Parses a css unicode-range descriptor into [lo, hi] codepoint ranges. Handles the
 * single (U+41), range (U+460-52F), and wildcard (U+00??) forms; a token it cannot read
 * is skipped rather than failing the whole descriptor.
 *
 * @param descriptor - the unicode-range value
 */
function parseUnicodeRange(descriptor: string): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	for (const token of descriptor.split(',')) {
		const t = token.trim().replace(/^u\+/i, '');
		if (!t) continue;
		if (t.includes('?')) {
			const lo = parseInt(t.replace(/\?/g, '0'), 16);
			const hi = parseInt(t.replace(/\?/g, 'f'), 16);
			if (Number.isFinite(lo) && Number.isFinite(hi)) out.push([lo, hi]);
		} else if (t.includes('-')) {
			const [a, b] = t.split('-');
			const lo = parseInt(a ?? '', 16);
			const hi = parseInt(b ?? '', 16);
			if (Number.isFinite(lo) && Number.isFinite(hi)) out.push([lo, hi]);
		} else {
			const cp = parseInt(t, 16);
			if (Number.isFinite(cp)) out.push([cp, cp]);
		}
	}
	return out;
}

/**
 * Indexes the face a weight resolves to under the css-fonts-4 weight-matching
 * algorithm, generalized to weight ranges. Returns -1 only for an empty pool.
 *
 * @param desired - the requested numeric weight
 * @param ranges - each face's [min, max] weight descriptor, pool-aligned
 */
function matchWeight(desired: number, ranges: Array<[number, number]>): number {
	if (ranges.length === 0) return -1;
	// A face whose declared range covers the request is an exact match.
	const exact = ranges.findIndex(([lo, hi]) => desired >= lo && desired <= hi);
	if (exact !== -1) return exact;
	// Otherwise rank faces by the spec's directional preference, scoring each by
	// the range boundary nearest the request.
	const boundary = ([lo, hi]: [number, number]) => (desired < lo ? lo : hi);
	for (const weight of weightSearchOrder(desired, ranges.map(boundary))) {
		const index = ranges.findIndex((range) => boundary(range) === weight);
		if (index !== -1) return index;
	}
	return 0; // Unreachable for a non-empty pool; keep the first face defensively
}

/**
 * The order css font-matching prefers candidate weights in, for a request with
 * no exact face. The 400-500 band searches up to 500 first, then down, then the
 * heavier weights; below 400 prefers lighter; above 500 prefers heavier.
 */
function weightSearchOrder(desired: number, weights: number[]): number[] {
	const unique = [...new Set(weights)];
	const lighter = unique.filter((w) => w < desired).sort((a, b) => b - a);
	const heavier = unique.filter((w) => w > desired).sort((a, b) => a - b);
	if (desired >= 400 && desired <= 500) {
		return [...heavier.filter((w) => w <= 500), ...lighter, ...heavier.filter((w) => w > 500)];
	}
	if (desired < 400) return [...lighter, ...heavier];
	return [...heavier, ...lighter];
}

/** A face's [min, max] weight from its font-weight descriptor, either a single value or a range. */
function faceWeightRange(font: FontFace): [number, number] {
	const parts = (font.descriptors['font-weight'] ?? '400').trim().split(/\s+/).map(normalizeWeight);
	const lo = parts[0] ?? 400;
	const hi = parts[1] ?? lo;
	return [Math.min(lo, hi), Math.max(lo, hi)];
}

/** A face's style from its font-style descriptor, collapsed to the matching keyword. */
function faceStyle(font: FontFace): string {
	return normalizeStyle(font.descriptors['font-style'] ?? 'normal');
}

/** Resolve a css font-weight token to its numeric value (normal -> 400, bold -> 700). */
function normalizeWeight(raw: string): number {
	const value = raw.trim().toLowerCase();
	if (value === 'normal') return 400;
	if (value === 'bold') return 700;
	const numeric = parseInt(value, 10);
	return Number.isFinite(numeric) ? numeric : 400;
}

/** Collapse a css font-style value, which may carry an oblique angle, to its keyword. */
function normalizeStyle(raw: string): string {
	const value = raw.trim().toLowerCase();
	if (value.startsWith('italic')) return 'italic';
	if (value.startsWith('oblique')) return 'oblique';
	return 'normal';
}

/** Rewrite every url() inside an @font-face src to an absolute url. local()/data: untouched. */
function absolutizeSrc(src: string, base: string): string {
	return src.replace(URL_IN_SRC, (match, quote: string, url: string) => {
		if (/^(data:|blob:|https?:)/i.test(url)) return match; // Already absolute or inline
		try {
			return `url(${quote}${new URL(url, base).href}${quote})`;
		} catch {
			return match;
		}
	});
}

/** Strip quotes and trim a font-family token. The `font` shorthand may carry size/style noise; the last comma-list entries are still family names. */
function normalizeFamily(raw: string): string {
	return raw
		.replace(/^["']|["']$/g, '')
		.replace(/^\s*(?:\d+(?:\.\d+)?(?:px|rem|em|%)?\/?\S*\s+)+/, '') // Drop leading size/line-height from `font` shorthand
		.trim();
}

/** A stable key over the weight/style/unicode-range descriptors for dedupe. */
function descriptorKey(font: FontFace): string {
	return Object.entries(font.descriptors)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${k}:${v}`)
		.join(';');
}
