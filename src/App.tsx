/**
 * App.tsx: side-panel root + sidebar shell
 *
 * Pipeline position: n/a. Ui host, not a pipeline phase.
 * Reads from Captured: n/a
 * Writes to Captured: n/a
 *
 * Principles applied: none. Ui only.
 *
 * Why this exists: chrome opens this document in the side panel. It is the only
 * react root in the extension. It owns top-level navigation between the three
 * sidebar views: capture, history, and settings. It hosts the picker control and
 * is the panel-side terminus of the content-script signals:
 * - It listens for SNIP_RESULT, renders the emitted code in ResultPanel, and adds
 *   that snip's polish token usage to a running per-session total.
 * - It listens for INSPECT_RESULT, a page scan, and renders it in InspectPanel; a
 *   snip and a scan are mutually exclusive, so each clears the other, and both add
 *   any byok token usage to the same per-session total.
 * - While a pick is in flight it owns the "picking" state and a window-level esc
 * handler that cancels the overlay even when keyboard focus is in the panel.
 * The picker's own esc handler only fires when the page holds focus.
 * It injects the global stylesheet once and paints the cloud backdrop behind a
 * frosted-glass shell, reproducing v1's look via theme.ts and global-css.ts.
 *
 * This module self-mounts at the bottom of the file so the build needs no separate
 * main.tsx entry, which keeps the repo tree tidy.
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { History, Settings } from 'lucide-react';
import { Picker, type Mode } from './components/Picker';
import { ScissorsMark } from './components/ScissorsMark';
import { ResultPanel, type SnipResult } from './components/ResultPanel';
import { InspectPanel } from './components/inspect/InspectPanel';
import { SnippetList } from './components/SnippetList';
import { SettingsView } from './components/SettingsView';
import { CloudBackdrop } from './components/CloudBackdrop';
import { ViewLayout } from './components/ViewLayout';
import { INSPECT_RESULT, CANCEL_PICKER, PICKER_SELECTED, SNIP_RESULT } from './content/types';
import type { TokenUsage } from './content/types';
import type { InspectResult } from './content/inspect/types';
import { injectGlobalCss } from './global-css';
import { COLORS, FONT_UI, SURFACE } from './theme';

/** The three top-level sidebar views the nav switches between. */
type View = 'capture' | 'history' | 'settings';

/** A page scan ships its InspectResult with the same optional token usage a snip carries. */
type InspectPayload = InspectResult & { usage?: TokenUsage };

const styles = {
	shell: {
		position: 'relative',
		zIndex: 1,
		display: 'flex',
		flexDirection: 'column',
		height: '100vh',
		margin: 0,
		fontFamily: FONT_UI,
		fontSize: '13px',
		color: COLORS.slate800,
		background: SURFACE.glass,
		backdropFilter: 'blur(20px)',
		WebkitBackdropFilter: 'blur(20px)',
	},
	nav: { display: 'flex', gap: '6px', padding: '10px', borderBottom: `1px solid ${SURFACE.border}` },
	main: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
	tokens: { marginTop: '8px', fontSize: '11px', fontWeight: 500, color: COLORS.slate500 },
} satisfies Record<string, unknown>;

/** The three sidebar views, each with the icon and hover-tooltip label its nav button shows. */
const NAV: ReadonlyArray<{ id: View; label: string; Icon: React.ComponentType<{ size?: number | string }> }> = [
	{ id: 'capture', label: 'Capture', Icon: ScissorsMark },
	{ id: 'history', label: 'History', Icon: History },
	{ id: 'settings', label: 'Settings', Icon: Settings },
];

/** Sends the cancel-picker signal to the active tab's content script. */
async function cancelPicker(): Promise<void> {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!tab?.id) return;
	try {
		await chrome.tabs.sendMessage(tab.id, { type: CANCEL_PICKER });
	} catch {
		// The overlay may already be gone: the page navigated or the tab closed. Harmless.
	}
}

/**
 * The sidebar shell: the icon nav and the active view, which fills the rest of the
 * panel as a scrollable body with a footer pinned to the bottom. The chrome side
 * panel supplies the only title bar, so there is no app header of our own.
 *
 * Holds the cross-view ui state: current view, capture mode, in-flight pick, and
 * the latest snip result. Also wires the content-script signals described in
 * the file header.
 */
