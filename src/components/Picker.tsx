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
 * This is that trigger: a split action whose main segment starts a pick and whose
 * chevron segment opens a small menu above it to choose the capture mode (snip /
 * assistive). The main button's label is itself the active-mode indicator: it reads
 * "Snip Element" or "Assistive Element". Clicking pick asks the active tab's content
 * script to inject its highlight overlay so the user can choose an element. The
 * heavy lifting (the overlay, sticky arrow-climb, screenshot) lives in the content
 * script; this component owns the mode state and the start signal. While a pick is
 * in flight it reflects a "selecting" state and lifts that up via onPickingChange so
 * App can wire the panel-side esc-to-cancel (the page-side esc handler only fires
 * when the page, not the side panel, holds keyboard focus).
 */
import { useState } from 'react';
import { Check, ChevronUp } from 'lucide-react';
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

/**
 * The capture modes, in menu order. `label` names the mode in the menu; `action`
 * is the main button's label for that mode (so the button text is the active-mode
 * indicator).
 */
const MODES: ReadonlyArray<{ id: 'snip' | 'assistive'; label: string; action: string }> = [
	{ id: 'snip', label: 'Snip', action: 'Snip Element' },
	{ id: 'assistive', label: 'Assistive', action: 'Assistive Element' },
];

const styles = {
	/** Anchors the popover menu directly above the split action. */
	splitWrap: { position: 'relative' },
	/** Transparent click-catcher that closes the menu on an outside click. */
	backdrop: { position: 'fixed', inset: 0, zIndex: 19 },
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
	const [menuOpen, setMenuOpen] = useState(false);

	const onPick = async (): Promise<void> => {
		onPickingChange(true);
		const started = await startPicker(mode);
		if (!started) onPickingChange(false); // Could not reach the page; leave select mode.
	};

	const activeAction = MODES.find((m) => m.id === mode)?.action ?? 'Pick Element';

	return (
		<div style={styles.splitWrap as React.CSSProperties}>
			{menuOpen && (
				<>
					<div style={styles.backdrop as React.CSSProperties} onClick={() => setMenuOpen(false)} />
					<div className="sc-menu" role="listbox" aria-label="Capture mode">
						{MODES.map((m) => (
							<button
								key={m.id}
								role="option"
								aria-selected={mode === m.id}
								className={`sc-menu-item${mode === m.id ? ' sc-menu-item-active' : ''}`}
								onClick={() => {
									onModeChange(m.id);
									setMenuOpen(false);
								}}
							>
								{m.label}
								{mode === m.id && <Check size={15} />}
							</button>
						))}
					</div>
				</>
			)}

			<div className={`sc-split${picking ? ' sc-split-disabled' : ''}`}>
				<button className="sc-split-main" disabled={picking} onClick={() => void onPick()} style={{ fontFamily: FONT_UI }}>
					{picking ? 'Selecting… (Esc to cancel)' : activeAction}
				</button>
				<div className="sc-split-divider" />
				<button
					className="sc-split-chevron"
					disabled={picking}
					aria-haspopup="listbox"
					aria-expanded={menuOpen}
					aria-label="Choose capture mode"
					onClick={() => setMenuOpen((open) => !open)}
				>
					<ChevronUp size={16} style={{ transform: menuOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s ease' }} />
				</button>
			</div>
		</div>
	);
}
