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
const SNIPPET_CAP = 50; // Last 50 unsaved, fifo. Saved records are exempt.
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
 * Append a snippet, evicting the oldest unsaved records beyond the 50-cap in fifo order.
 *
 * @param record - the snippet to store
 */
export async function storeSnippet(record: SnippetRecord): Promise<void> {
	const current = await listSnippets();
	await chrome.storage.local.set({ [SNIPPETS_KEY]: evict([...current, record]) });
}

/**
 * Drop the oldest unsaved records once the unsaved count passes the cap. Saved records
 * never evict, so the cap counts history only, and the surviving records keep their
 * original chronological order so the single stored list stays the one source both
 * panel sections render from.
 *
 * @param records - the full stored list, oldest first
 * @returns the list with the overflowing unsaved records removed
 */
function evict(records: SnippetRecord[]): SnippetRecord[] {
	const unsaved = records.filter((r) => !r.saved);
	const excess = unsaved.length - SNIPPET_CAP;
	if (excess <= 0) return records;
	const dropped = new Set(unsaved.slice(0, excess).map((r) => r.id));
	return records.filter((r) => !dropped.has(r.id));
}

/** Clear the history, keeping every saved snippet. Clear is scoped to history only. */
export async function clearSnippets(): Promise<void> {
	const current = await listSnippets();
	await chrome.storage.local.set({ [SNIPPETS_KEY]: current.filter((r) => r.saved) });
}

/**
 * Flag or unflag one stored snippet as saved. Unknown ids are a no-op, since the record
 * may have already been evicted. Unsaving makes the record evictable again, so the cap is
 * re-applied on the way out.
 *
 * @param id - the stored snippet id
 * @param saved - true to save it, false to return it to history
 */
export async function setSnippetSaved(id: string, saved: boolean): Promise<void> {
	const current = await listSnippets();
	const next = current.map((r) => (r.id === id ? { ...r, saved } : r));
	await chrome.storage.local.set({ [SNIPPETS_KEY]: evict(next) });
}
