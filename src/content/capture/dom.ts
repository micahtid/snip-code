/**
 * capture/dom.ts: dom clone + element metadata extraction
 *
 * Pipeline position: capture
 * Reads from Captured: root (the live element)
 * Writes to Captured: clone, element (metadata block)
 *
 * Why this exists: the pipeline mutates a detached copy of the picked subtree so
 * the live page is never touched. This module produces that copy and the element
 * metadata block (selectors, xpath, bounding box, ancestors) that both snip and
 * assistive modes consume. It also promotes lazy-loaded image
 * sources at clone time so images render when the snip is pasted elsewhere
 * (ported from v1 extraction-pipeline cloneElement). Shadow piercing is added
 * later (cdp); this is the cssom/light-dom baseline.
 */
import type { Captured } from '../types';

/**
 * Common lazy-loading attribute names, in priority order. These are html
 * attribute names for a universal lazy-img convention, normalized at capture so
 * output is portable.
 */
const LAZY_SRC_ATTRS = ['data-src', 'data-lazy-src', 'data-original', 'data-srcset'] as const;

/**
 * Deep-clones the picked subtree into a detached node and promotes lazy images.
 *
 * cloneNode(true) already copies every attribute and child; the extra work here
 * is replacing placeholder `src`s (1x1 gifs, data-uri spacers) with the real url
 * stashed in a data-* attribute, so a pasted snip shows the image immediately
 * instead of waiting for the host page's lazy-load script that no longer runs.
 *
 * @param root - the live element the user picked
 * @returns a detached clone, safe to mutate downstream
 */
export function cloneElement(root: Element): Element {
	const clone = root.cloneNode(true) as Element;
	for (const img of Array.from(clone.querySelectorAll('img'))) {
		const src = img.getAttribute('src') ?? '';
		if (!isPlaceholderSrc(src)) continue;
		for (const attr of LAZY_SRC_ATTRS) {
			const lazy = img.getAttribute(attr);
			if (lazy && !isPlaceholderSrc(lazy)) {
				img.setAttribute(attr.includes('srcset') ? 'srcset' : 'src', lazy);
				break;
			}
		}
	}
	return clone;
}

/** True for the empty/spacer srcs lazy-loaders use before swapping in the real one. */
function isPlaceholderSrc(src: string): boolean {
	return !src || src.startsWith('data:image') || src.includes('1x1') || src.includes('placeholder');
}

/**
 * Builds the element metadata block.
 *
 * Both modes need this: snip uses the tag/box, assistive emits the whole block
 * as json. Emits two selectors, `selector` (shortest unique) and
 * `robustSelector` (prefers stable data-attributes or ids over class hashes) so a
 * downstream agent can re-find the element even if class hashes churn.
 *
 * @param root - the live picked element
 * @returns the populated metadata block
 */
export function buildElementMetadata(root: Element): Captured['element'] {
	const rect = root.getBoundingClientRect();
	const text = (root as HTMLElement).innerText ?? root.textContent ?? '';
	return {
		tagName: root.tagName.toLowerCase(),
		selector: shortestSelector(root),
		robustSelector: robustSelector(root),
		xpath: xpathOf(root),
		boundingBox: {
			x: rect.left + window.scrollX,
			y: rect.top + window.scrollY,
			w: rect.width,
			h: rect.height,
		},
		innerText: text,
		innerTextSnippet: text.slice(0, 200),
		classList: Array.from(root.classList),
		id: root.id || null,
		ancestors: ancestorsOf(root),
	};
}

/** Serializes the (already reconciled) clone to an html string. */
export function serializeRaw(clone: Element): string {
	return clone.outerHTML;
}

/**
 * Shortest css selector that uniquely identifies `el` in its document.
 *
 * Tries cheapest-first: a unique id, then a unique single-class, then walks up
 * building a descendant path with :nth-of-type segments until querySelectorAll
 * returns exactly this element. Uniqueness is verified against the live document
 * rather than assumed, so the emitted selector is always correct.
 */
