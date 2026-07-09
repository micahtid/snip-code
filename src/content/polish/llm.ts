/**
 * polish/llm.ts: polish-phase orchestrator, byok llm polish.
 *
 * Pipeline position: polish.
 * This does not read from Captured. It operates on the emitted html and css.
 * It does not write to Captured. It returns polished html and css.
 *
 * The orphan prune in restore.finalize removes only dead code.
 *
 * Why this exists: the polish phase is the optional, byok-gated finishing pass. It asks the
 * user's own llm, via the background broker, for two additive edits (semantic class renames
 * and hover/focus rules), then applies them locally. It never sends a key, because background
 * reads it from storage. It never blocks either. If no key is configured, or the request
 * fails, it returns the deterministic output of the earlier phases unchanged. Token-heavy
 * values are vaulted before the prompt so the model cannot corrupt them and the token bill
 * stays small. This was ported and rewritten from marketing-website openrouter.ts, taking
 * only the request shape and response parsing. None of the original's account,
 * credit-accounting, or backend-verification code came along.
 */
import type { Captured, Provider, TokenUsage } from '../types';
import { requestLlm, NO_KEY } from '../llm';
import { VerbatimVault } from '../convert/vault';
import { inScopeRule } from '../minimize/declarations';
import { buildPolishPrompt } from './prompts';
import { applyRenames, applyTags, applyComments } from './rename';
import { finalize } from './restore';
import { polishRenderNeutral } from './verify';

/** The polish edits parsed out of the model's reply text. */
interface PolishEdits {
	renameMap: Record<string, string>;
	tagMap: Record<string, string>;
	comments: Record<string, string>;
}

/**
 * Runs the polish phase if a key is configured, and otherwise returns the input unchanged.
 *
 * Polish is best-effort and safe. A missing key is an intentional, silent skip. A
 * configured-key failure returns a `warning` so the orchestrator can surface why the phase
 * produced no edits. An edit that changes the render is reverted to the pre-polish output,
 * because the edits (semantic class renames, tag swaps, and grouping comments) are all meant
 * to be render-neutral. The interactive and generated-content rules are stripped before the
 * prompt so the model never sees or regenerates them.
 *
 * @param captured - source of the viewport size, used to verify render-neutrality
 * @param html - markup from the earlier phases
 * @param css - stylesheet from the earlier phases
 * @param provider - the active byok provider
 * @param model - the model to use, resolved by the caller from prefs/defaults
 * @returns polished html + css, the provider-reported token usage when an edit ran, plus a
 *   warning when a configured key was present but the request failed or the edit was reverted
 */
export async function polish(
	captured: Captured,
	html: string,
	css: string,
	provider: Provider,
	model: string,
): Promise<{ html: string; css: string; warning?: string; usage?: TokenUsage }> {
	// Show the model only the resting class rules, vaulting token-heavy values, so it never
	// sees the state, pseudo, and at-rules and cannot regenerate or truncate them. The working
	// html and css stay whole and un-vaulted, because the model returns instructions, not code.
	const vault = new VerbatimVault();
	const vaulted = vault.protect(`<style>${stripWithheld(css)}</style>\n${html}`);
	const prompt = buildPolishPrompt(vaulted);

	const { text, error, usage } = await requestLlm(provider, model, prompt);
	if (text === null) {
		// No key is the intended no-op. Any other error means a configured key was
		// present but the request failed, so surface it rather than hiding it. A
		// failed-but-billed reply still reports usage, so pass it through to be counted.
		if (error && error !== NO_KEY) {
			console.warn('snipcode: llm polish skipped', error);
			const warning = `llm polish skipped: ${error}`;
			return usage ? { html, css, warning, usage } : { html, css, warning };
		}
		return { html, css };
	}

	const edits = parseReply(text);
	const renamed = applyRenames(html, css, edits.renameMap);
	const taggedHtml = applyTags(renamed.html, edits.tagMap);
	const commentedCss = applyComments(renamed.css, edits.comments);
	const out = finalize(taggedHtml, commentedCss);

	// Verify the polished artifact renders identically. A model can rename inconsistently or
	// swap a tag whose ua styles differ, so a non-neutral edit falls back to the safe output.
	if (!polishRenderNeutral(captured, html, css, out.html, out.css)) {
		const warning = 'llm polish reverted: an edit changed the render';
		return usage ? { html, css, warning, usage } : { html, css, warning };
	}
	return usage ? { ...out, usage } : out;
}

/**
 * The stylesheet with only its in-scope resting class rules kept, so the prompt hides the
 * interactive-state, pseudo-element, and at-rules the model must not touch. It is parsed
 * through the browser so a data-uri brace can never mislead it. Returns the input unchanged
 * if it will not parse.
 *
 * @param css - the full stylesheet
 */
function stripWithheld(css: string): string {
	try {
		const sheet = new CSSStyleSheet();
		sheet.replaceSync(css);
		return Array.from(sheet.cssRules)
			.map((rule) => inScopeRule(rule))
			.filter((rule): rule is CSSStyleRule => rule !== null)
			.map((rule) => rule.cssText)
			.join('\n');
	} catch {
		return css;
	}
}

/**
 * Parses the model's reply into the polish edits. It is lenient by design. A missing or
 * malformed reply, or a missing field, yields empty edits, which is a clean no-op, rather
 * than throwing.
 */
function parseReply(text: string): PolishEdits {
	const match = text.match(/\{[\s\S]*\}/);
	const empty: PolishEdits = { renameMap: {}, tagMap: {}, comments: {} };
	if (!match) return empty;
	try {
		const parsed = JSON.parse(match[0]) as Record<string, unknown>;
		return {
			renameMap: stringMap(parsed['renameMap']),
			tagMap: stringMap(parsed['tagMap']),
			comments: stringMap(parsed['comments']),
		};
	} catch {
		return empty;
	}
}

/** A record of string values from an untrusted parsed value, or an empty record. */
function stringMap(value: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (value && typeof value === 'object') {
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (typeof v === 'string') out[k] = v;
		}
	}
	return out;
}
