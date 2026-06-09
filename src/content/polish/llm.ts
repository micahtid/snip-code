/**
 * polish/llm.ts — phase 5 orchestrator (byok llm polish)
 *
 * Phase: i (ai polish) — see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: 5 — polish
 * Reads from Captured: n/a (operates on the emitted html + css)
 * Writes to Captured: n/a (returns polished html + css)
 *
 * Principles applied: P5-aligned via restore.finalize (orphan prune).
 *
 * Why this exists: phase 5 is the optional, byok-gated finishing pass. it asks the
 * user's own llm (via the background broker) for two additive edits — semantic
 * class renames and hover/focus rules — then applies them locally. it never sends
 * a key (background reads it from storage) and never blocks: if no key is
 * configured, or the request fails, it returns the deterministic phases 1-4
 * output unchanged. token-heavy values are vaulted before the prompt so the model
 * cannot corrupt them and the token bill stays small. ported (rewritten) from
 * marketing-website openrouter.ts (request shape + response parsing only — none
 * of the original's account, credit-accounting, or backend-verification code).
 */
import type { Provider } from '../types';
import { VerbatimVault } from '../convert/vault';
import { buildPolishPrompt } from './prompts';
import { applyRenames } from './rename';
import { finalize } from './restore';

/** the background's parsed llm reply (section 19.2 LLM_REQUEST result). */
interface LlmReply {
	renameMap?: Record<string, string>;
	hoverRules?: string[];
}

/**
 * runs phase 5 if a key is configured; otherwise returns the input unchanged.
 *
 * @param html — phase-4 markup
 * @param css — phase-4 stylesheet
 * @param provider — the active byok provider
 * @param model — the model to use (resolved by the caller from prefs/defaults)
 * @returns polished html + css, or the input unchanged on skip/failure
 */
export async function polish(
	html: string,
	css: string,
	provider: Provider,
	model: string,
): Promise<{ html: string; css: string }> {
	// vault token-heavy values for the prompt only; the working html/css stay
	// un-vaulted (the model returns instructions, not rewritten code).
	const vault = new VerbatimVault();
	const vaulted = vault.protect(`<style>${css}</style>\n${html}`);
	const prompt = buildPolishPrompt(vaulted);

	const reply = await requestLlm(provider, model, prompt);
	if (!reply) return { html, css }; // no key, or request failed: skip phase 5.

	const renamed = applyRenames(html, css, reply.renameMap ?? {});
	return finalize(renamed.html, renamed.css, reply.hoverRules ?? [], vault);
}

/**
 * asks the background broker to call the provider and return the parsed reply.
 * content scripts are bound by the host page's csp and cannot reach provider
 * hosts directly, so the call is delegated (section 10 call path). returns null on
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
