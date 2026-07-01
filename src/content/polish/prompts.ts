/**
 * polish/prompts.ts: llm polish prompt template
 *
 * Pipeline position: polish
 * Reads from Captured: n/a; operates on the vaulted code string
 * Writes to Captured: n/a
 *
 * Principles applied: none; text generation.
 *
 * Why this exists: the polish phase is text-only and bills per token, so the prompt is
 * deliberately minimal, it asks the model for two cheap, high-value edits and a
 * strict json reply, nothing that could corrupt the deterministic markup, which
 * is already pixel-correct from the earlier phases. Token-heavy values are vaulted
 * behind @@V*@@ placeholders before the model sees them, so it never touches
 * svgs/gradients/base64. Ported and rewritten from marketing-website
 * generation-prompts.ts, the post-stage-3-exp-14 text-only template.
 */

/**
 * Builds the polish prompt for a vaulted code string.
 *
 * The model is asked ONLY to propose semantic class renames and add
 * hover/focus interaction rules, both purely additive, and to return strict
 * json so the result is machine-applicable. It must not rewrite the markup,
 * touch @@V*@@ placeholders, or change any geometry.
 *
 * @param vaultedCode - the html+css with fragile values replaced by placeholders
 */
export function buildPolishPrompt(vaultedCode: string): string {
	return [
		'you are refining an already-pixel-correct html+css snippet. do not change',
		'any layout, sizes, colors, or geometry. do not modify @@V*@@ placeholders.',
		'',
		'two tasks, both purely additive:',
		'1. propose semantic class names to replace generated/hashed ones. some elements',
		'   carry a shared base class plus a per-element modifier (e.g. "x__group-1" and',
		'   "x__group-1--2" together): rename the base once and each modifier to match it',
		'   ("button" + "button--primary"), and keep both classes on the element. never',
		'   collapse a base and its modifier into a single class.',
		'2. add :hover and :focus-visible interaction rules where they clearly fit',
		'   (buttons, links, inputs), using only colors/values already present.',
		'',
		'reply with STRICT json and nothing else:',
		'{',
		'  "renameMap": { "old-class": "new-semantic-class" },',
		'  "hoverRules": [".new-class:hover { ... }"]',
		'}',
		'',
		'the snippet:',
		'```',
		vaultedCode,
		'```',
	].join('\n');
}
