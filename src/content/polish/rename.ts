/**
 * polish/rename.ts: class rename application
 *
 * Phase: i (ai polish), see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: 5, polish
 * Reads from Captured: n/a (operates on html + css strings)
 * Writes to Captured: n/a
 *
 * Principles applied: none (text transform).
 *
 * Why this exists: when the llm proposes semantic class names, both the markup's
 * class attributes and the css selectors must be renamed in lockstep or the
 * styles detach. this applies a renameMap to html class attributes and css class
 * selectors together, matching whole class tokens only (so "btn" never rewrites
 * inside "btn-primary"). ported (rewritten) from v1 class-rename-sync.ts.
 */

/**
 * applies a class renameMap to html and css in lockstep.
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

/** rewrite a class token inside every html class="..." attribute. */
function renameInClassAttributes(html: string, oldName: string, newName: string): string {
	return html.replace(/\bclass="([^"]*)"/g, (_m, classes: string) => {
		const renamed = classes
			.split(/\s+/)
			.map((token) => (token === oldName ? newName : token))
			.join(' ');
		return `class="${renamed}"`;
	});
}

/** rewrite a class selector token in css, whole-token only. */
function renameInSelectors(css: string, oldName: string, newName: string): string {
	// match `.oldName` only when not followed by another class-name char.
	const re = new RegExp(`\\.${escapeRegExp(oldName)}(?![\\w-])`, 'g');
	return css.replace(re, `.${newName}`);
}

/** only rename plain class tokens; reject anything that could break a selector. */
function isSafeClass(name: string): boolean {
	return /^[A-Za-z_][\w-]*$/.test(name);
}

/** escape a string for safe use inside a RegExp. */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
