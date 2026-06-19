/**
 * Global-css.ts: the one injected stylesheet for the sidebar ui
 *
 * Pipeline position: n/a (ui foundation, not a pipeline phase)
 * Reads from Captured: n/a
 * Writes to Captured: n/a
 *
 * Principles applied: none (ui).
 *
 * Why this exists: the v2 ui is otherwise styled with inline react style objects
 * (the established convention; no .css files in the tree). A handful of things
 * cannot be expressed inline: @font-face, the cloud-backdrop geometry, and, most
 * importantly, interactive pseudo-states (:hover / :active / :disabled) and
 * ::-webkit-scrollbar / ::placeholder. Inline styles also win the cascade over
 * stylesheet rules, so a button whose base background is inline can never show a
 * :hover background. The fix used here: interactive controls (buttons, inputs,
 * the mode toggle) are styled entirely by the classes below so their pseudo-states
 * work, while structural layout stays inline. App.tsx injects this once on mount,
 * keeping index.html bare ("the bundle owns all markup"). Values come from
 * theme.ts so inline styles and these rules never drift.
 */
import { COLORS, FONT_CODE, FONT_UI, RADIUS, STATE, SURFACE, EASE_UI } from './theme';

/** The id of the single injected <style> element (idempotency guard). */
const STYLE_ID = 'snipcode-global-css';

/**
 * The full stylesheet, built from theme tokens. Font unicode-ranges are copied
 * from v1's fonts.css so latin + latin-ext subsets load identically.
 */
export const GLOBAL_CSS = `
/* ---- fonts (self-hosted, served from the extension origin at /fonts) ---- */
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

/* ---- reset + global ---- */
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

/* ---- cloud backdrop (geometry only; per-cloud values are inline in CloudBackdrop) ---- */
.cloud-backdrop { position: fixed; inset: 0; overflow: hidden; pointer-events: none; z-index: 0; opacity: 0.4; }
.cloud-sky { position: absolute; inset: 0; background: linear-gradient(to bottom, ${COLORS.sky0} 0%, ${COLORS.sky1} 45%, ${COLORS.sky2} 70%, ${COLORS.sky3} 100%); }
.cloud-field { position: absolute; inset: 0; }
.cloud-cluster { position: absolute; }
.cloud-piece { position: absolute; border-radius: 50%; }

/* ---- buttons (styled fully by class so pseudo-states win over no inline base) ---- */
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
	color: rgba(255, 255, 255, 0.95);
	background: ${SURFACE.primary};
	border: 1px solid rgba(255, 255, 255, 0.1);
}
.sc-btn-primary:hover:not(:disabled) { background: ${SURFACE.primaryHover}; }
.sc-btn-primary:active:not(:disabled) { transform: scale(0.985); opacity: 0.9; }
.sc-btn-secondary {
	height: 46px;
	border-radius: ${RADIUS.xl}px;
	font-size: 14px;
	color: rgba(71, 85, 105, 0.9);
	background: ${SURFACE.control};
	border: 1px solid ${SURFACE.borderStrong};
}
.sc-btn-secondary:hover:not(:disabled) { background: ${SURFACE.controlHover}; }
.sc-btn-secondary:active:not(:disabled) { transform: scale(0.985); }
/* Compact modifier for inline actions (e.g. test key) */
.sc-btn-sm { height: 34px; width: auto; padding: 0 14px; font-size: 13px; border-radius: ${RADIUS.md}px; }

/* ---- mode toggle items (snip / assistive) ---- */
.sc-mode {
	flex: 1;
	padding: 9px 10px;
	border: 1px solid ${SURFACE.border};
	border-radius: ${RADIUS.lg}px;
	font-family: ${FONT_UI};
	font-size: 13px;
	font-weight: 600;
	color: ${COLORS.slate600};
	background: ${SURFACE.control};
	cursor: pointer;
	transition: background 0.12s ease, color 0.12s ease;
}
.sc-mode:hover { background: ${SURFACE.controlHover}; }
.sc-mode:disabled { opacity: 0.5; cursor: not-allowed; }
.sc-mode-active { color: ${COLORS.white}; background: ${STATE.modeActive}; border-color: transparent; }
.sc-mode-active:hover { background: ${STATE.modeActive}; }

/* ---- segmented nav tabs (capture / saved / settings) ---- */
.sc-nav {
	flex: 1;
	padding: 8px;
	border: none;
	background: transparent;
	font-family: ${FONT_UI};
	font-size: 13px;
	font-weight: 600;
	color: ${COLORS.slate500};
	cursor: pointer;
	border-bottom: 2px solid transparent;
	transition: color 0.15s ${EASE_UI}, border-color 0.15s ${EASE_UI};
}
.sc-nav:hover { color: ${COLORS.slate700}; }
.sc-nav-active { color: ${COLORS.slate900}; border-bottom-color: ${COLORS.slate900}; }

/* ---- file tabs (index.html / icon-1.svg / image-1.png) ---- */
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

/* ---- icon buttons (copy / save / more / overflow) ---- */
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
.sc-icon-btn-saved { color: ${COLORS.accent}; cursor: default; }
.sc-icon-btn-saved:hover { color: ${COLORS.accent}; background: transparent; }

/* ---- inputs + selects ---- */
.sc-input {
	width: 100%;
	padding: 7px 9px;
	font-family: ${FONT_UI};
	font-size: 13px;
	color: ${COLORS.slate800};
	background: rgba(255, 255, 255, 0.7);
	border: 1px solid ${SURFACE.borderStrong};
	border-radius: ${RADIUS.md}px;
	box-sizing: border-box;
	transition: border-color 0.15s ${EASE_UI}, box-shadow 0.15s ${EASE_UI};
}
.sc-input:focus { outline: none; border-color: ${COLORS.accent}; box-shadow: 0 0 0 3px ${STATE.focusRing}; }
.sc-input::placeholder { color: ${COLORS.slate400}; }

/* ---- thin scrollbar for the code display ---- */
.sc-scroll { scrollbar-width: thin; scrollbar-color: ${STATE.scrollThumb} transparent; }
.sc-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
.sc-scroll::-webkit-scrollbar-track { background: transparent; }
.sc-scroll::-webkit-scrollbar-thumb { background: ${STATE.scrollThumb}; border-radius: 3px; }
.sc-scroll::-webkit-scrollbar-thumb:hover { background: ${STATE.scrollThumbHover}; }
`;

/**
 * Injects {@link GLOBAL_CSS} once into the document head. Idempotent: a second
 * call (e.g. a hot-reload or a re-mount) finds the existing style by id and
 * no-ops, so the rules are never duplicated.
 */
export function injectGlobalCss(): void {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = GLOBAL_CSS;
	document.head.appendChild(style);
}
