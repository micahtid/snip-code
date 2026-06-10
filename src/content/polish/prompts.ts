/**
 * polish/prompts.ts: llm polish prompt template
 *
 * Phase: i (ai polish), see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: 5, polish
 * Reads from Captured: n/a (operates on the vaulted code string)
 * Writes to Captured: n/a
 *
 * Principles applied: none (text generation).
 *
 * Why this exists: phase 5 is text-only and bills per token, so the prompt is
 * deliberately minimal, it asks the model for two cheap, high-value edits and a
 * strict json reply, nothing that could corrupt the deterministic markup (which
 * is already pixel-correct from phases 1-4). token-heavy values are vaulted
 * behind @@V*@@ placeholders before the model sees them, so it never touches
 * svgs/gradients/base64. ported (rewritten) from marketing-website
 * generation-prompts.ts (the post-stage-3-exp-14 text-only template).
 */

/**
 * builds the polish prompt for a vaulted code string.
 *
 * the model is asked ONLY to (1) propose semantic class renames and (2) add
 * hover/focus interaction rules, both purely additive, and to return strict
 * json so the result is machine-applicable. it must not rewrite the markup,
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
		'1. propose semantic class names to replace generated/hashed ones.',
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
