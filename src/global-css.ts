/**
 * Global-css.ts: the one injected stylesheet for the sidebar ui
 *
 * Pipeline position: n/a; ui foundation, not a pipeline phase
 * Reads from Captured: n/a
 * Writes to Captured: n/a
 *
 * Principles applied: none; ui.
 *
 * Why this exists: the v2 ui is otherwise styled with inline react style objects,
 * the established convention, since there are no .css files in the tree. A handful of things
 * cannot be expressed inline: @font-face, the cloud-backdrop geometry, and, most
 * importantly, interactive pseudo-states (:hover / :active / :disabled) and
 * ::-webkit-scrollbar / ::placeholder. Inline styles also win the cascade over
 * stylesheet rules, so a button whose base background is inline can never show a
 * :hover background. The fix used here: interactive controls, such as buttons,
 * inputs, and the mode toggle, are styled entirely by the classes below so their
 * pseudo-states work, while structural layout stays inline. App.tsx injects this
 * once on mount, keeping index.html bare, so the bundle owns all markup. Values come from
 * theme.ts so inline styles and these rules never drift.
 */
import { COLORS, FONT_CODE, FONT_UI, RADIUS, STATE, SURFACE, EASE_UI } from './theme';

/** The id of the single injected <style> element, the idempotency guard. */
const STYLE_ID = 'snipcode-global-css';

/**
 * The full stylesheet, built from theme tokens. Font unicode-ranges are copied
 * from v1's fonts.css so latin + latin-ext subsets load identically.
 */
