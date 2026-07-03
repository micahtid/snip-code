/**
 * polish/llm.ts: polish-phase orchestrator, byok llm polish
 *
 * Pipeline position: polish
 * Reads from Captured: n/a; operates on the emitted html + css
 * Writes to Captured: n/a; returns polished html + css
 *
 * The orphan prune in restore.finalize removes only dead code.
 *
 * Why this exists: the polish phase is the optional, byok-gated finishing pass. It asks the
 * user's own llm, via the background broker, for two additive edits, semantic
 * class renames and hover/focus rules, then applies them locally. It never sends
 * a key, since background reads it from storage, and never blocks: if no key is
 * configured, or the request fails, it returns the deterministic output of the
 * earlier phases unchanged. Token-heavy values are vaulted before the prompt so the model
 * cannot corrupt them and the token bill stays small. Ported and rewritten from
 * marketing-website openrouter.ts, taking the request shape and response parsing
 * only, none of the original's account, credit-accounting, or backend-verification code.
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
 * Runs the polish phase if a key is configured; otherwise returns the input unchanged.
 *
 * Polish is best-effort and safe: a missing key is an intentional, silent skip; a
 * configured-key failure returns a `warning` so the orchestrator can surface why the phase
 * produced no edits; and an edit that changes the render is reverted to the pre-polish
 * output, since the edits, semantic class renames, tag swaps, and grouping comments, are all
 * meant to be render-neutral. The interactive and generated-content rules are stripped
 * before the prompt so the model never sees or regenerates them.
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
	// sees the state/pseudo/at-rules and cannot regenerate or truncate them. The working
	// html/css stay whole and un-vaulted, since the model returns instructions, not code.
	const vault = new VerbatimVault();
	const vaulted = vault.protect(`<style>${stripWithheld(css)}</style>\n${html}`);
	const prompt = buildPolishPrompt(vaulted);

	const { text, error, usage } = await requestLlm(provider, model, prompt);
	if (text === null) {
		// No key is the intended no-op; any other error means a configured key was
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
	const out = finalize(applyTags(renamed.html, edits.tagMap), applyComments(renamed.css, edits.comments));

	// Verify the polished artifact renders identically; a model can rename inconsistently or
	// swap a tag whose ua styles differ, so a non-neutral edit falls back to the safe output.
	if (!polishRenderNeutral(captured, html, css, out.html, out.css)) {
		const warning = 'llm polish reverted: an edit changed the render';
		return usage ? { html, css, warning, usage } : { html, css, warning };
	}
	return usage ? { ...out, usage } : out;
}

/**
 * The stylesheet with only its in-scope resting class rules kept, so the prompt hides the
 * interactive-state, pseudo-element, and at-rules the model must not touch. Parsed through
 * the browser so a data-uri brace can never mislead it; returns the input unchanged if it
 * will not parse.
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
 * Parses the model's reply into the polish edits. Lenient by design: a missing or malformed
 * reply, or a missing field, yields empty edits, a clean no-op, rather than throwing.
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
