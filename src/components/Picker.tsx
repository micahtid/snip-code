/**
 * components/Picker.tsx: sidebar picker control
 *
 * Pipeline position: triggers capture
 * Reads from Captured: n/a
 * Writes to Captured: n/a
 *
 * Principles applied: none (ui).
 *
 * Why this exists: the picker is triggered from the sidebar.
 * This is that trigger: the snip/assistive mode toggle plus the "pick element"
 * button. Clicking the button asks the active tab's content script to inject its
 * highlight overlay so the user can choose an element. The heavy lifting (the
 * overlay, sticky arrow-climb, screenshot) lives in the content script; this
 * component owns the mode state and the start signal. While a pick is in flight it
 * reflects a "selecting" state and lifts that up via onPickingChange so App can
 * wire the panel-side esc-to-cancel (the page-side esc handler only fires when the
 * page, not the side panel, holds keyboard focus).
 */
import { Scissors } from 'lucide-react';
import { FONT_UI } from '../theme';

/** The ui-local message that wakes the content script's picker overlay. */
const START_PICKER = 'SNIPCODE_START_PICKER' as const;

interface PickerProps {
	mode: 'snip' | 'assistive';
	onModeChange: (mode: 'snip' | 'assistive') => void;
	/** True while an element selection is in progress (owned by App). */
	picking: boolean;
	/** Report whether a pick is now in flight (true on start, false if start failed). */
	onPickingChange: (picking: boolean) => void;
}

const styles = {
	wrap: { marginBottom: '14px' },
	toggle: { display: 'flex', gap: '6px', marginBottom: '10px' },
	pickInner: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px' },
} satisfies Record<string, unknown>;

/**
 * Sends the start-picker signal to the content script in the active tab.
 *
 * The side panel runs in the extension context, so it must resolve the active
 * tab id before messaging it. Failures (no active tab, content script not yet
 * injected on a freshly loaded page) are surfaced to the console rather than
 * thrown, since a missing overlay is a recoverable user-retry, not a crash. The
 * boolean return drives the picking state: true once the overlay was asked for,
 * false if the page could not be messaged.
 *
 * @param mode - the capture mode to run once an element is chosen
 * @returns whether the start signal was delivered
 */
async function startPicker(mode: 'snip' | 'assistive'): Promise<boolean> {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!tab?.id) {
		console.warn('snipcode: no active tab to pick from');
		return false;
	}
	try {
		await chrome.tabs.sendMessage(tab.id, { type: START_PICKER, mode });
		return true;
	} catch (err) {
		// The content script may not be loaded on chrome:// pages or just-opened
		// tabs. Tell the user rather than failing silently.
		console.warn('snipcode: could not start picker on this page', err);
		return false;
	}
}

export function Picker({ mode, onModeChange, picking, onPickingChange }: PickerProps) {
	const onPick = async (): Promise<void> => {
		onPickingChange(true);
		const started = await startPicker(mode);
		if (!started) onPickingChange(false); // Could not reach the page; leave select mode.
	};

	return (
		<div style={styles.wrap as React.CSSProperties}>
			<div style={styles.toggle as React.CSSProperties}>
				<button
					className={`sc-mode${mode === 'snip' ? ' sc-mode-active' : ''}`}
					disabled={picking}
					onClick={() => onModeChange('snip')}
				>
					Snip
				</button>
				<button
					className={`sc-mode${mode === 'assistive' ? ' sc-mode-active' : ''}`}
					disabled={picking}
					onClick={() => onModeChange('assistive')}
				>
					Assistive
				</button>
			</div>
			<button className="sc-btn sc-btn-primary" disabled={picking} onClick={() => void onPick()} style={{ fontFamily: FONT_UI }}>
				<span style={styles.pickInner as React.CSSProperties}>
					<Scissors size={16} />
					{picking ? 'Selecting… (Esc to cancel)' : 'Pick Element'}
				</span>
			</button>
		</div>
	);
}
