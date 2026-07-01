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
import type { Provider, TokenUsage } from '../types';
import { requestLlm, NO_KEY } from '../llm';
import { VerbatimVault } from '../convert/vault';
import { buildPolishPrompt } from './prompts';
import { applyRenames } from './rename';
import { finalize } from './restore';

/** The polish edits parsed out of the model's reply text. */
interface PolishEdits {
	renameMap: Record<string, string>;
	hoverRules: string[];
}

/**
 * Runs the polish phase if a key is configured; otherwise returns the input unchanged.
 *
 * Polish is best-effort: a missing key is an intentional, silent skip, but a
 * configured-key failure, such as a provider error or empty/non-json reply, returns a
 * `warning` so the orchestrator can surface why the phase produced no edits
 * instead of failing invisibly.
 *
 * @param html - markup from the earlier phases
 * @param css - stylesheet from the earlier phases
 * @param provider - the active byok provider
 * @param model - the model to use, resolved by the caller from prefs/defaults
 * @returns polished html + css, the provider-reported token usage when an edit ran,
 *   plus a warning when a configured key was present but the request failed
 */
export async function polish(
	html: string,
	css: string,
	provider: Provider,
	model: string,
): Promise<{ html: string; css: string; warning?: string; usage?: TokenUsage }> {
	// Vault token-heavy values for the prompt only; the working html/css stay
	// un-vaulted, since the model returns instructions, not rewritten code.
	const vault = new VerbatimVault();
	const vaulted = vault.protect(`<style>${css}</style>\n${html}`);
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
	const out = finalize(renamed.html, renamed.css, edits.hoverRules, vault);
	return usage ? { ...out, usage } : out;
}

/**
 * Parses the model's reply into the two additive polish edits. Lenient by design:
 * a missing or malformed reply yields empty edits, a clean no-op, rather than
 * throwing. Moved here from the background broker so polish owns its own shape.
 */
function parseReply(text: string): PolishEdits {
	const match = text.match(/\{[\s\S]*\}/);
	if (!match) return { renameMap: {}, hoverRules: [] };
	try {
		const parsed = JSON.parse(match[0]) as { renameMap?: unknown; hoverRules?: unknown };
		return {
			renameMap: parsed.renameMap && typeof parsed.renameMap === 'object' ? (parsed.renameMap as Record<string, string>) : {},
			hoverRules: Array.isArray(parsed.hoverRules) ? (parsed.hoverRules as string[]) : [],
		};
	} catch {
		return { renameMap: {}, hoverRules: [] };
	}
}
