/**
 * polish/restore.ts: orphan prune after the polish edits
 *
 * Pipeline position: polish
 * Reads from Captured: n/a; operates on html + css strings
 * Writes to Captured: n/a
 *
 * The orphan prune is dead-code elimination, not aesthetic surgery.
 *
 * Why this exists: after the polish edits are applied, a class rename could leave a css rule
 * whose every class token no longer appears in the markup. This drops exactly those rules
 * and never touches one the markup still references. Interactive and generated-content rules
 * are re-emitted deterministically upstream, so polish no longer adds any css of its own.
 */

/**
 * Finalizes the polished output by dropping css rules the renamed markup no longer uses.
 *
 * @param html - the polished markup
 * @param css - the polished stylesheet
 * @returns the finalized html + css
 */
export function finalize(html: string, css: string): { html: string; css: string } {
	return { html, css: pruneOrphans(css, html) };
}

/**
 * Drops css rules whose every class-selector token is absent from the markup.
 * Conservative: a rule is removed only when none of its `.class` tokens appear as
 * a class in the html, so element/pseudo/attribute rules are always kept.
 */
function pruneOrphans(css: string, html: string): string {
	const present = htmlClassTokens(html);
	return css.replace(/([^{}]+)\{[^}]*\}/g, (block, selector: string) => {
		const classes = (selector.match(/\.[A-Za-z_][\w-]*/g) ?? []).map((c) => c.slice(1));
		if (classes.length === 0) return block; // Not class-targeted; keep.
		return classes.some((c) => present.has(c)) ? block : '';
	});
}

/** The set of class tokens used by any element in the html. */
function htmlClassTokens(html: string): Set<string> {
	const tokens = new Set<string>();
	const re = /\bclass="([^"]*)"/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html)) !== null) {
		for (const token of (m[1] ?? '').split(/\s+/)) if (token) tokens.add(token);
	}
	return tokens;
}
