/**
 * polish/llm.ts: polish-phase orchestrator (byok llm polish)
 *
 * Pipeline position: polish
 * Reads from Captured: n/a (operates on the emitted html + css)
 * Writes to Captured: n/a (returns polished html + css)
 *
 * The orphan prune in restore.finalize removes only dead code.
 *
 * Why this exists: the polish phase is the optional, byok-gated finishing pass. It asks the
 * user's own llm (via the background broker) for two additive edits, semantic
 * class renames and hover/focus rules, then applies them locally. It never sends
 * a key (background reads it from storage) and never blocks: if no key is
 * configured, or the request fails, it returns the deterministic output of the
 * earlier phases unchanged. Token-heavy values are vaulted before the prompt so the model
 * cannot corrupt them and the token bill stays small. Ported (rewritten) from
 * marketing-website openrouter.ts (request shape + response parsing only, none
 * of the original's account, credit-accounting, or backend-verification code).
 */
import type { Provider } from '../types';
import { VerbatimVault } from '../convert/vault';
import { buildPolishPrompt } from './prompts';
import { applyRenames } from './rename';
import { finalize } from './restore';

/** The background's parsed llm reply. */
interface LlmReply {
	renameMap?: Record<string, string>;
	hoverRules?: string[];
}

/**
 * Runs the polish phase if a key is configured; otherwise returns the input unchanged.
 *
 * @param html - markup from the earlier phases
 * @param css - stylesheet from the earlier phases
 * @param provider - the active byok provider
 * @param model - the model to use (resolved by the caller from prefs/defaults)
 * @returns polished html + css, or the input unchanged on skip/failure
 */
export async function polish(
	html: string,
	css: string,
	provider: Provider,
	model: string,
): Promise<{ html: string; css: string }> {
	// Vault token-heavy values for the prompt only; the working html/css stay
	// un-vaulted (the model returns instructions, not rewritten code).
	const vault = new VerbatimVault();
	const vaulted = vault.protect(`<style>${css}</style>\n${html}`);
	const prompt = buildPolishPrompt(vaulted);

	const reply = await requestLlm(provider, model, prompt);
	if (!reply) return { html, css }; // No key, or request failed: skip the polish phase.

	const renamed = applyRenames(html, css, reply.renameMap ?? {});
	return finalize(renamed.html, renamed.css, reply.hoverRules ?? [], vault);
}

/**
 * Asks the background broker to call the provider and return the parsed reply.
 * Content scripts are bound by the host page's csp and cannot reach provider
 * hosts directly, so the call is delegated. Returns null on
 * any failure (no key, network, parse) so the caller can skip cleanly.
 */
async function requestLlm(provider: Provider, model: string, prompt: string): Promise<LlmReply | null> {
	try {
		const res = (await chrome.runtime.sendMessage({
			type: 'LLM_REQUEST',
			requestId: crypto.randomUUID(),
			payload: { provider, model, prompt },
		})) as { ok: boolean; result?: LlmReply } | undefined;
		return res?.ok && res.result ? res.result : null;
	} catch {
		return null;
	}
}
