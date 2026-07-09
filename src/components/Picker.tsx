/**
 * components/Picker.tsx: sidebar picker control
 *
 * Pipeline position: triggers capture
 * Reads from Captured: n/a
 * Writes to Captured: n/a
 *
 * Principles applied: none. Ui only.
 *
 * Why this exists: the picker is triggered from the sidebar.
 * This is that trigger: a split action whose main segment runs the active mode and
 * whose chevron segment opens a small menu above it to choose the mode. Two groups
 * of modes share the menu: the element picks, snip / assistive, which inject the
 * page overlay so the user selects an element, and the page scans, colors / fonts /
 * assets / schema, which read the whole page at once. The main button's label
 * is the active-mode indicator. Element picks lift a "picking" state up via
 * onPickingChange so App can wire the panel-side esc-to-cancel. Page scans need no
 * overlay, so they show a transient "Scanning..." instead. The heavy lifting lives
 * in the content script, meaning overlay plus screenshot for picks and extraction
 * for scans. This component owns only the mode state and the start signal.
 */
import { Fragment, useState } from 'react';
import { Check, ChevronUp } from 'lucide-react';
import { START_SCAN, START_PICKER } from '../content/types';
import type { ScanKind } from '../content/inspect/types';
import { FONT_UI } from '../theme';

/** Element picks run the snip pipeline; page scans inspect the whole page. */
export type Mode = 'snip' | 'assistive' | ScanKind;

interface PickerProps {
	mode: Mode;
	onModeChange: (mode: Mode) => void;
	/** True while an element selection is in progress; owned by App. */
	picking: boolean;
	/** Report whether a pick is now in flight: true on start, false if start failed. */
	onPickingChange: (picking: boolean) => void;
}

/**
 * The modes, in menu order. `kind` splits the menu into an element-pick group and
 * a page-scan group, with a divider between them. `label` names the mode in the
 * menu. `action` is the main button's label for that mode, so the button text is
 * the active-mode indicator.
 */
const MODES: ReadonlyArray<{ id: Mode; label: string; action: string; kind: 'element' | 'page' }> = [
	{ id: 'snip', label: 'Snip', action: 'Snip Element', kind: 'element' },
	{ id: 'assistive', label: 'Assistive', action: 'Assistive Element', kind: 'element' },
	{ id: 'colors', label: 'Colors', action: 'Scan Colors', kind: 'page' },
	{ id: 'fonts', label: 'Fonts', action: 'Scan Fonts', kind: 'page' },
	{ id: 'assets', label: 'Assets', action: 'Scan Assets', kind: 'page' },
	{ id: 'schema', label: 'Schema', action: 'Scan Schema', kind: 'page' },
];

const styles = {
	/** Anchors the popover menu directly above the split action. */
	splitWrap: { position: 'relative' },
	/** Transparent click-catcher that closes the menu on an outside click. */
	backdrop: { position: 'fixed', inset: 0, zIndex: 19 },
} satisfies Record<string, unknown>;

/**
 * Sends a ui-local start signal to the content script in the active tab.
 *
 * The side panel runs in the extension context, so it must resolve the active tab
 * id before messaging it. Failures such as no active tab, or a content script not
 * yet injected on a freshly loaded page, are surfaced to the console rather than
 * thrown, because a missing overlay or scan is a recoverable user-retry, not a
 * crash. The boolean return drives the in-flight state. It is true once the signal
 * was delivered, and false if the page could not be messaged.
 *
 * @param message - the start-picker or start-scan signal to deliver
 * @returns whether the signal was delivered
 */
async function sendToActiveTab(message: Record<string, unknown>): Promise<boolean> {
	const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
	if (!tab?.id) {
		console.warn('snipcode: no active tab to act on');
		return false;
	}
	try {
		await chrome.tabs.sendMessage(tab.id, message);
		return true;
	} catch (err) {
		// The content script may not be loaded on chrome:// pages or just-opened
		// tabs. Tell the user rather than failing silently.
		console.warn('snipcode: could not reach this page', err);
		return false;
	}
}

export function Picker({ mode, onModeChange, picking, onPickingChange }: PickerProps) {
	const [menuOpen, setMenuOpen] = useState(false);
	// A page scan shows a transient label on the main button. It owns no overlay state.
	const [scanning, setScanning] = useState(false);

	const active = MODES.find((m) => m.id === mode) ?? MODES[0]!;

	const onRun = async (): Promise<void> => {
		if (active.kind === 'element') {
			onPickingChange(true);
			const started = await sendToActiveTab({ type: START_PICKER, mode });
			if (!started) onPickingChange(false); // Could not reach the page, so leave select mode.
			return;
		}
		// Page scan: flash "Scanning..." until the content script ships its result and App
		// swaps in the InspectPanel. Either way, clear the flash shortly after.
		setScanning(true);
		await sendToActiveTab({ type: START_SCAN, scan: mode as ScanKind });
		setTimeout(() => setScanning(false), 1200);
	};

	const busy = picking || scanning;
	const mainLabel = picking ? 'Selecting… (Esc to cancel)' : scanning ? 'Scanning…' : active.action;

	return (
		<div style={styles.splitWrap as React.CSSProperties}>
			{menuOpen && (
				<>
					<div style={styles.backdrop as React.CSSProperties} onClick={() => setMenuOpen(false)} />
					<div className="sc-menu" role="listbox" aria-label="Capture mode">
						{MODES.map((m, i) => (
							<Fragment key={m.id}>
								{i > 0 && MODES[i - 1]!.kind !== m.kind && <div className="sc-menu-divider" role="separator" />}
								<button
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
							</Fragment>
						))}
					</div>
				</>
			)}

			<div className={`sc-split${busy ? ' sc-split-disabled' : ''}`}>
				<button className="sc-split-main" disabled={busy} onClick={() => void onRun()} style={{ fontFamily: FONT_UI }}>
					{mainLabel}
				</button>
				<div className="sc-split-divider" />
				<button
					className="sc-split-chevron"
					disabled={busy}
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
