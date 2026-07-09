/**
 * utils/storage.ts: chrome.storage.local access.
 *
 * This is not part of the pipeline. It is a cross-cutting utility.
 *
 * Why this exists: all persistent state, such as preferences, byok keys, and snippets, lives
 * in chrome.storage.local and NEVER chrome.storage.sync. Sync would replicate to google's
 * cloud, violating the local-only guarantee. This is the single typed gateway to that store,
 * so the policy is enforced in one place. Byok keys are stored under per-provider keys and
 * are never logged.
 */
import type { Provider, SnippetRecord, UserPreferences } from '../content/types';

const PREFS_KEY = 'preferences';
const SNIPPETS_KEY = 'snippets';
const SNIPPET_CAP = 50; // Last 50, fifo.
const byokKey = (provider: Provider): string => `byok.${provider}`;

/** The default preferences, applied when nothing is stored yet. */
export const DEFAULT_PREFS: UserPreferences = {
	activeProvider: 'openrouter',
	modelOverrides: { openrouter: null, anthropic: null, openai: null, google: null },
	defaultMode: 'snip',
	defaultOutput: 'html',
	assistiveDelivery: ['clipboard'],
	webhookUrl: null,
};

/** Read user preferences, merged over defaults so new fields are always present. */
export async function getPrefs(): Promise<UserPreferences> {
	const stored = await chrome.storage.local.get(PREFS_KEY);
	return { ...DEFAULT_PREFS, ...(stored[PREFS_KEY] as Partial<UserPreferences> | undefined) };
}

/** Merge a partial preferences patch into storage. */
export async function setPrefs(patch: Partial<UserPreferences>): Promise<void> {
	const current = await getPrefs();
	await chrome.storage.local.set({ [PREFS_KEY]: { ...current, ...patch } });
}

/** Read a provider's byok key, or an empty string if unset. Never logged. */
export async function getKey(provider: Provider): Promise<string> {
	const stored = await chrome.storage.local.get(byokKey(provider));
	return (stored[byokKey(provider)] as string | undefined) ?? '';
}

/** Store a provider's byok key under chrome.storage.local, never sync. */
export async function setKey(provider: Provider, key: string): Promise<void> {
	await chrome.storage.local.set({ [byokKey(provider)]: key });
}

/** Read the saved snippets, oldest first. */
export async function listSnippets(): Promise<SnippetRecord[]> {
	const stored = await chrome.storage.local.get(SNIPPETS_KEY);
	return (stored[SNIPPETS_KEY] as SnippetRecord[] | undefined) ?? [];
}

/**
 * Append a snippet, evicting the oldest beyond the 50-cap in fifo order.
 *
 * @param record - the snippet to store
 */
export async function storeSnippet(record: SnippetRecord): Promise<void> {
	const current = await listSnippets();
	const next = [...current, record].slice(-SNIPPET_CAP); // Keep the newest 50
	await chrome.storage.local.set({ [SNIPPETS_KEY]: next });
}

/** Clear all saved snippets. */
export async function clearSnippets(): Promise<void> {
	await chrome.storage.local.set({ [SNIPPETS_KEY]: [] });
}
