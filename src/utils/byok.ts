/**
 * utils/byok.ts: bring-your-own-key provider config + validation.
 *
 * This is not part of the pipeline. It configures the polish phase.
 *
 * Why this exists: snipcode never ships a key and never proxies requests. This module holds
 * the four supported providers' default models and endpoints, and the "test key" validation.
 * Validation fetches the provider directly from the sidebar. The manifest CSP whitelists all
 * four hosts for extension pages, so no background round-trip is needed and the key never
 * leaves the user's machine. The actual llm polish runs in the background, because content
 * scripts are bound by the page's csp. See polish/llm.ts and background.js.
 */
import type { Provider } from '../content/types';

/** The default model per provider. User overrides in settings. */
export const DEFAULT_MODELS: Record<Provider, string> = {
	openrouter: 'google/gemini-2.5-flash',
	anthropic: 'claude-haiku-4-5-20251001',
	openai: 'gpt-5-mini',
	google: 'gemini-3.0-flash',
};

/** Human-readable provider labels for the settings dropdown. */
export const PROVIDER_LABELS: Record<Provider, string> = {
	openrouter: 'OpenRouter',
	anthropic: 'Anthropic',
	openai: 'OpenAI',
	google: 'Google',
};

/** The outcome of a "test key" request. */
export interface ValidationResult {
	valid: boolean;
	modelEcho?: string;
	error?: string;
}

/**
 * Validates a byok key against the live provider.
 *
 * Succeeds only when the response is http 200, the body parses as json, and it contains the
 * provider's success indicator. A minimal 1-token request keeps cost negligible.
 *
 * @param provider - which provider to test
 * @param key - the api key to validate, never logged
 * @param model - the model to test with, defaults to the provider default
 */
export async function validateKey(provider: Provider, key: string, model?: string): Promise<ValidationResult> {
	if (!key.trim()) return { valid: false, error: 'no key provided' };
	const m = model?.trim() || DEFAULT_MODELS[provider];
	const req = buildValidationRequest(provider, key, m);
	try {
		const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body) });
		if (res.status !== 200) return { valid: false, error: `http ${res.status}` };
		const json = (await res.json()) as unknown;
		return req.check(json) ? { valid: true, modelEcho: m } : { valid: false, error: 'unexpected response shape' };
	} catch (err) {
		return { valid: false, error: (err as Error).message };
	}
}

/** Request shape per provider for both validation and polish. The polish path is mirrored in background. */
interface ProviderRequest {
	url: string;
	headers: Record<string, string>;
	body: unknown;
	check: (json: unknown) => boolean;
}

/** Build the minimal validation request for a provider. */
function buildValidationRequest(provider: Provider, key: string, model: string): ProviderRequest {
	const json = 'application/json';
	switch (provider) {
		case 'openrouter':
			return {
				url: 'https://openrouter.ai/api/v1/chat/completions',
				headers: { Authorization: `Bearer ${key}`, 'Content-Type': json },
				body: { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 },
				check: (j) => hasPath(j, ['choices', 0, 'message']),
			};
		case 'anthropic':
			return {
				url: 'https://api.anthropic.com/v1/messages',
				headers: {
					'x-api-key': key,
					'anthropic-version': '2023-06-01',
					// Required for direct browser/extension-page calls, to satisfy cors.
					'anthropic-dangerous-direct-browser-access': 'true',
					'Content-Type': json,
				},
				body: { model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
				check: (j) => hasPath(j, ['content', 0, 'text']),
			};
		case 'openai':
			return {
				url: 'https://api.openai.com/v1/chat/completions',
				headers: { Authorization: `Bearer ${key}`, 'Content-Type': json },
				body: { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 },
				check: (j) => hasPath(j, ['choices', 0, 'message']),
			};
		case 'google':
			return {
				url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
				headers: { 'Content-Type': json },
				body: { contents: [{ parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 1 } },
				check: (j) => hasPath(j, ['candidates', 0, 'content']),
			};
	}
}

/** True when a nested path exists and is non-empty in a parsed json value. */
function hasPath(value: unknown, path: Array<string | number>): boolean {
	let cur: unknown = value;
	for (const key of path) {
		if (cur == null || typeof cur !== 'object') return false;
		cur = (cur as Record<string | number, unknown>)[key];
	}
	return cur != null && cur !== '';
}
