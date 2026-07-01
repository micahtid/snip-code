/**
 * theme.ts: design tokens for the sidebar ui
 *
 * Pipeline position: n/a; ui foundation, not a pipeline phase
 * Reads from Captured: n/a
 * Writes to Captured: n/a
 *
 * Principles applied: none; ui.
 *
 * Why this exists: the v2 redesign reproduces v1's visual identity: montserrat and
 * jetbrains mono, frosted glass over a procedural cloud sky, slate palette, and
 * gradient/glass buttons. Without a single token source those values would be
 * copied as magic numbers across every component and the injected stylesheet,
 * drifting over time. This module is the one place they live; both the inline
 * style objects and global-css.ts import from here so a palette change lands once.
 */
import type { CSSProperties } from 'react';

/** Font stacks. Montserrat for ui, jetbrains mono for emitted code, matching v1. */
export const FONT_UI = "'Montserrat', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";
export const FONT_CODE = "'JetBrains Mono', 'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace";

/**
 * The slate and accent palette lifted from v1: the tailwind slate scale plus a cyan
 * accent for the saved/active state. Keys read darkest-to-lightest within a hue.
 */
export const COLORS = {
	// Slate scale for text, borders, and surfaces
	slate900: '#0f172a',
	slate800: '#1e293b',
	slate700: '#334155',
	slate600: '#475569',
	slate500: '#64748b',
	slate400: '#94a3b8',
	slate200: '#e2e8f0',
	slate100: '#f1f5f9',
	slate50: '#f8fafc',
	white: '#ffffff',
	// Cyan accent for links and the saved/bookmarked state
	accent: '#0ea5e9',
	// Semantic status for key-validation feedback: success green, error red
	success: '#2e7d32',
	danger: '#c62828',
	// Sky gradient stops for the cloud backdrop
	sky0: '#5c9be0',
	sky1: '#79b2e7',
	sky2: '#9ac6eb',
	sky3: '#fefefe',
} as const;

/** Translucent surface + border values for the frosted-glass panels. */
export const SURFACE = {
	/** Main panel glass; sits over the cloud backdrop. */
	glass: 'rgba(245, 246, 248, 0.4)',
	/** Card / settings surface, more opaque than the panel. */
	card: 'rgba(255, 255, 255, 0.78)',
	/** Secondary button glass. */
	control: 'rgba(255, 255, 255, 0.6)',
	controlHover: 'rgba(255, 255, 255, 0.78)',
	/** Hairline borders. */
	border: 'rgba(226, 232, 240, 0.5)',
	borderStrong: 'rgba(226, 232, 240, 0.8)',
	/** Panel depth shadow, kept minimal: a faint hairline lift, not a drop shadow. */
	shadow: '0 1px 2px rgba(15, 23, 42, 0.05)',
	/** Code-header gradient. */
	headerGradient: 'linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%)',
	/** Primary action button gradient and its hover. */
	primary: 'linear-gradient(135deg, rgba(15, 23, 42, 0.95) 0%, rgba(30, 41, 59, 0.92) 100%)',
	primaryHover: 'linear-gradient(135deg, rgba(30, 41, 59, 0.95) 0%, rgba(51, 65, 85, 0.92) 100%)',
	/** Field background for inputs, selects, and checkboxes. */
	field: 'rgba(255, 255, 255, 0.7)',
	/** Text and hairline border on the dark primary/split controls. */
	onDarkText: 'rgba(255, 255, 255, 0.95)',
	onDarkBorder: 'rgba(255, 255, 255, 0.1)',
	/** Secondary light button text. */
	secondaryText: 'rgba(71, 85, 105, 0.9)',
} as const;

/**
 * Translucent state colors for interactive controls: hover, focus, and scrollbar.
 * Kept as rgba literals here rather than inline in global-css.ts so every magic
 * alpha value has one named home.
 */
export const STATE = {
	iconBtnHover: 'rgba(100, 116, 139, 0.08)',
	focusRing: 'rgba(14, 165, 233, 0.15)',
	scrollThumb: 'rgba(203, 213, 225, 0.5)',
	scrollThumbHover: 'rgba(148, 163, 184, 0.6)',
	/** Hover and press tints layered on the dark split action: main vs chevron. */
	onDarkHover: 'rgba(255, 255, 255, 0.07)',
	onDarkHoverStrong: 'rgba(255, 255, 255, 0.1)',
	/** The 1px divider inside the dark split action. */
	onDarkDivider: 'rgba(255, 255, 255, 0.18)',
	/** Active icon-nav background, a dark tint on the light panel. */
	navActive: 'rgba(15, 23, 42, 0.08)',
} as const;

/** Corner radii in px used across surfaces and controls. */
export const RADIUS = { sm: 6, md: 8, lg: 10, xl: 12 } as const;

/**
 * Transition easings. EASE_UI is material-standard for buttons/menus; EASE_ELASTIC
 * is the spring curve v1 used on the element-selection overlay, a snappy settle.
 */
export const EASE_UI = 'cubic-bezier(0.4, 0, 0.2, 1)';
export const EASE_ELASTIC = 'cubic-bezier(0.22, 1, 0.36, 1)';

/** How long in ms a copy or action button shows its confirmation state before reverting. */
export const FLASH_MS = 1400;

/**
 * Shared view scaffolding so a view's primary action stays pinned while its body
 * scrolls. A view fills the panel's main area as a {@link LAYOUT.column}; its
 * {@link LAYOUT.scroll} region grows and scrolls, and an optional
 * {@link LAYOUT.footer} sits below it and never moves. Consumed by the ViewLayout
 * component so the capture, history, and settings views stay structurally in sync.
 */
export const LAYOUT: Record<'column' | 'scroll' | 'footer', CSSProperties> = {
	/** A view that fills the main area as a vertical column. */
	column: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' },
	/** The scrolling body of a view; grows and sits above any pinned footer. */
	scroll: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px' },
	/** A footer pinned below the scroll body; stays put while the body scrolls. */
	footer: { flexShrink: 0, padding: '12px 14px', borderTop: `1px solid ${SURFACE.border}`, background: SURFACE.glass },
};
