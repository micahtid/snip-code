/**
 * components/Picker.tsx — sidebar picker control
 *
 * Phase: a (scaffold) — see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: triggers pipeline phase 1 (capture)
 * Reads from Captured: n/a
 * Writes to Captured: n/a
 *
 * Principles applied: none (ui).
 *
 * Why this exists: section 19.7 says the picker is triggered from the sidebar.
 * this is that trigger: the snip/assistive mode toggle plus the "pick element"
 * button. clicking the button asks the active tab's content script to inject its
 * highlight overlay so the user can choose an element. the heavy lifting (the
 * overlay itself, arrowup climb, screenshot) lives in the content script; this
 * component only owns the mode state and the start signal.
 */

/** the ui-local message that wakes the content script's picker overlay. */
const START_PICKER = 'SNIPCODE_START_PICKER' as const;

interface PickerProps {
	mode: 'snip' | 'assistive';
	onModeChange: (mode: 'snip' | 'assistive') => void;
}

const styles = {
	wrap: { marginBottom: '12px' },
	toggle: { display: 'flex', gap: '4px', marginBottom: '8px' },
	toggleButton: (active: boolean) => ({
		flex: 1,
		padding: '6px 8px',
		border: `1px solid ${active ? '#4f6ef6' : '#ddd'}`,
		borderRadius: '6px',
		background: active ? '#eef1fe' : '#fff',
		color: active ? '#4f6ef6' : '#444',
		fontWeight: active ? 600 : 400,
		cursor: 'pointer',
	}),
	pick: {
		width: '100%',
		padding: '10px',
		border: 'none',
		borderRadius: '6px',
		background: '#4f6ef6',
		color: '#fff',
		fontWeight: 600,
		cursor: 'pointer',
	},
} satisfies Record<string, unknown>;

/**
 * sends the start-picker signal to the content script in the active tab.
 *
 * the side panel runs in the extension context, so it must resolve the active
 * tab id before messaging it. failures (no active tab, content script not yet
 * injected on a freshly loaded page) are surfaced to the console rather than
 * thrown, since a missing overlay is a recoverable user-retry, not a crash.
 *
 * @param mode — the capture mode to run once an element is chosen
 */
async function startPicker(mode: 'snip' | 'assistive'): Promise<void> {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!tab?.id) {
		console.warn('snipcode: no active tab to pick from');
		return;
	}
	try {
		await chrome.tabs.sendMessage(tab.id, { type: START_PICKER, mode });
	} catch (err) {
		// the content script may not be loaded on chrome:// pages or just-opened
		// tabs. tell the user rather than failing silently.
		console.warn('snipcode: could not start picker on this page', err);
	}
}

export function Picker({ mode, onModeChange }: PickerProps) {
	return (
		<div style={styles.wrap as React.CSSProperties}>
			<div style={styles.toggle as React.CSSProperties}>
				<button style={styles.toggleButton(mode === 'snip')} onClick={() => onModeChange('snip')}>
					Snip
				</button>
				<button
					style={styles.toggleButton(mode === 'assistive')}
					onClick={() => onModeChange('assistive')}
				>
					Assistive
				</button>
			</div>
			<button style={styles.pick as React.CSSProperties} onClick={() => void startPicker(mode)}>
				Pick element
			</button>
		</div>
	);
}
