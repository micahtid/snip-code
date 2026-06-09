/**
 * components/SettingsView.tsx — byok + preferences settings tab
 *
 * Phase: i (byok) — see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: n/a (configures pipeline phase 5 + assistive delivery)
 * Reads from Captured: n/a
 * Writes to Captured: n/a
 *
 * Principles applied: none (ui).
 *
 * Why this exists: section 10's settings tab — provider dropdown, password-masked
 * api key, model override, test-key button, default output format, assistive
 * delivery, webhook url. everything persists to chrome.storage.local via
 * utils/storage (never sync). the key is validated against the live provider
 * (utils/byok) and never logged. if no key is configured, phase 5 silently
 * no-ops and phases 1-4 still produce output.
 */
import { useEffect, useState } from 'react';
import type { OutputFormat, Provider, UserPreferences } from '../content/types';
import { DEFAULT_MODELS, PROVIDER_LABELS, validateKey, type ValidationResult } from '../utils/byok';
import { getKey, getPrefs, setKey, setPrefs } from '../utils/storage';

const PROVIDERS: Provider[] = ['openrouter', 'anthropic', 'openai', 'google'];
const FORMATS: OutputFormat[] = ['html', 'tailwind', 'bem-css', 'bem-scss', 'jsx-tailwind', 'jsx-css', 'vue'];
const DELIVERY: Array<'clipboard' | 'file' | 'webhook'> = ['clipboard', 'file', 'webhook'];

const s = {
	field: { marginBottom: '14px' } as React.CSSProperties,
	label: { display: 'block', fontWeight: 600, marginBottom: '4px', fontSize: '12px' } as React.CSSProperties,
	input: { width: '100%', padding: '6px 8px', border: '1px solid #ddd', borderRadius: '6px', boxSizing: 'border-box' } as React.CSSProperties,
	row: { display: 'flex', gap: '6px', alignItems: 'center' } as React.CSSProperties,
	btn: { padding: '6px 10px', border: 'none', borderRadius: '6px', background: '#4f6ef6', color: '#fff', cursor: 'pointer' } as React.CSSProperties,
};

export function SettingsView() {
	const [prefs, setPrefsState] = useState<UserPreferences | null>(null);
	const [key, setKeyState] = useState('');
	const [result, setResult] = useState<ValidationResult | null>(null);
	const [testing, setTesting] = useState(false);

	// load prefs + the active provider's key on mount.
	useEffect(() => {
		void (async () => {
			const p = await getPrefs();
			setPrefsState(p);
			setKeyState(await getKey(p.activeProvider));
		})();
	}, []);

	if (!prefs) return <div style={{ color: '#999' }}>loading…</div>;

	/** persist a preferences patch and update local state. */
	const update = (patch: Partial<UserPreferences>): void => {
		const next = { ...prefs, ...patch };
		setPrefsState(next);
		void setPrefs(patch);
	};

	/** switch provider: persist and load that provider's stored key. */
	const onProvider = (provider: Provider): void => {
		update({ activeProvider: provider });
		setResult(null);
		void getKey(provider).then(setKeyState);
	};

	/** validate the entered key against the live provider. */
	const onTest = async (): Promise<void> => {
		setTesting(true);
		setResult(null);
		await setKey(prefs.activeProvider, key); // persist before testing
		const r = await validateKey(prefs.activeProvider, key, prefs.modelOverrides[prefs.activeProvider] ?? undefined);
		setResult(r);
		setTesting(false);
	};

	const toggleDelivery = (d: 'clipboard' | 'file' | 'webhook'): void => {
		const has = prefs.assistiveDelivery.includes(d);
		update({ assistiveDelivery: has ? prefs.assistiveDelivery.filter((x) => x !== d) : [...prefs.assistiveDelivery, d] });
	};

	return (
		<div>
			<div style={s.field}>
				<label style={s.label}>provider</label>
				<select style={s.input} value={prefs.activeProvider} onChange={(e) => onProvider(e.target.value as Provider)}>
					{PROVIDERS.map((p) => (
						<option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
					))}
				</select>
			</div>

			<div style={s.field}>
				<label style={s.label}>api key (stored locally only)</label>
				<input
					style={s.input}
					type="password"
					value={key}
					placeholder="paste key"
					onChange={(e) => setKeyState(e.target.value)}
					onBlur={() => void setKey(prefs.activeProvider, key)}
				/>
			</div>

			<div style={s.field}>
				<label style={s.label}>model override</label>
				<input
					style={s.input}
					type="text"
					value={prefs.modelOverrides[prefs.activeProvider] ?? ''}
					placeholder={DEFAULT_MODELS[prefs.activeProvider]}
					onChange={(e) =>
						update({ modelOverrides: { ...prefs.modelOverrides, [prefs.activeProvider]: e.target.value || null } })
					}
				/>
			</div>

			<div style={s.field}>
				<div style={s.row}>
					<button style={s.btn} disabled={testing} onClick={() => void onTest()}>
						{testing ? 'testing…' : 'test key'}
					</button>
					{result && (
						<span style={{ color: result.valid ? '#2e7d32' : '#c62828', fontSize: '12px' }}>
							{result.valid ? `valid (${result.modelEcho})` : `invalid: ${result.error}`}
						</span>
					)}
				</div>
			</div>

			<div style={s.field}>
				<label style={s.label}>default output format</label>
				<select style={s.input} value={prefs.defaultOutput} onChange={(e) => update({ defaultOutput: e.target.value as OutputFormat })}>
					{FORMATS.map((f) => (
						<option key={f} value={f}>{f}</option>
					))}
				</select>
			</div>

			<div style={s.field}>
				<label style={s.label}>assistive delivery</label>
				{DELIVERY.map((d) => (
					<label key={d} style={{ display: 'block', fontSize: '12px' }}>
						<input
							type="checkbox"
							checked={prefs.assistiveDelivery.includes(d)}
							onChange={() => toggleDelivery(d)}
						/>{' '}
						{d}
					</label>
				))}
			</div>

			{prefs.assistiveDelivery.includes('webhook') && (
				<div style={s.field}>
					<label style={s.label}>webhook url</label>
					<input
						style={s.input}
						type="url"
						value={prefs.webhookUrl ?? ''}
						placeholder="https://…"
						onChange={(e) => update({ webhookUrl: e.target.value || null })}
					/>
				</div>
			)}
		</div>
	);
}
