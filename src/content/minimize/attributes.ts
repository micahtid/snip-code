/**
 * minimize/attributes.ts: strip unreferenced data attributes from the markup
 *
 * Pipeline position: minimize, last, a markup pass after the css chain
 * Reads from Captured: nothing; operates on the emitted markup + final stylesheet strings
 * Writes to Captured: nothing; returns the trimmed markup
 *
 * Why this exists: a framework leaves scope and instrumentation attributes all over the
 * markup, `data-astro-cid-*`, `data-f1rd-a7s-click`, dozens per element, that no css selector
 * ever matches. A human writing this page by hand would carry none of them. This drops every
 * `data-*` attribute whose name no selector in the shipped stylesheet references, so the markup
 * reads as the elements and hooks that actually style the component.
 *
 * Safety is by construction: an attribute no selector matches is inert for rendering, so
 * removing it cannot move a pixel. The rule is scoped to `data-*` names, so `aria-*` and every
 * functional attribute, id, class, href, src, are untouched, keeping semantics and
 * accessibility intact. The `data-snip-state` and `data-snip-pseudo` markers survive on their
 * own merit whenever a state or pseudo selector still names them, and are dropped only where
 * nothing does, with no special case. The referenced-name scan errs toward keeping: a stray
 * `[` inside a value only adds a name to the kept set, never removes one.
 *
 * The strip is textual and tag-scoped, matching each open tag and removing the dead attribute
 * inside it, so every other byte, the pretty-printer's indentation included, is preserved
 * exactly and text content is never touched. The emitter double-quotes and escapes every
 * attribute value, so a quoted value delimits cleanly and a `>` inside one does not end the tag.
 */

/**
 * Removes every `data-*` attribute the shipped stylesheet never references from the markup.
 * Deterministic and formatting-preserving: a pure string transform that edits only open tags.
 *
 * @param html - the pretty-printed emitted markup
 * @param css - the final shipped stylesheet, scanned for the attribute names its selectors use
 * @returns the markup with dead data attributes removed
 */
export function stripUnreferencedDataAttributes(html: string, css: string): string {
	if (!html.includes('data-')) return html;
	const referenced = referencedAttributeNames(css);
	return html.replace(OPEN_TAG, (tag) => stripDeadDataAttrs(tag, referenced));
}

/**
 * An open or self-closing start tag, from `<name` to its matching `>`. A double-quoted value
 * is spanned as a unit so a `>` inside it does not end the tag early; the emitter always
 * double-quotes, so no single-quoted or unquoted value needs handling here. Comments, the
 * doctype, and closing tags do not start with a letter, so they are left alone.
 */
const OPEN_TAG = /<[a-zA-Z][a-zA-Z0-9-]*(?:[^>"]|"[^"]*")*>/g;

/**
 * The attribute names any selector in the stylesheet references, lowercased. Collected from
 * every `[name` that opens an attribute selector. Over-collection is safe: a `[` that is
 * actually inside a value or a data uri only adds a spurious name to the kept set, so no
 * referenced attribute is ever dropped.
 *
 * @param css - the stylesheet text
 */
function referencedAttributeNames(css: string): Set<string> {
	const names = new Set<string>();
	for (const m of css.matchAll(/\[\s*([A-Za-z_][\w-]*)/g)) names.add(m[1]!.toLowerCase());
	return names;
}

/**
 * Removes each `data-*` attribute in one start tag whose name the stylesheet never references,
 * leaving every referenced attribute and every non-data attribute in place. Attribute values
 * are double-quoted and their inner quotes escaped, so `="[^"]*"` matches a value exactly.
 *
 * @param tag - one start tag, angle brackets included
 * @param referenced - the attribute names the stylesheet references, lowercased
 */
function stripDeadDataAttrs(tag: string, referenced: Set<string>): string {
	return tag.replace(/\s+([a-zA-Z_][\w-]*)="[^"]*"/g, (whole, name: string) => {
		const lower = name.toLowerCase();
		return lower.startsWith('data-') && !referenced.has(lower) ? '' : whole;
	});
}
