/**
 * components/SettingsView.tsx: byok + preferences settings tab
 *
 * Pipeline position: n/a. Configures polish + assistive delivery.
 * Reads from Captured: n/a
 * Writes to Captured: n/a
 *
 * Principles applied: none. Ui only.
 *
 * Why this exists: the settings tab, provider dropdown, password-masked
 * api key, model override, per-field verify buttons, default output format,
 * assistive delivery, webhook url. Everything persists to chrome.storage.local via
 * utils/storage, never sync. The key is validated against the live provider
 * through utils/byok and never logged. If no key is configured, polish silently
 * no-ops and the rest of the pipeline still produces output.
 */
import { useEffect, useState } from 'react';
import { Check, ChevronDown, Eye, EyeOff, ShieldCheck } from 'lucide-react';
import type { OutputFormat, Provider, UserPreferences } from '../content/types';
import { DEFAULT_MODELS, PROVIDER_LABELS, validateKey, type ValidationResult } from '../utils/byok';
import { getKey, getPrefs, setKey, setPrefs } from '../utils/storage';
import { ViewLayout } from './ViewLayout';
import { COLORS } from '../theme';

const PROVIDERS: Provider[] = ['openrouter', 'anthropic', 'openai', 'google'];
// The html format emits self-contained markup with semantic bem classes and a
// stylesheet, produced by emitFormat, so a separate bem-css option would be a duplicate.
const FORMATS: OutputFormat[] = ['html', 'tailwind', 'bem-scss', 'jsx-tailwind', 'jsx-css', 'vue'];
const DELIVERY: Array<'clipboard' | 'file' | 'webhook'> = ['clipboard', 'file', 'webhook'];
/** Title-case labels for the assistive delivery options. */
const DELIVERY_LABELS: Record<'clipboard' | 'file' | 'webhook', string> = { clipboard: 'Clipboard', file: 'File', webhook: 'Webhook' };

const styles = {
	field: { marginBottom: '16px' } as React.CSSProperties,
	label: { display: 'block', fontWeight: 600, marginBottom: '6px', fontSize: '12px', color: COLORS.slate700 } as React.CSSProperties,
	/** An input paired with its verify button to the right. */
	inputRow: { display: 'flex', gap: '8px', alignItems: 'center' } as React.CSSProperties,
};

/**
 * A custom replacement for a native <select>. The options panel opens in the normal
 * document flow instead of as an overlay, so it pushes the fields below it down rather
 * than floating over them. A fixed, transparent backdrop closes it on an outside
 * click. Used here instead of the browser's select so the control matches the
 * frosted-glass ui and stays consistent across platforms.
 */
