/**
 * utils/storage.ts — chrome.storage.local access
 *
 * Phase: i (byok) — see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: n/a (cross-cutting utility)
 *
 * Why this exists: all persistent state (preferences, byok keys, snippets) lives
 * in chrome.storage.local and NEVER chrome.storage.sync — sync would replicate to
 * google's cloud, violating the local-only guarantee (decision 3, forbidden #8).
 * this is the single typed gateway to that store so the policy is enforced in one
 * place. byok keys are stored under per-provider keys and are never logged.
 */
import type { Provider, UserPreferences } from '../content/types';

const PREFS_KEY = 'preferences';
const byokKey = (provider: Provider): string => `byok.${provider}`;

/** the default preferences, applied when nothing is stored yet (decisions 9-11). */
export const DEFAULT_PREFS: UserPreferences = {
	activeProvider: 'openrouter',
	modelOverrides: { openrouter: null, anthropic: null, openai: null, google: null },
	defaultMode: 'snip',
	defaultOutput: 'html',
	assistiveDelivery: ['clipboard'],
	webhookUrl: null,
};

/** read user preferences, merged over defaults so new fields are always present. */
export async function getPrefs(): Promise<UserPreferences> {
	const stored = await chrome.storage.local.get(PREFS_KEY);
	return { ...DEFAULT_PREFS, ...(stored[PREFS_KEY] as Partial<UserPreferences> | undefined) };
}

/** merge a partial preferences patch into storage. */
export async function setPrefs(patch: Partial<UserPreferences>): Promise<void> {
	const current = await getPrefs();
	await chrome.storage.local.set({ [PREFS_KEY]: { ...current, ...patch } });
}

/** read a provider's byok key (empty string if unset). never logged. */
export async function getKey(provider: Provider): Promise<string> {
	const stored = await chrome.storage.local.get(byokKey(provider));
	return (stored[byokKey(provider)] as string | undefined) ?? '';
}

/** store a provider's byok key under chrome.storage.local (never sync). */
export async function setKey(provider: Provider, key: string): Promise<void> {
	await chrome.storage.local.set({ [byokKey(provider)]: key });
}