function App() {
	const [view, setView] = useState<View>('capture');
	const [mode, setMode] = useState<Mode>('snip');
	const [picking, setPicking] = useState(false);
	// True once an element is picked and the pipeline is running, the phase of a pick where
	// cancelling no longer applies, so the picker label drops its "Esc to Cancel" hint.
	const [processing, setProcessing] = useState(false);
	const [scanning, setScanning] = useState(false);
	const [result, setResult] = useState<SnipResult | null>(null);
	const [inspect, setInspect] = useState<InspectResult | null>(null);
	// Running token total for this panel session; resets when the side panel reloads.
	const [sessionTokens, setSessionTokens] = useState(0);

	// Inject the global stylesheet once: fonts, cloud geometry, control states.
	useEffect(() => injectGlobalCss(), []);

	// Listen for the content script's output. A snip and a scan are mutually exclusive
	// in the capture view, so each arriving result clears the other. Both forward any
	// byok token usage into the running session total.
	useEffect(() => {
		const onMessage = (message: unknown): undefined => {
			const type =
				typeof message === 'object' && message !== null && 'type' in message
					? (message as { type: unknown }).type
					: null;
			if (type === PICKER_SELECTED) {
				setProcessing(true); // Element picked, pipeline running: past the point of cancelling.
			} else if (type === SNIP_RESULT) {
				const payload = (message as { payload?: SnipResult }).payload ?? null;
				setResult(payload);
				setInspect(null);
				addUsage(payload?.usage);
				setView('capture');
				setPicking(false);
				setProcessing(false);
			} else if (type === INSPECT_RESULT) {
				const payload = (message as { payload?: InspectPayload }).payload ?? null;
				setInspect(payload);
				setResult(null);
				addUsage(payload?.usage);
				setView('capture');
				setScanning(false); // The scan is formed, so drop the loading state.
			}
			return undefined; // No async response; do not hold the channel open.
		};
		const addUsage = (usage?: TokenUsage): void => {
			if (usage) setSessionTokens((total) => total + usage.input + usage.output);
		};
		chrome.runtime.onMessage.addListener(onMessage);
		return () => chrome.runtime.onMessage.removeListener(onMessage);
	}, []);

	// While selecting, before an element is picked, esc in the panel cancels the overlay through a
	// focus-independent path. Once the pipeline is running there is nothing to cancel, so it unbinds.
	useEffect(() => {
		if (!picking || processing) return;
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === 'Escape') {
				void cancelPicker();
				setPicking(false);
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [picking, processing]);

	/** enter/leave the in-flight pick state; a new pick clears whichever result is showing. */
	const onPickingChange = (next: boolean): void => {
		setPicking(next);
		if (next) {
			setProcessing(false);
			setResult(null);
			setInspect(null);
		}
	};

	/**
	 * enter/leave the in-flight scan state; mirrors onPickingChange so a page scan shows the
	 * same loading effect as a pick. A new scan clears whichever result is showing, so the
	 * code block only reappears once the scan is formed, and INSPECT_RESULT ends the state.
	 */
	const onScanningChange = (next: boolean): void => {
		setScanning(next);
		if (next) {
			setResult(null);
			setInspect(null);
		}
	};

	return (
		<>
			<CloudBackdrop />
			<div style={styles.shell as React.CSSProperties}>
				<nav style={styles.nav as React.CSSProperties}>
					{NAV.map(({ id, label, Icon }) => (
						<button
							key={id}
							className={`sc-navicon${view === id ? ' sc-navicon-active' : ''}`}
							title={label}
							aria-label={label}
							onClick={() => setView(id)}
						>
							<Icon size={18} />
						</button>
					))}
				</nav>

				<div style={styles.main as React.CSSProperties}>
					{view === 'capture' && (
						<ViewLayout
							fill
							footer={
								<>
									<Picker
										mode={mode}
										onModeChange={setMode}
										picking={picking}
										processing={processing}
										onPickingChange={onPickingChange}
										scanning={scanning}
										onScanningChange={onScanningChange}
									/>
									<div style={styles.tokens as React.CSSProperties}>Tokens Used: {sessionTokens.toLocaleString()}</div>
								</>
							}
						>
							{inspect ? <InspectPanel result={inspect} /> : <ResultPanel result={result} />}
						</ViewLayout>
					)}
					{view === 'history' && <SnippetList />}
					{view === 'settings' && <SettingsView />}
				</div>
			</div>
		</>
	);
}

// Self-mount. The side panel document, index.html, provides #root.
const container = document.getElementById('root');
if (container) {
	createRoot(container).render(<App />);
}

export default App;