export const GLOBAL_CSS = `
/* ---- Self-hosted fonts, served from the extension origin at /fonts. ---- */
@font-face {
	font-family: 'Montserrat';
	font-style: normal;
	font-weight: 400 800;
	font-display: swap;
	src: url('/fonts/montserrat-latin.woff2') format('woff2');
	unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
@font-face {
	font-family: 'Montserrat';
	font-style: normal;
	font-weight: 400 800;
	font-display: swap;
	src: url('/fonts/montserrat-latin-ext.woff2') format('woff2');
	unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
}
@font-face {
	font-family: 'JetBrains Mono';
	font-style: normal;
	font-weight: 400 600;
	font-display: swap;
	src: url('/fonts/jetbrains-mono-latin.woff2') format('woff2');
	unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
@font-face {
	font-family: 'JetBrains Mono';
	font-style: normal;
	font-weight: 400 600;
	font-display: swap;
	src: url('/fonts/jetbrains-mono-latin-ext.woff2') format('woff2');
	unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
}

/* ---- Reset + global. ---- */
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
	font-family: ${FONT_UI};
	color: ${COLORS.slate800};
	letter-spacing: -0.01em;
	-webkit-font-smoothing: antialiased;
	-moz-osx-font-smoothing: grayscale;
	text-rendering: optimizeLegibility;
}

/* ---- Cloud backdrop geometry only; per-cloud values are inline in CloudBackdrop. ---- */
.cloud-backdrop { position: fixed; inset: 0; overflow: hidden; pointer-events: none; z-index: 0; opacity: 0.4; }
.cloud-sky { position: absolute; inset: 0; background: linear-gradient(to bottom, ${COLORS.sky0} 0%, ${COLORS.sky1} 45%, ${COLORS.sky2} 70%, ${COLORS.sky3} 100%); }
.cloud-field { position: absolute; inset: 0; }
.cloud-cluster { position: absolute; }
.cloud-piece { position: absolute; border-radius: 50%; }

/* ---- Buttons, styled fully by class so pseudo-states win over no inline base. ---- */
.sc-btn {
	font-family: ${FONT_UI};
	font-weight: 600;
	border: none;
	cursor: pointer;
	transition: background 0.2s ${EASE_UI}, box-shadow 0.2s ${EASE_UI}, transform 0.15s ${EASE_UI}, opacity 0.15s ${EASE_UI};
}
.sc-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.sc-btn-primary {
	width: 100%;
	height: 46px;
	border-radius: ${RADIUS.xl}px;
	font-size: 14px;
	color: ${SURFACE.onDarkText};
	background: ${SURFACE.primary};
	border: 1px solid ${SURFACE.onDarkBorder};
}
.sc-btn-primary:hover:not(:disabled) { background: ${SURFACE.primaryHover}; }
.sc-btn-primary:active:not(:disabled) { transform: scale(0.985); opacity: 0.9; }
.sc-btn-secondary {
	height: 46px;
	border-radius: ${RADIUS.xl}px;
	font-size: 14px;
	color: ${SURFACE.secondaryText};
	background: ${SURFACE.control};
	border: 1px solid ${SURFACE.borderStrong};
}
.sc-btn-secondary:hover:not(:disabled) { background: ${SURFACE.controlHover}; }
.sc-btn-secondary:active:not(:disabled) { transform: scale(0.985); }
/* Compact modifier for inline actions such as test key. */
.sc-btn-sm { height: 34px; width: auto; padding: 0 14px; font-size: 13px; border-radius: ${RADIUS.md}px; }

/* ---- Split action in the capture footer: pick element + mode chevron. ---- */
.sc-split {
	display: flex;
	align-items: stretch;
	width: 100%;
	height: 46px;
	border-radius: ${RADIUS.xl}px;
	overflow: hidden;
	background: ${SURFACE.primary};
	border: 1px solid ${SURFACE.onDarkBorder};
	transition: background 0.2s ${EASE_UI}, opacity 0.15s ${EASE_UI};
}
.sc-split:hover:not(.sc-split-disabled) { background: ${SURFACE.primaryHover}; }
.sc-split-disabled { opacity: 0.5; }
.sc-split-main, .sc-split-chevron {
	border: none;
	background: transparent;
	color: ${SURFACE.onDarkText};
	cursor: pointer;
	transition: background 0.15s ${EASE_UI}, transform 0.15s ${EASE_UI};
}
.sc-split-main {
	flex: 1;
	font-family: ${FONT_UI};
	font-size: 14px;
	font-weight: 600;
}
.sc-split-main:hover:not(:disabled) { background: ${STATE.onDarkHover}; }
.sc-split-main:active:not(:disabled) { transform: scale(0.99); }
.sc-split-main:disabled, .sc-split-chevron:disabled { cursor: not-allowed; }
.sc-split-divider { width: 1px; margin: 9px 0; background: ${STATE.onDarkDivider}; }
.sc-split-chevron {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 42px;
}
.sc-split-chevron:hover:not(:disabled) { background: ${STATE.onDarkHoverStrong}; }
.sc-split-chevron:active:not(:disabled) { transform: scale(0.94); }

/* ---- Popover menu for the capture mode select; opens above the split action. ---- */
.sc-menu {
	position: absolute;
	left: 0;
	right: 0;
	bottom: calc(100% + 8px);
	z-index: 20;
	padding: 4px;
	background: ${COLORS.white};
	border: 1px solid ${SURFACE.borderStrong};
	border-radius: ${RADIUS.lg}px;
	box-shadow: ${SURFACE.shadow};
}
.sc-menu-item {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	width: 100%;
	padding: 9px 10px;
	border: none;
	background: transparent;
	border-radius: ${RADIUS.sm}px;
	font-family: ${FONT_UI};
	font-size: 13px;
	font-weight: 600;
	color: ${COLORS.slate700};
	text-align: left;
	cursor: pointer;
	transition: background 0.12s ${EASE_UI}, color 0.12s ${EASE_UI};
}
.sc-menu-item:hover { background: ${STATE.iconBtnHover}; color: ${COLORS.slate900}; }
.sc-menu-item-active { color: ${COLORS.slate900}; }
/* Hairline between the element-pick modes and the page-scan modes in the menu. */
.sc-menu-divider { height: 1px; margin: 4px 6px; background: ${SURFACE.border}; }

/* ---- Page-scoped inspector card grid: fonts, colors, and assets. ---- */
.sc-inspect-grid {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
	gap: 8px;
	align-content: start;
}
.sc-inspect-card {
	display: flex;
	align-items: center;
	gap: 10px;
	min-width: 0;
	padding: 9px 10px;
	border: 1px solid ${SURFACE.border};
	border-radius: ${RADIUS.lg}px;
	background: ${SURFACE.card};
	font-family: ${FONT_UI};
	text-align: left;
	cursor: pointer;
	transition: border-color 0.15s ${EASE_UI}, background 0.15s ${EASE_UI}, box-shadow 0.15s ${EASE_UI}, transform 0.15s ${EASE_UI};
}
.sc-inspect-card:hover { border-color: ${SURFACE.borderStrong}; background: ${COLORS.white}; box-shadow: ${SURFACE.shadow}; }
.sc-inspect-card:active { transform: scale(0.98); }
/* History list: a stored-snippet card, a clickable body plus its save toggle. */
.sc-history-card {
	display: flex;
	align-items: center;
	gap: 10px;
	width: 100%;
	margin-bottom: 8px;
	padding: 8px;
	border: 1px solid ${SURFACE.border};
	border-radius: ${RADIUS.lg}px;
	background: ${SURFACE.control};
	font-family: ${FONT_UI};
	font-size: 12px;
	text-align: left;
	cursor: pointer;
	transition: border-color 0.15s ${EASE_UI}, background 0.15s ${EASE_UI}, box-shadow 0.15s ${EASE_UI}, transform 0.15s ${EASE_UI};
}
.sc-history-card:hover { border-color: ${SURFACE.borderStrong}; background: ${COLORS.white}; box-shadow: ${SURFACE.shadow}; }
/* The card's clickable body, everything left of the save toggle. Downloads the snippet. */
.sc-history-hit {
	display: flex;
	align-items: center;
	gap: 10px;
	flex: 1;
	min-width: 0;
	padding: 0;
	border: none;
	background: transparent;
	font-family: ${FONT_UI};
	font-size: 12px;
	text-align: left;
	color: inherit;
	cursor: pointer;
	transition: transform 0.15s ${EASE_UI};
}
.sc-history-hit:active { transform: scale(0.98); }
/* The section heading above each history group, with its live count. */
.sc-section-title {
	margin: 4px 0 6px;
	font-family: ${FONT_UI};
	font-size: 11px;
	font-weight: 600;
	letter-spacing: 0.04em;
	text-transform: uppercase;
	color: ${COLORS.slate500};
}
/* Fixed-size preview box on the card's left: font sample, color swatch, or thumbnail. */
.sc-inspect-preview {
	display: inline-flex;
	flex-shrink: 0;
	align-items: center;
	justify-content: center;
	width: 38px;
	height: 38px;
	overflow: hidden;
	border-radius: ${RADIUS.sm}px;
	background: ${COLORS.slate50};
}
.sc-inspect-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.sc-inspect-name { font-size: 12px; font-weight: 600; color: ${COLORS.slate800}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sc-inspect-meta { font-size: 11px; color: ${COLORS.slate500}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sc-font-preview { font-size: 19px; line-height: 1; color: ${COLORS.slate700}; }
.sc-color-swatch { width: 100%; height: 100%; }
.sc-asset-thumb { max-width: 100%; max-height: 100%; object-fit: contain; }
.sc-asset-svg { display: inline-flex; align-items: center; justify-content: center; width: 100%; height: 100%; }
.sc-asset-svg svg { max-width: 100%; max-height: 100%; }

/* ---- Icon nav for capture / history / settings; hover tooltips are native title attrs. ---- */
.sc-navicon {
	position: relative;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 34px;
	height: 34px;
	padding: 0;
	border: none;
	border-radius: ${RADIUS.md}px;
	background: transparent;
	color: ${COLORS.slate900};
	cursor: pointer;
	transition: color 0.15s ${EASE_UI}, background 0.15s ${EASE_UI};
}
.sc-navicon:hover { background: ${STATE.iconBtnHover}; }
.sc-navicon-active { background: ${STATE.navActive}; }

/* ---- File tabs for index.html, icon-1.svg, image-1.png. ---- */
.sc-tab {
	padding: 6px 10px;
	border: none;
	background: transparent;
	font-family: ${FONT_CODE};
	font-size: 11px;
	font-weight: 500;
	color: ${COLORS.slate500};
	cursor: pointer;
	white-space: nowrap;
	border-bottom: 2px solid transparent;
	transition: color 0.15s ${EASE_UI}, border-color 0.15s ${EASE_UI};
}
.sc-tab:hover { color: ${COLORS.slate700}; }
.sc-tab-active { color: ${COLORS.slate900}; border-bottom-color: ${COLORS.slate900}; }

/* ---- Icon buttons for copy, save, more, overflow. ---- */
.sc-icon-btn {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 28px;
	height: 28px;
	padding: 0;
	border: none;
	border-radius: ${RADIUS.sm}px;
	background: transparent;
	color: ${COLORS.slate400};
	cursor: pointer;
	transition: color 0.15s ${EASE_UI}, background 0.15s ${EASE_UI}, transform 0.15s ${EASE_UI};
}
.sc-icon-btn:hover { color: ${COLORS.slate600}; background: ${STATE.iconBtnHover}; }
.sc-icon-btn:active { color: ${COLORS.slate800}; transform: scale(0.92); }
/* The saved half of the bookmark toggle, in the result panel and on a history card. */
.sc-icon-btn-saved { color: ${COLORS.accent}; }
.sc-icon-btn-saved:hover { color: ${COLORS.accent}; background: ${STATE.iconBtnHover}; }

/* ---- Inputs + selects. ---- */
.sc-input {
	width: 100%;
	height: 36px;
	padding: 7px 9px;
	font-family: ${FONT_UI};
	font-size: 13px;
	color: ${COLORS.slate800};
	background: ${SURFACE.field};
	border: 1px solid ${SURFACE.borderStrong};
	border-radius: ${RADIUS.md}px;
	box-sizing: border-box;
	transition: border-color 0.15s ${EASE_UI}, box-shadow 0.15s ${EASE_UI};
}
.sc-input:focus { outline: none; border-color: ${COLORS.accent}; box-shadow: 0 0 0 3px ${STATE.focusRing}; }
.sc-input::placeholder { color: ${COLORS.slate400}; }
/* Hide the browser's own password-reveal control in Edge so it never doubles our eye. */
.sc-input::-ms-reveal, .sc-input::-ms-clear { display: none; }

/* Field wrapper hosting a masked input plus its in-field reveal eye. */
.sc-key-field { position: relative; flex: 1; min-width: 0; }
/* The eye sits just inside the right edge; the input's right padding clears its text. */
.sc-key-reveal {
	position: absolute;
	top: 50%;
	right: 6px;
	transform: translateY(-50%);
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 26px;
	height: 26px;
	padding: 0;
	border: none;
	border-radius: ${RADIUS.sm}px;
	background: transparent;
	color: ${COLORS.slate400};
	cursor: pointer;
	transition: color 0.15s ${EASE_UI}, background 0.15s ${EASE_UI};
}
.sc-key-reveal:hover { color: ${COLORS.slate600}; background: ${STATE.iconBtnHover}; }
.sc-key-reveal:active { color: ${COLORS.slate800}; transform: translateY(-50%) scale(0.92); }

/* ---- Custom select for settings; opens in-flow so it pushes content below it down. ---- */
.sc-select { position: relative; }
.sc-select-trigger {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	width: 100%;
	height: 36px;
	padding: 7px 9px;
	font-family: ${FONT_UI};
	font-size: 13px;
	color: ${COLORS.slate800};
	background: ${SURFACE.field};
	border: 1px solid ${SURFACE.borderStrong};
	border-radius: ${RADIUS.md}px;
	cursor: pointer;
	transition: border-color 0.15s ${EASE_UI}, box-shadow 0.15s ${EASE_UI};
}
.sc-select-trigger:hover { border-color: ${COLORS.slate400}; }
.sc-select-trigger-open { border-color: ${COLORS.accent}; box-shadow: 0 0 0 3px ${STATE.focusRing}; }
.sc-select-panel {
	position: relative;
	z-index: 31;
	margin-top: 6px;
	padding: 4px;
	background: ${SURFACE.card};
	border: 1px solid ${SURFACE.borderStrong};
	border-radius: ${RADIUS.md}px;
	box-shadow: ${SURFACE.shadow};
}
.sc-select-option {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	width: 100%;
	padding: 8px 9px;
	border: none;
	background: transparent;
	border-radius: ${RADIUS.sm}px;
	font-family: ${FONT_UI};
	font-size: 13px;
	font-weight: 500;
	color: ${COLORS.slate700};
	text-align: left;
	cursor: pointer;
	transition: background 0.12s ${EASE_UI}, color 0.12s ${EASE_UI};
}
.sc-select-option:hover { background: ${STATE.iconBtnHover}; color: ${COLORS.slate900}; }
.sc-select-option-active { color: ${COLORS.accent}; font-weight: 600; }

/* ---- Icon action button for the verify buttons beside the api/model inputs. ---- */
.sc-icon-action {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
	width: 36px;
	height: 36px;
	border: 1px solid ${SURFACE.borderStrong};
	border-radius: ${RADIUS.md}px;
	background: ${SURFACE.control};
	color: ${COLORS.slate600};
	cursor: pointer;
	transition: background 0.15s ${EASE_UI}, color 0.15s ${EASE_UI}, transform 0.15s ${EASE_UI};
}
.sc-icon-action:hover:not(:disabled) { background: ${SURFACE.controlHover}; color: ${COLORS.slate900}; }
.sc-icon-action:active:not(:disabled) { transform: scale(0.94); }
.sc-icon-action:disabled { opacity: 0.5; cursor: not-allowed; }

/* ---- Custom checkbox rows for assistive delivery. ---- */
.sc-check-row {
	display: flex;
	align-items: center;
	gap: 9px;
	width: 100%;
	padding: 7px 2px;
	border: none;
	background: transparent;
	font-family: ${FONT_UI};
	font-size: 13px;
	color: ${COLORS.slate700};
	text-align: left;
	cursor: pointer;
	transition: color 0.12s ${EASE_UI};
}
.sc-check-row:hover { color: ${COLORS.slate900}; }
.sc-check-box {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	flex-shrink: 0;
	width: 18px;
	height: 18px;
	border: 1px solid ${SURFACE.borderStrong};
	border-radius: ${RADIUS.sm}px;
	background: ${SURFACE.field};
	color: ${COLORS.white};
	transition: background 0.12s ${EASE_UI}, border-color 0.12s ${EASE_UI};
}
.sc-check-box-on { background: ${COLORS.accent}; border-color: ${COLORS.accent}; }

/* ---- Thin scrollbar for the code display. ---- */
.sc-scroll { scrollbar-width: thin; scrollbar-color: ${STATE.scrollThumb} transparent; }
.sc-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
.sc-scroll::-webkit-scrollbar-track { background: transparent; }
.sc-scroll::-webkit-scrollbar-thumb { background: ${STATE.scrollThumb}; border-radius: 3px; }
.sc-scroll::-webkit-scrollbar-thumb:hover { background: ${STATE.scrollThumbHover}; }
`;

/**
 * Injects {@link GLOBAL_CSS} once into the document head. Idempotent: a second
 * call, such as a hot-reload or a re-mount, finds the existing style by id and
 * no-ops, so the rules are never duplicated.
 */
export function injectGlobalCss(): void {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = GLOBAL_CSS;
	document.head.appendChild(style);
}
