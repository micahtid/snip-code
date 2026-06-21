/**
 * App.tsx: side-panel root + sidebar shell
 *
 * Pipeline position: n/a (ui host, not a pipeline phase)
 * Reads from Captured: n/a
 * Writes to Captured: n/a
 *
 * Principles applied: none (ui).
 *
 * Why this exists: chrome opens this document in the side panel. It is the only
 * react root in the extension. It owns top-level navigation between the three
 * sidebar views (capture / history / settings), hosts the picker control, and is
 * the panel-side terminus of two content-script signals:
 * - It listens for SNIP_RESULT and renders the emitted code in ResultPanel.
 * - While a pick is in flight it owns the "picking" state and a window-level esc
 * handler that cancels the overlay even when keyboard focus is in the panel
 * (the picker's own esc handler only fires when the page holds focus).
 * It injects the global stylesheet once and paints the cloud backdrop behind a
 * frosted-glass shell, reproducing v1's look (theme.ts / global-css.ts).
 *
 * This module self-mounts at the bottom of the file so the build needs no separate
 * main.tsx entry (keeps the repo tree tidy).
 */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { History, Scissors, Settings, type LucideIcon } from 'lucide-react';
import { Picker } from './components/Picker';
import { ResultPanel, type SnipResult } from './components/ResultPanel';
import { SnippetList } from './components/SnippetList';
import { SettingsView } from './components/SettingsView';
import { CloudBackdrop } from './components/CloudBackdrop';
import { ViewLayout } from './components/ViewLayout';
import { injectGlobalCss } from './global-css';
import { COLORS, FONT_UI, SURFACE } from './theme';

/** The three top-level sidebar views the nav switches between. */
type View = 'capture' | 'history' | 'settings';

/**
 * The two capture modes. Snip runs the whole pipeline and emits
 * code; assistive runs capture and emits a json document. The mode is owned here and
 * passed to the picker, whose chevron menu lets the user switch it.
 */
type Mode = 'snip' | 'assistive';

/** Content-script signals (mirror the ui-local consts in content/index.ts). */
const SNIP_RESULT = 'SNIP_RESULT';
const CANCEL_PICKER = 'SNIPCODE_CANCEL_PICKER';

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
} satisfies Record<string, unknown>;

/** The three sidebar views, each with the icon and hover-tooltip label its nav button shows. */
const NAV: ReadonlyArray<{ id: View; label: string; Icon: LucideIcon }> = [
	{ id: 'capture', label: 'Capture', Icon: Scissors },
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
		// The overlay may already be gone (page navigated, tab closed). Harmless.
	}
}

/**
 * The sidebar shell: the icon nav and the active view, which fills the rest of the
 * panel as a scrollable body with a footer pinned to the bottom (the chrome side
 * panel supplies the only title bar, so there is no app header of our own).
 *
 * Holds the cross-view ui state (current view, capture mode, in-flight pick, and
 * the latest snip result) and wires the two content-script signals described in
 * the file header.
 */
function App() {
	const [view, setView] = useState<View>('capture');
	const [mode, setMode] = useState<Mode>('snip');
	const [picking, setPicking] = useState(false);
	const [result, setResult] = useState<SnipResult | null>(null);

	// Inject the global stylesheet once (fonts, cloud geometry, control states).
	useEffect(() => injectGlobalCss(), []);

	// Listen for the content script's snip output; render it and leave select mode.
	useEffect(() => {
		const onMessage = (message: unknown): undefined => {
			const type =
				typeof message === 'object' && message !== null && 'type' in message
					? (message as { type: unknown }).type
					: null;
			if (type === SNIP_RESULT) {
				setResult((message as { payload?: SnipResult }).payload ?? null);
				setView('capture');
				setPicking(false);
			}
			return undefined; // No async response; do not hold the channel open.
		};
		chrome.runtime.onMessage.addListener(onMessage);
		return () => chrome.runtime.onMessage.removeListener(onMessage);
	}, []);

	// While picking, esc in the panel cancels the overlay (focus-independent path).
	useEffect(() => {
		if (!picking) return;
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === 'Escape') {
				void cancelPicker();
				setPicking(false);
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [picking]);

	/** enter/leave the in-flight pick state; a new pick clears the previous result. */
	const onPickingChange = (next: boolean): void => {
		setPicking(next);
		if (next) setResult(null);
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
						<ViewLayout fill footer={<Picker mode={mode} onModeChange={setMode} picking={picking} onPickingChange={onPickingChange} />}>
							<ResultPanel result={result} />
						</ViewLayout>
					)}
					{view === 'history' && <SnippetList />}
					{view === 'settings' && <SettingsView />}
				</div>
			</div>
		</>
	);
}

// Self-mount. The side panel document (index.html) provides #root.
const container = document.getElementById('root');
if (container) {
	createRoot(container).render(<App />);
}

export default App;
