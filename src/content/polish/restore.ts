/**
 * polish/restore.ts: vault restore, hover-rule merge, orphan prune
 *
 * Pipeline position: polish
 * Reads from Captured: n/a; operates on html + css strings
 * Writes to Captured: n/a
 *
 * The orphan prune is dead-code elimination, not aesthetic surgery.
 *
 * Why this exists: the final polish step folds the llm's additive output back in.
 * Any @@V*@@ placeholders the model echoed into its hover rules are restored to
 * their original values (vault.restore), the validated hover rules are appended to
 * the css, and selectors whose class tokens no longer appear in the markup after
 * renaming are pruned. It never removes anything the markup still references.
 */
import type { VerbatimVault } from '../convert/vault';

/**
 * Finalizes the polished output: restores vaulted values in the hover rules,
 * appends them, and prunes orphan css rules.
 *
 * @param html - the renamed markup
 * @param css - the renamed stylesheet
 * @param hoverRules - additive interaction rules from the llm
 * @param vault - the vault used for the prompt, to restore any echoed placeholders
 * @returns the finalized html + css
 */
export function finalize(html: string, css: string, hoverRules: string[], vault: VerbatimVault): { html: string; css: string } {
	const restored = hoverRules.map((rule) => vault.restore(rule)).filter((rule) => looksLikeRule(rule));
	const merged = restored.length > 0 ? `${css}\n\n${restored.join('\n')}` : css;
	return { html, css: pruneOrphans(merged, html) };
}

/** A minimal sanity check that a string is a css rule, not prose. */
function looksLikeRule(rule: string): boolean {
	return /\{[^}]*\}/.test(rule) && !rule.includes('@@V');
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
