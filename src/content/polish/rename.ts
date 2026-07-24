/**
 * polish/rename.ts: polish edit application, class renames, semantic tags, grouping comments.
 *
 * Pipeline position: polish.
 * This does not read from Captured. It operates on html and css strings.
 * It does not write to Captured.
 *
 * No principles apply here, since these are text transforms.
 *
 * Why this exists: the model's edits are applied here. A class rename must rewrite the
 * markup's class attributes and the css selectors in lockstep, or the styles detach. It
 * rewrites whole class tokens only, so "btn" never rewrites inside "btn-primary". A semantic
 * tag swap rewrites one uniquely-classed element's tag name. A grouping comment is inserted
 * before the rule its selector names. Each edit is best-effort and independently
 * render-verified downstream, so a bad one is caught and the whole polish falls back cleanly.
 */

/**
 * Applies a class renameMap to html and css in lockstep.
 *
 * @param html - the markup
 * @param css - the accompanying stylesheet
 * @param renameMap - old class token -> new class token
 * @returns the renamed html + css
 */
export function applyRenames(html: string, css: string, renameMap: Record<string, string>): { html: string; css: string } {
	let h = html;
	let c = css;
	for (const [oldName, newName] of Object.entries(renameMap)) {
		if (!isSafeClass(oldName) || !isSafeClass(newName) || oldName === newName) continue;
		h = renameInClassAttributes(h, oldName, newName);
		c = renameInSelectors(c, oldName, newName);
	}
	return { html: h, css: c };
}

/** Rewrite a class token inside every html class="..." attribute. */
function renameInClassAttributes(html: string, oldName: string, newName: string): string {
	return html.replace(/\bclass="([^"]*)"/g, (_m, classes: string) => {
		const renamed = classes
			.split(/\s+/)
			.map((token) => (token === oldName ? newName : token))
			.join(' ');
		return `class="${renamed}"`;
	});
}

/** Rewrite a class selector token in css, whole-token only. */
function renameInSelectors(css: string, oldName: string, newName: string): string {
	// Match `.oldName` only when not followed by another class-name char.
	const re = new RegExp(`\\.${escapeRegExp(oldName)}(?![\\w-])`, 'g');
	return css.replace(re, `.${newName}`);
}

/** Safe html tag names the model may swap an element to. This excludes replaced, void, form,
 * and interactive tags whose ua behaviour or box differs, keeping only inert flow and
 * sectioning containers plus headings, so a swap cannot change rendering or semantics beyond
 * the tag name. Render-neutrality is still verified downstream regardless. */
const SAFE_TAGS = new Set([
	'div', 'span', 'section', 'article', 'aside', 'nav', 'header', 'footer', 'main', 'figure',
	'figcaption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'blockquote',
]);

/**
 * Swaps the tag of each uniquely-classed element named in the tag map. Only an element whose
 * class is borne by exactly one node is retagged, so a swap can never move onto a sibling,
 * and only to a safe container tag. The element's attributes and children are preserved.
 *
 * @param html - the markup
 * @param tagMap - class token -> new tag name
 * @returns the markup with the tags swapped, or unchanged if it will not parse
 */
export function applyTags(html: string, tagMap: Record<string, string>): string {
	const entries = Object.entries(tagMap).filter(([cls, tag]) => isSafeClass(cls) && SAFE_TAGS.has(tag.toLowerCase()));
	if (entries.length === 0) return html;
	try {
		const doc = new DOMParser().parseFromString(html, 'text/html');
		for (const [cls, tag] of entries) {
			const matches = doc.body.querySelectorAll(`.${cls}`);
			if (matches.length !== 1) continue; // Shared or absent class: leave it.
			const el = matches[0]!;
			if (el.tagName.toLowerCase() === tag.toLowerCase()) continue;
			const replacement = doc.createElement(tag);
			for (const attr of Array.from(el.attributes)) replacement.setAttribute(attr.name, attr.value);
			replacement.innerHTML = el.innerHTML;
			el.replaceWith(replacement);
		}
		return doc.body.innerHTML;
	} catch {
		return html;
	}
}

/**
 * Inserts a grouping comment before each rule whose selector the comment map names. The css
 * is one rule per block, so a comment is prepended on its own line before the matching
 * selector; a selector that matches no rule is skipped. Comment text is sanitized so it
 * cannot close the comment or inject css.
 *
 * @param css - the formatted stylesheet
 * @param comments - rule selector -> comment text
 * @returns the stylesheet with grouping comments inserted
 */
export function applyComments(css: string, comments: Record<string, string>): string {
	let out = css;
	for (const [selector, text] of Object.entries(comments)) {
		const sanitized = String(text).replace(/\*\//g, '').replace(/[\r\n]+/g, ' ').trim();
		const clean = normalizeComment(sanitized);
		if (!clean || !selector.trim()) continue;
		const re = new RegExp(`(^|\\n)(${escapeRegExp(selector.trim())}\\s*\\{)`, '');
		// Insert via a replacer so a `$` sequence in the model's comment is written literally
		// rather than interpreted as a capture-group backreference.
		out = out.replace(re, (_m, before, rule) => `${before}/* ${clean} */\n${rule}`);
	}
	return out;
}

/**
 * Normalizes one grouping comment to the house format: a capitalized noun phrase with no
 * leading article and no trailing punctuation. The prompt asks for this shape, but the model
 * drifts, so the format is enforced here rather than trusted. The article is dropped before
 * the first character is cased, so "the product card" becomes "Product card" rather than
 * "The product card". Only the first character is touched, so acronyms and proper nouns
 * survive intact.
 *
 * @param text - the raw comment text from the model
 * @returns the normalized comment, or an empty string if nothing is left
 */
export function normalizeComment(text: string): string {
	let out = String(text).replace(/\s+/g, ' ').trim();
	out = out.replace(/[.!:]+$/, '').trim();
	out = out.replace(/^(?:the|an|a)\s+/i, '').trim();
	if (!out) return '';
	return out.charAt(0).toUpperCase() + out.slice(1);
}

/** Only rename plain class tokens; reject anything that could break a selector. */
function isSafeClass(name: string): boolean {
	return /^[A-Za-z_][\w-]*$/.test(name);
}

/** Escape a string for safe use inside a RegExp. */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
