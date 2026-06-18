/**
 * resolve/fonts.ts: @font-face resolution
 *
 * Pipeline position: resolve
 * Reads from Captured: root, fonts
 * Writes to Captured: fonts (absolutized src, narrowed to the faces the snip renders)
 *
 * Travel-with-the-snip rule for fonts: a used custom font must carry its
 * @font-face and an absolute src so it loads from the snip's new home.
 *
 * Why this exists: @font-face src urls are usually relative to the source page;
 * pasted elsewhere they 404. This resolves them to absolute urls and narrows the
 * captured @font-face list to the faces the snip actually renders. A source page
 * commonly ships every weight of a family (light through bold) while a snipped
 * component renders only one or two, so narrowing to the used family is not
 * enough: the other weights are dead @font-face rules and dead font downloads.
 * The narrowing therefore matches on the full (family, weight, style) that the
 * live subtree renders, resolved through the css-fonts-4 font-matching algorithm
 * so a request the family has no exact face for (e.g. weight 700 against a 600
 * bold) still keeps the face the browser substitutes. Requests are read from the
 * live computed styles (root subtree + the generated-content pseudo-elements),
 * which pairs each rendered family with the weight and style it renders at, the
 * same "first family is the one that renders" ground truth assistive/fonts.ts
 * uses. Generic keywords (serif, system-ui,...) never match a captured
 * @font-face family, so they fall out naturally, no banned-keyword set needed.
 * Ported (rewritten) from v1 font-extractor.ts.
 */
import type { Captured, FontFace } from '../types';

const URL_IN_SRC = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;

/**
 * The generated-content pseudo-elements whose own font can differ from the host
 * element's, mirroring the set features/pseudo.ts materializes. Sampling them
 * keeps a face that only a pseudo renders (e.g. an icon-font ::before).
 */
const PSEUDO_ELEMENTS = ['::before', '::after', '::marker', '::placeholder', '::file-selector-button'];

/** One (weight, style) a family is rendered at somewhere in the subtree. */
interface FaceRequest {
	weight: number; // Numeric css weight (1-1000); normal -> 400, bold -> 700
	style: string; // 'normal' | 'italic' | 'oblique'
}

/**
 * Narrows captured @font-face entries to the faces the snip renders and
 * absolutizes their src.
 *
 * @param captured - fonts is replaced in place with the resolved, used subset
 */
export function resolveFonts(captured: Captured): void {
	const requests = faceRequests(captured.root);
	const base = document.baseURI || location.href;
	const seen = new Set<string>();
	const resolved: FontFace[] = [];

	for (const font of keptFaces(captured.fonts, requests)) {
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
 */
function keptFaces(fonts: FontFace[], requests: Map<string, FaceRequest[]>): FontFace[] {
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
			const face = selectFace(req, faces);
			if (face) keep.add(face);
		}
	}
	return fonts.filter((font) => keep.has(font));
}

/** The (family, weight, style) triples the live subtree renders, keyed by lowercased family. */
function faceRequests(root: Element): Map<string, FaceRequest[]> {
	const requests = new Map<string, FaceRequest[]>();
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
		for (const pseudo of renderedPseudos(el)) record(getComputedStyle(el, pseudo));
	}
	return requests;
}

/** Which pseudo-elements actually generate a box on this element (so their font renders). */
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
 * The captured face one weight request resolves to, or null when the family has
 * none. Faces of the requested style win; if the family has no face in that
 * style the browser synthesizes it from any weight, so all faces stay eligible.
 */
function selectFace(request: FaceRequest, faces: FontFace[]): FontFace | null {
	const styled = faces.filter((face) => faceStyle(face) === request.style);
	const pool = styled.length > 0 ? styled : faces;
	const index = matchWeight(request.weight, pool.map(faceWeightRange));
	return index === -1 ? null : pool[index] ?? null;
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

/** A face's [min, max] weight from its font-weight descriptor (a single value or a range). */
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

/** Collapse a css font-style value (which may carry an oblique angle) to its keyword. */
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
