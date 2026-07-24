/**
 * polish/prompts.ts: llm polish prompt template.
 *
 * Pipeline position: polish.
 * This does not read from Captured. It operates on the vaulted code string.
 * It does not write to Captured.
 *
 * No principles apply here, since this is text generation.
 *
 * Why this exists: the polish phase is text-only and bills per token, so the prompt is
 * deliberately minimal. It asks the model for two cheap, high-value edits and a strict json
 * reply, and nothing that could corrupt the deterministic markup, which is already
 * pixel-correct from the earlier phases. Token-heavy values are vaulted behind @@V*@@
 * placeholders before the model sees them, so it never touches svgs, gradients, or base64.
 * This was ported and rewritten from marketing-website generation-prompts.ts, the text-only
 * template.
 */

/**
 * Builds the polish prompt for a vaulted code string.
 *
 * The css and markup reaching the model are already minimal and pixel-correct from the
 * earlier phases, and the interactive state and pseudo-element rules are withheld before the
 * prompt, so the model never sees or regenerates them. It is asked only for the jobs a
 * deterministic pass cannot do: naming, semantic tags, and grouping comments. These are all
 * render-neutral and all returned as strict json, so the result is machine-applicable and
 * the artifact is re-verified before it ships. It must not rewrite declarations, touch @@V*@@
 * placeholders, or change any geometry.
 *
 * @param vaultedCode - the html+css with fragile values replaced by placeholders
 */
export function buildPolishPrompt(vaultedCode: string): string {
	return [
		'you are naming an already-pixel-correct html+css snippet. do not change any layout,',
		'sizes, colors, geometry, or declarations. do not modify @@V*@@ placeholders.',
		'',
		'three tasks, all render-neutral:',
		'1. renameMap: propose semantic class names to replace generated/hashed ones. some',
		'   elements carry a shared base class plus a per-element modifier (e.g. "x__group-1"',
		'   and "x__group-1--2" together): rename the base once and each modifier to match it',
		'   ("button" + "button--primary"), keep both classes on the element, never collapse a',
		'   base and its modifier into one class. each value is a single class token.',
		'2. tagMap: where an element\'s role is unambiguous, map its class to a more semantic',
		'   html tag (e.g. a nav container to "nav", a heading div to "h2"). only when the tag',
		'   change cannot alter rendering; when unsure, leave it out.',
		'3. comments: short grouping comments to place before a rule, keyed by that rule\'s',
		'   selector. each is a plain english noun phrase for what the rule styles, starting with',
		'   a capital letter, no trailing period, no css or class names inside it, e.g.',
		'   { ".card": "Product card container" }. keep them short enough to scan at a glance.',
		'',
		'reply with STRICT json and nothing else:',
		'{',
		'  "renameMap": { "old-class": "new-semantic-class" },',
		'  "tagMap": { "class-name": "section" },',
		'  "comments": { ".selector": "What this rule styles" }',
		'}',
		'',
		'the snippet:',
		'```',
		vaultedCode,
		'```',
	].join('\n');
}
