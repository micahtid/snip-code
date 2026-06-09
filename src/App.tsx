/**
 * App.tsx — side-panel root + sidebar shell
 *
 * Phase: a (scaffold) — see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: n/a (ui host, not a pipeline phase)
 * Reads from Captured: n/a
 * Writes to Captured: n/a
 *
 * Principles applied: none (ui).
 *
 * Why this exists: chrome opens this document in the side panel. it is the only
 * react root in the extension. it owns top-level navigation between the three
 * sidebar views (capture / saved / settings) and hosts the picker control. the
 * panels it renders (ResultPanel, SnippetList, SettingsView) are empty stubs at
 * this scaffold stage and gain real behavior in later phases (e: result panel,
 * i: settings, k: snippet list).
 *
 * this module self-mounts at the bottom of the file so the build needs no
 * separate main.tsx entry (keeps the repo tree exactly as section 2 declares).
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Picker } from './components/Picker';
import { ResultPanel } from './components/ResultPanel';
import { SnippetList } from './components/SnippetList';
import { SettingsView } from './components/SettingsView';

/** the three top-level sidebar views the nav switches between. */
type View = 'capture' | 'saved' | 'settings';

/**
 * the two capture modes (section 9). snip runs all 5 pipeline phases and emits
 * code; assistive runs phase 1 and emits a json document. the toggle lives in
 * the capture view and is passed down to the picker.
 */
type Mode = 'snip' | 'assistive';

const styles = {
	app: {
		display: 'flex',
		flexDirection: 'column',
		height: '100vh',
		margin: 0,
		fontFamily: 'system-ui, -apple-system, sans-serif',
		fontSize: '13px',
		color: '#1a1a1a',
		background: '#fff',
	},
	header: {
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
		padding: '10px 12px',
		borderBottom: '1px solid #eee',
		fontWeight: 600,
	},
	nav: { display: 'flex', borderBottom: '1px solid #eee' },
	navButton: (active: boolean) => ({
		flex: 1,
		padding: '8px',
		border: 'none',
		borderBottom: active ? '2px solid #4f6ef6' : '2px solid transparent',
		background: 'transparent',
		color: active ? '#4f6ef6' : '#666',
		fontWeight: active ? 600 : 400,
		cursor: 'pointer',
	}),
	body: { flex: 1, overflow: 'auto', padding: '12px' },
} satisfies Record<string, unknown>;

/**
 * the sidebar shell: header, view nav, and the active view's body.
 *
 * holds the two pieces of cross-view ui state — which view is showing and the
 * current capture mode — and threads the mode into the picker so a snip carries
 * the user's chosen mode into the pipeline.
 */
function App() {
	const [view, setView] = useState<View>('capture');
	const [mode, setMode] = useState<Mode>('snip');

	return (
		<div style={styles.app as React.CSSProperties}>
			<div style={styles.header as React.CSSProperties}>
				<span style={{ color: '#4f6ef6' }}>◧</span> SnipCode
			</div>

			<nav style={styles.nav as React.CSSProperties}>
				<button style={styles.navButton(view === 'capture')} onClick={() => setView('capture')}>
					Capture
				</button>
				<button style={styles.navButton(view === 'saved')} onClick={() => setView('saved')}>
					Saved
				</button>
				<button style={styles.navButton(view === 'settings')} onClick={() => setView('settings')}>
					Settings
				</button>
			</nav>

			<div style={styles.body as React.CSSProperties}>
				{view === 'capture' && (
					<>
						<Picker mode={mode} onModeChange={setMode} />
						<ResultPanel />
					</>
				)}
				{view === 'saved' && <SnippetList />}
				{view === 'settings' && <SettingsView />}
			</div>
		</div>
	);
}

// self-mount. the side panel document (index.html) provides #root.
const container = document.getElementById('root');
if (container) {
	createRoot(container).render(<App />);
}

export default App;
