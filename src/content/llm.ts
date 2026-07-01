/**
 * content/llm.ts: the shared client for the background byok llm broker
 *
 * Pipeline position: n/a; cross-cutting, used by the polish phase and the inspect ai pass
 * Reads from Captured: n/a
 * Writes to Captured: n/a
 *
 * Why this exists: content scripts are bound by the host page's csp and cannot reach
 * provider hosts, so every byok llm call is delegated to the background worker over an
 * LLM_REQUEST message. Both the polish phase and the inspect ai pass send that exact
 * request and read back the same { text, usage }, or an error. This is that one
 * transport; each caller parses the reply into its own shape and decides skip-vs-warn.
 */
import type { Provider, TokenUsage } from './types';

/** The error code the broker returns when no key is stored for the provider. */
export const NO_KEY = 'NO_KEY_CONFIGURED';

/** The broker reply: text is null on any failure, with the error message and any billed usage alongside. */
export interface LlmReply {
	text: string | null;
	error?: string;
	usage?: TokenUsage;
}

/**
 * Asks the background broker to call the provider and return its raw reply text.
 * On any failure such as no key, network, provider, or empty/non-json, the text is null and the
 * broker's error message is returned alongside it, so the caller can both skip cleanly
 * and report the cause. A failed-but-billed reply also returns its token usage so the
 * spent tokens still count toward the session total.
 *
 * @param max - optional output-token ceiling; the schema pass raises it, polish omits it
 */
export async function requestLlm(provider: Provider, model: string, prompt: string, max?: number): Promise<LlmReply> {
	try {
		const res = (await chrome.runtime.sendMessage({
			type: 'LLM_REQUEST',
			requestId: crypto.randomUUID(),
			payload: { provider, model, prompt, max },
		})) as { ok: boolean; result?: { text?: string; usage?: TokenUsage }; error?: { message?: string }; usage?: TokenUsage } | undefined;
		if (res?.ok && res.result) {
			const text = res.result.text ?? '';
			return res.result.usage ? { text, usage: res.result.usage } : { text };
		}
		const error = res?.error?.message ?? 'no response from background broker';
		return res?.usage ? { text: null, error, usage: res.usage } : { text: null, error };
	} catch (err) {
		return { text: null, error: (err as Error).message };
	}
}