function shortestSelector(el: Element): string {
	if (el.id && isUnique(`#${cssEscape(el.id)}`, el)) return `#${cssEscape(el.id)}`;
	for (const cls of Array.from(el.classList)) {
		const sel = `${el.tagName.toLowerCase()}.${cssEscape(cls)}`;
		if (isUnique(sel, el)) return sel;
	}
	// Build a path from the nearest id-anchored or document root down to el.
	const parts: string[] = [];
	let node: Element | null = el;
	while (node && node.nodeType === Node.ELEMENT_NODE) {
		if (node.id && isUnique(`#${cssEscape(node.id)}`, node)) {
			parts.unshift(`#${cssEscape(node.id)}`);
			break;
		}
		const tag = node.tagName.toLowerCase();
		const idx = indexAmongType(node);
		parts.unshift(idx ? `${tag}:nth-of-type(${idx})` : tag);
		const candidate = parts.join(' > ');
		if (isUnique(candidate, el)) return candidate;
		node = node.parentElement;
	}
	return parts.join(' > ');
}

/**
 * A selector that survives class-hash churn: prefers a stable data-* attribute,
 * then a non-generated-looking id, before falling back to the shortest selector.
 */
function robustSelector(el: Element): string {
	const tag = el.tagName.toLowerCase();
	for (const attr of el.getAttributeNames()) {
		// Stable hooks are usually data-testid / data-section-id / data-id etc.
		if (attr.startsWith('data-') && /id|test|section|name|component/.test(attr)) {
			const val = el.getAttribute(attr);
			if (val) {
				const sel = `${tag}[${attr}="${cssEscapeAttr(val)}"]`;
				if (isUnique(sel, el)) return sel;
			}
		}
	}
	// An id without a long hex/hash tail reads as author-stable, not generated.
	if (el.id && !/[0-9a-f]{6,}/i.test(el.id) && isUnique(`#${cssEscape(el.id)}`, el)) {
		return `#${cssEscape(el.id)}`;
	}
	return shortestSelector(el);
}

/** Absolute xpath with positional indices. */
function xpathOf(el: Element): string {
	const parts: string[] = [];
	let node: Element | null = el;
	while (node && node.nodeType === Node.ELEMENT_NODE) {
		const idx = indexAmongType(node) || 1;
		parts.unshift(`${node.tagName.toLowerCase()}[${idx}]`);
		node = node.parentElement;
	}
	return `/${parts.join('/')}`;
}

/** The ancestor chain up to <body>, each with its own shortest selector + role. */
function ancestorsOf(el: Element): Array<{ tagName: string; selector: string; role?: string }> {
	const out: Array<{ tagName: string; selector: string; role?: string }> = [];
	let node = el.parentElement;
	while (node && node.tagName !== 'BODY' && node.tagName !== 'HTML') {
		const role = node.getAttribute('role');
		out.push({
			tagName: node.tagName.toLowerCase(),
			selector: shortestSelector(node),
			// Omit the key entirely when absent (exactOptionalPropertyTypes).
			...(role ? { role } : {}),
		});
		node = node.parentElement;
	}
	return out;
}

/** 1-based index of `el` among siblings sharing its tag, or 0 if it is the only one. */
function indexAmongType(el: Element): number {
	const parent = el.parentElement;
	if (!parent) return 0;
	const sameTag = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
	if (sameTag.length <= 1) return 0;
	return sameTag.indexOf(el) + 1;
}

/** True when `selector` matches exactly `el` and nothing else in the document. */
function isUnique(selector: string, el: Element): boolean {
	try {
		const found = document.querySelectorAll(selector);
		return found.length === 1 && found[0] === el;
	} catch {
		return false;
	}
}

/** Escape a class/id token for use in a css selector. */
function cssEscape(value: string): string {
	// CSS.escape is standard in mv3 browsers; guard anyway for headless contexts.
	return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/([^\w-])/g, '\\$1');
}

/** Escape an attribute value for an [attr="..."] selector. */
function cssEscapeAttr(value: string): string {
	return value.replace(/"/g, '\\"');
}
