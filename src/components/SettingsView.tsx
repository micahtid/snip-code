/**
 * components/SettingsView.tsx: byok + preferences settings tab
 *
 * Pipeline position: n/a (configures polish + assistive delivery)
 * Reads from Captured: n/a
 * Writes to Captured: n/a
 *
 * Principles applied: none (ui).
 *
 * Why this exists: the settings tab, provider dropdown, password-masked
 * api key, model override, test-key button, default output format, assistive
 * delivery, webhook url. Everything persists to chrome.storage.local via
 * utils/storage (never sync). The key is validated against the live provider
 * (utils/byok) and never logged. If no key is configured, polish silently
 * no-ops and the rest of the pipeline still produces output.
 */
import { useEffect, useState } from 'react';
import type { OutputFormat, Provider, UserPreferences } from '../content/types';
import { DEFAULT_MODELS, PROVIDER_LABELS, validateKey, type ValidationResult } from '../utils/byok';
import { getKey, getPrefs, setKey, setPrefs } from '../utils/storage';
import { COLORS, FONT_UI } from '../theme';

const PROVIDERS: Provider[] = ['openrouter', 'anthropic', 'openai', 'google'];
// The html format emits self-contained markup with semantic bem classes and a
// stylesheet (see emitFormat), so a separate bem-css option would be a duplicate.
const FORMATS: OutputFormat[] = ['html', 'tailwind', 'bem-scss', 'jsx-tailwind', 'jsx-css', 'vue'];
const DELIVERY: Array<'clipboard' | 'file' | 'webhook'> = ['clipboard', 'file', 'webhook'];

const s = {
	field: { marginBottom: '16px' } as React.CSSProperties,
	label: { display: 'block', fontWeight: 600, marginBottom: '6px', fontSize: '12px', color: COLORS.slate700 } as React.CSSProperties,
	row: { display: 'flex', gap: '10px', alignItems: 'center' } as React.CSSProperties,
	check: { display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12px', color: COLORS.slate700, marginBottom: '4px' } as React.CSSProperties,
};

export function SettingsView() {
	const [prefs, setPrefsState] = useState<UserPreferences | null>(null);
	const [key, setKeyState] = useState('');
	const [result, setResult] = useState<ValidationResult | null>(null);
	const [testing, setTesting] = useState(false);

	// Load prefs + the active provider's key on mount.
	useEffect(() => {
		void (async () => {
			const p = await getPrefs();
			setPrefsState(p);
			setKeyState(await getKey(p.activeProvider));
		})();
	}, []);

	if (!prefs) return <div style={{ color: COLORS.slate500 }}>Loading…</div>;

	/** Persist a preferences patch and update local state. */
	const update = (patch: Partial<UserPreferences>): void => {
		const next = { ...prefs, ...patch };
		setPrefsState(next);
		void setPrefs(patch);
	};

	/** Switch provider: persist and load that provider's stored key. */
	const onProvider = (provider: Provider): void => {
		update({ activeProvider: provider });
		setResult(null);
		void getKey(provider).then(setKeyState);
	};

	/** Validate the entered key against the live provider. */
	const onTest = async (): Promise<void> => {
		setTesting(true);
		setResult(null);
		await setKey(prefs.activeProvider, key); // Persist before testing
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
				<label style={s.label}>Provider</label>
				<select className="sc-input" value={prefs.activeProvider} onChange={(e) => onProvider(e.target.value as Provider)}>
					{PROVIDERS.map((p) => (
						<option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
					))}
				</select>
			</div>

			<div style={s.field}>
				<label style={s.label}>API key (stored locally only)</label>
				<input
					className="sc-input"
					type="password"
					value={key}
					placeholder="Paste key"
					onChange={(e) => setKeyState(e.target.value)}
					onBlur={() => void setKey(prefs.activeProvider, key)}
				/>
			</div>

			<div style={s.field}>
				<label style={s.label}>Model override</label>
				<input
					className="sc-input"
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
					<button className="sc-btn sc-btn-secondary sc-btn-sm" style={{ fontFamily: FONT_UI }} disabled={testing} onClick={() => void onTest()}>
						{testing ? 'Testing…' : 'Test Key'}
					</button>
					{result && (
						<span style={{ color: result.valid ? '#2e7d32' : '#c62828', fontSize: '12px' }}>
							{result.valid ? `Valid (${result.modelEcho})` : `Invalid: ${result.error}`}
						</span>
					)}
				</div>
			</div>

			<div style={s.field}>
				<label style={s.label}>Default output format</label>
				<select className="sc-input" value={prefs.defaultOutput} onChange={(e) => update({ defaultOutput: e.target.value as OutputFormat })}>
					{FORMATS.map((f) => (
						<option key={f} value={f}>{f}</option>
					))}
				</select>
			</div>

			<div style={s.field}>
				<label style={s.label}>Assistive delivery</label>
				{DELIVERY.map((d) => (
					<label key={d} style={s.check}>
						<input
							type="checkbox"
							checked={prefs.assistiveDelivery.includes(d)}
							onChange={() => toggleDelivery(d)}
						/>
						{d}
					</label>
				))}
			</div>

			{prefs.assistiveDelivery.includes('webhook') && (
				<div style={s.field}>
					<label style={s.label}>Webhook URL</label>
					<input
						className="sc-input"
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