function Select({ value, options, onChange }: {
	value: string;
	options: ReadonlyArray<{ value: string; label: string }>;
	onChange: (value: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const current = options.find((o) => o.value === value);
	return (
		<div className="sc-select">
			<button
				type="button"
				className={`sc-select-trigger${open ? ' sc-select-trigger-open' : ''}`}
				aria-haspopup="listbox"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
			>
				<span>{current?.label ?? value}</span>
				<ChevronDown size={15} style={{ flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }} />
			</button>
			{open && (
				<>
					<div style={{ position: 'fixed', inset: 0, zIndex: 30 }} onClick={() => setOpen(false)} />
					<div className="sc-select-panel" role="listbox">
						{options.map((o) => (
							<button
								key={o.value}
								type="button"
								role="option"
								aria-selected={o.value === value}
								className={`sc-select-option${o.value === value ? ' sc-select-option-active' : ''}`}
								onClick={() => {
									onChange(o.value);
									setOpen(false);
								}}
							>
								<span>{o.label}</span>
								{o.value === value && <Check size={14} style={{ flexShrink: 0 }} />}
							</button>
						))}
					</div>
				</>
			)}
		</div>
	);
}

export function SettingsView() {
	const [prefs, setPrefsState] = useState<UserPreferences | null>(null);
	const [key, setKeyState] = useState('');
	const [result, setResult] = useState<ValidationResult | null>(null);
	const [testing, setTesting] = useState(false);
	// The key is masked by default; the in-field eye toggles it and only appears while
	// the field is active, meaning focused or holding a key, never on an untouched empty field.
	const [showKey, setShowKey] = useState(false);
	const [keyFocused, setKeyFocused] = useState(false);

	// Load prefs + the active provider's key on mount.
	useEffect(() => {
		void (async () => {
			const p = await getPrefs();
			setPrefsState(p);
			setKeyState(await getKey(p.activeProvider));
		})();
	}, []);

	if (!prefs) return <ViewLayout><div style={{ color: COLORS.slate500 }}>Loading…</div></ViewLayout>;

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
		<ViewLayout>
			<div style={styles.field}>
				<label style={styles.label}>Provider</label>
				<Select
					value={prefs.activeProvider}
					options={PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABELS[p] }))}
					onChange={(v) => onProvider(v as Provider)}
				/>
			</div>

			{/* Each field has its own verify button; both run the same key+model validation. */}
			<div style={styles.field}>
				<label style={styles.label}>API Key (Local)</label>
				<div style={styles.inputRow}>
					<div className="sc-key-field">
						<input
							className="sc-input"
							type={showKey ? 'text' : 'password'}
							value={key}
							placeholder="Paste key"
							onChange={(e) => setKeyState(e.target.value)}
							onFocus={() => setKeyFocused(true)}
							onBlur={() => {
								setKeyFocused(false);
								setShowKey(false); // Re-mask on leave so the key is never left exposed.
								void setKey(prefs.activeProvider, key);
							}}
							style={{ paddingRight: '38px' }}
						/>
						{(keyFocused || key.length > 0) && (
							<button
								type="button"
								className="sc-key-reveal"
								title={showKey ? 'Hide key' : 'Show key'}
								aria-label={showKey ? 'Hide key' : 'Show key'}
								// Keep focus in the input so the toggle stays visible through the click.
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => setShowKey((v) => !v)}
							>
								{showKey ? <EyeOff size={16} /> : <Eye size={16} />}
							</button>
						)}
					</div>
					<button className="sc-icon-action" type="button" title="Test Key" disabled={testing} onClick={() => void onTest()}>
						<ShieldCheck size={18} />
					</button>
				</div>
			</div>

			<div style={styles.field}>
				<label style={styles.label}>Model Override</label>
				<div style={styles.inputRow}>
					<input
						className="sc-input"
						type="text"
						value={prefs.modelOverrides[prefs.activeProvider] ?? ''}
						placeholder={DEFAULT_MODELS[prefs.activeProvider]}
						onChange={(e) =>
							update({ modelOverrides: { ...prefs.modelOverrides, [prefs.activeProvider]: e.target.value || null } })
						}
						style={{ flex: 1, minWidth: 0 }}
					/>
					<button className="sc-icon-action" type="button" title="Test Model" disabled={testing} onClick={() => void onTest()}>
						<ShieldCheck size={18} />
					</button>
				</div>
				{(testing || result) && (
					<div style={{ marginTop: '8px', fontSize: '12px', color: testing ? COLORS.slate500 : result?.valid ? COLORS.success : COLORS.danger }}>
						{testing ? 'Testing…' : result?.valid ? `Valid (${result.modelEcho})` : `Invalid: ${result?.error}`}
					</div>
				)}
			</div>

			<div style={styles.field}>
				<label style={styles.label}>Default Output Format</label>
				<Select
					value={prefs.defaultOutput}
					options={FORMATS.map((f) => ({ value: f, label: f.toUpperCase() }))}
					onChange={(v) => update({ defaultOutput: v as OutputFormat })}
				/>
			</div>

			<div style={styles.field}>
				<label style={styles.label}>Assistive Delivery</label>
				{DELIVERY.map((d) => {
					const on = prefs.assistiveDelivery.includes(d);
					return (
						<button key={d} type="button" role="checkbox" aria-checked={on} className="sc-check-row" onClick={() => toggleDelivery(d)}>
							<span className={`sc-check-box${on ? ' sc-check-box-on' : ''}`}>{on && <Check size={12} strokeWidth={3} />}</span>
							{DELIVERY_LABELS[d]}
						</button>
					);
				})}
			</div>

			{prefs.assistiveDelivery.includes('webhook') && (
				<div style={styles.field}>
					<label style={styles.label}>Webhook URL</label>
					<input
						className="sc-input"
						type="url"
						value={prefs.webhookUrl ?? ''}
						placeholder="https://…"
						onChange={(e) => update({ webhookUrl: e.target.value || null })}
					/>
				</div>
			)}
		</ViewLayout>
	);
}
