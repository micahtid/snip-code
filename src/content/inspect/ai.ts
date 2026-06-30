/**
 * inspect/ai.ts: the optional byok ai pass for colors and style json
 *
 * Pipeline position: inspect (page-scoped; the optional byok finishing pass)
 * Reads from DOM: nothing (operates on the already-extracted reports)
 * Writes to: nothing (returns enhanced reports)
 *
 * Principles applied: none (orchestration).
 *
 * Why this exists: two inspectors gain an optional ai pass. Colors asks the user's
 * own llm to assign a semantic role to each extracted color; style json asks it to
 * synthesize the raw page schema into a design-system json. This mirrors
 * polish/llm.ts exactly: build a prompt, delegate to the background broker (content
 * scripts cannot reach provider hosts under the page csp), parse the reply, and
 * forward the provider's token usage. A missing key is a silent no-op that returns
 * the raw input unchanged; a configured-key failure returns the raw input plus a
 * warning so the panel can say why no roles/synthesis landed. There is no
 * double-ship and no state machine, the same shape polish already proved.
 */
import type { Provider, TokenUsage } from '../types';
import type { ColorReport } from './types';
import { buildColorsPrompt, buildSchemaPrompt } from './prompts';

/** The error code the broker returns when no key is stored for the provider. */
const NO_KEY = 'NO_KEY_CONFIGURED';

/** Output-token ceiling for schema synthesis (the broker clamps it per provider). */
const SCHEMA_MAX_TOKENS = 8000;

/** A color inspector result after the optional role-assignment pass. */
export interface EnhancedColors {
	colors: ColorReport[];
	aiEnhanced: boolean;
	usage?: TokenUsage;
	warning?: string;
}

/** A style-json result after the optional synthesis pass. */
export interface EnhancedSchema {
	json: string;
	aiEnhanced: boolean;
	usage?: TokenUsage;
	warning?: string;
}

/**
 * Assigns a semantic role to each color via the byok llm, merging the roles onto
 * the raw extraction. Returns the colors unchanged when no key is configured.
 *
 * @param colors - the raw extracted colors (most-used first)
 * @param cssVariables - color-valued css custom properties, the designer's named tokens
 * @param provider - the active byok provider
 * @param model - the model to use (resolved by the caller)
 */
export async function enhanceColors(
	colors: ColorReport[],
	cssVariables: Record<string, string>,
	provider: Provider,
	model: string,
): Promise<EnhancedColors> {
	if (colors.length === 0) return { colors, aiEnhanced: false };

	const colorData = JSON.stringify({ colors: colors.map((c) => ({ hex: c.hex, count: c.count })), cssVariables });
	const { text, error, usage } = await requestLlm(provider, model, buildColorsPrompt(colorData));
	if (text === null) {
		const warning = skipReason(error);
		return withMeta({ colors, aiEnhanced: false }, warning, usage);
	}

	const roles = parseColorRoles(text);
	const enhanced = colors.map((c) => {
		const role = roles.get(c.hex.toLowerCase());
		return role ? { ...c, role } : c;
	});
	return withMeta({ colors: enhanced, aiEnhanced: true }, undefined, usage);
}

/**
 * Synthesizes the raw page schema into a design-system json via the byok llm.
 * Returns the raw schema json unchanged when no key is configured, or when the
 * reply is not parseable json (it degrades to the raw input with a warning).
 *
 * @param schemaJson - the optimized page schema, serialized as json
 * @param provider - the active byok provider
 * @param model - the model to use (resolved by the caller)
 */
export async function enhanceSchema(schemaJson: string, provider: Provider, model: string): Promise<EnhancedSchema> {
	const { text, error, usage } = await requestLlm(provider, model, buildSchemaPrompt(schemaJson), SCHEMA_MAX_TOKENS);
	if (text === null) {
		const warning = skipReason(error);
		return withMeta({ json: schemaJson, aiEnhanced: false }, warning, usage);
	}

	const synthesized = firstJsonObject(text);
	if (synthesized === null) {
		return withMeta({ json: schemaJson, aiEnhanced: false }, 'schema ai reply was not valid json', usage);
	}
	return withMeta({ json: JSON.stringify(synthesized, null, 2), aiEnhanced: true }, undefined, usage);
}

/**
 * Asks the background broker to call the provider and return its raw reply text.
 * Identical in spirit to polish's requestLlm: on any failure the text is null and
 * the broker's error message and any billed usage come back alongside it.
 */
async function requestLlm(
	provider: Provider,
	model: string,
	prompt: string,
	max?: number,
): Promise<{ text: string | null; error?: string; usage?: TokenUsage }> {
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

/** A configured-key failure is worth a warning; a missing key is an intended silent skip. */
function skipReason(error?: string): string | undefined {
	if (error && error !== NO_KEY) {
		console.warn('snipcode: inspect ai skipped', error);
		return `inspect ai skipped: ${error}`;
	}
	return undefined;
}

/** Attaches the optional warning and usage to a result without writing undefined keys. */
function withMeta<T>(base: T, warning: string | undefined, usage: TokenUsage | undefined): T & { warning?: string; usage?: TokenUsage } {
	return { ...base, ...(warning ? { warning } : {}), ...(usage ? { usage } : {}) };
}

/** Parses the colors reply ({ colors: [{ hex, role }] }) into a hex -> role map. */
function parseColorRoles(text: string): Map<string, string> {
	const roles = new Map<string, string>();
	const parsed = firstJsonObject(text) as { colors?: Array<{ hex?: unknown; role?: unknown }> } | null;
	for (const entry of parsed?.colors ?? []) {
		if (typeof entry.hex === 'string' && typeof entry.role === 'string') {
			roles.set(entry.hex.toLowerCase(), entry.role);
		}
	}
	return roles;
}

/** The first json object in the reply: a direct parse, a fenced block, or a brace match. */
function firstJsonObject(text: string): unknown | null {
	const candidates = [text];
	const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (fence?.[1]) candidates.push(fence[1]);
	const brace = text.match(/\{[\s\S]*\}/);
	if (brace) candidates.push(brace[0]);
	for (const candidate of candidates) {
		try {
			return JSON.parse(candidate);
		} catch {
			// Try the next candidate.
		}
	}
	return null;
}
