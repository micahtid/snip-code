/**
 * content/types.ts: the shared contracts that bind every pipeline phase
 *
 * Pipeline position: spans every phase; the type every phase reads/writes
 * Reads from Captured: n/a; defines it
 * Writes to Captured: n/a; defines it
 *
 * Principles applied: none; type definitions only.
 *
 * Why this exists: the entire extension is a pipeline that threads one mutable
 * object (`Captured`) through five phases. Defining that object, plus the
 * message envelope and the storage schemas, in
 * one place is what lets the phases stay decoupled: each phase only needs to
 * know the shape, not the other phases. These definitions are the canonical
 * contract and must not drift; deviations break
 * inter-module assumptions.
 *
 * Feature handlers (src/content/reconcile/features/*) may extend `Captured` via
 * typescript module augmentation in a paired `<module>.d.ts`, but only with a
 * header comment declaring which phase reads the new field.
 */

// ---------------------------------------------------------------------------
// The Captured object
// ---------------------------------------------------------------------------

/** The shared object that flows through the whole pipeline. */
export interface Captured {
	// Page metadata
	page: {
		url: string;
		title: string;
		viewport: { width: number; height: number; devicePixelRatio: number };
		userAgent: string;
	};
	capturedAt: string; // Iso 8601

	// Element metadata, also used by assistive mode
	element: {
		tagName: string;
		selector: string; // Shortest unique css selector
		robustSelector: string; // Prefers data-* and stable ids
		xpath: string;
		boundingBox: { x: number; y: number; w: number; h: number };
		innerText: string;
		innerTextSnippet: string; // First 200 chars
		classList: string[];
		id: string | null;
		ancestors: Array<{ tagName: string; selector: string; role?: string }>;
	};

	// Captured pixels
	screenshot: string; // "Data:image/png;base64,..."

	// Dom: only valid during capture + reconcile phases; serialized at html emit
	root: Element; // Original element reference; live dom
	clone: Element; // Detached working copy that bake.ts mutates

	// Css
	stylesheets: Stylesheet[];
	foundationRules: CssRule[]; // Broadly-scoped rules: body, html, *, etc
	componentRules: CssRule[]; // Element-scoped rules
	variables: CssVariable[];
	fonts: FontFace[];
	keyframes: Keyframes[];

	// Accessibility / inaccessibility notes: warnings only, never block
	inaccessible: {
		crossOriginStylesheets: string[]; // Hrefs we couldn't read
		closedShadowRoots: number; // Count of cdp-pierce failures
	};

	// Reconciliation working state: populated by bake.ts, consumed by emit
	bakedStyles: Map<Element, Map<string, string>>;

	// Interactive states measured by forcing them live: capture phase writes via
	// capture/states-measure.ts; reconcile phase reads via reconcile/features/states.ts.
	// Null means measurement did not run for this snip because cdp was unavailable, and states.ts
	// falls back to copying authored rules; an empty array means measurement ran and found
	// no in-subtree state effect.
	measuredStates: MeasuredState[] | null;

	// Warnings accumulated across phases: never throw, always append
	warnings: string[];
}

/** One property whose computed value changed under a forced interactive state. */
export interface MeasuredStateDecl {
	/** The longhand or shorthand property name. */
	property: string;
	/** The concrete computed literal read under the forced state, already cascade- and
	 * inheritance-resolved by the engine, so no var()/cascade work remains downstream. */
	value: string;
}

/** One layer of one element the forced state restyled, with the properties that changed. */
export interface MeasuredAffected {
	/** The original live element; reconcile maps it to its clone via pairedSubtrees. */
	element: Element;
	/** The layer the delta lives on: '' for the element box, '::before'/'::after' for a generated
	 * box whose own computed style changed, such as a glow/underline/reveal a pseudo-element carries. */
	pseudoElement?: string;
	/** The properties whose computed value differs from rest under the forced state. */
	decls: MeasuredStateDecl[];
}

/** One forced activation of a trigger in an interactive state, and everything it restyled. */
export interface MeasuredState {
	/** The original element whose state was forced: the bearer of the dynamic pseudo. */
	trigger: Element;
	/** The dynamic pseudos forced together, colon form, e.g. `[':hover']` or `[':focus-visible']`. */
	states: string[];
	/** The trigger plus any descendant/sibling whose computed value changed under the force. */
	affected: MeasuredAffected[];
}

/** Metadata about one discovered stylesheet, not its rules; those are flattened into CssRule[]. */
export interface Stylesheet {
	href: string | null;
	origin: 'same-origin' | 'cross-origin' | 'inline' | 'shadow';
	ruleCount: number;
}

/** One style rule flattened out of any sheet, with its grouping context preserved. */
export interface CssRule {
	selector: string;
	properties: Map<string, string>;
	specificity: number; // Standard formula: a*10000 + b*100 + c
	mediaQuery?: string; // Populated if rule lives inside @media
	containerQuery?: string; // Populated if inside @container
	layer?: string; // Populated if inside @layer
	supports?: string; // Populated if inside @supports
	source: 'cssom' | 'cdp' | 'inline' | 'shadow';
}

/** A captured custom property, either already resolved or pending literal resolution. */
export interface CssVariable {
	name: string; // Includes leading "--"
	value: string; // Either resolved or literal-pending
	resolved: boolean;
	scope: 'root' | 'element' | 'shadow-host';
}

/** An @font-face rule, family + src + all descriptors. */
export interface FontFace {
	family: string;
	src: string;
	descriptors: Record<string, string>; // Font-weight, font-style, unicode-range, font-display, etc
}

/** A named @keyframes block, body serialized for re-emission. */
export interface Keyframes {
	name: string;
	rules: string; // Serialized @keyframes body
}

// ---------------------------------------------------------------------------
// Message protocol
// ---------------------------------------------------------------------------

/**
 * The type discriminator for every request/response broker message, the `type`
 * field of `Envelope`, each handled by the background service worker.
 */
export type MessageType =
	| 'CAPTURE_SCREENSHOT'
	| 'FETCH_STYLESHEET'
	| 'FETCH_BINARY'
	| 'LLM_REQUEST'
	| 'CDP_INHERITED'
	| 'CDP_STYLESHEETS'
	| 'CDP_FORCE_BEGIN'
	| 'CDP_FORCE_STATE'
	| 'CDP_FORCE_END';

/**
 * One-way, fire-and-forget signals between the side panel and the content script.
 * These are NOT members of `MessageType`; that union is only for the request/response
 * broker `Envelope`. They carry no requestId and expect no Response. They live here,
 * exported once, so sender and receiver share the exact string and a single typo can
 * never silently drop the message.
 */
export const START_SCAN = 'SNIPCODE_START_SCAN';
/** Carries one InspectResult, plus optional token usage, from the scan back to the panel. */
export const INSPECT_RESULT = 'INSPECT_RESULT';
/** The panel asks the content script to start the element picker overlay. */
export const START_PICKER = 'SNIPCODE_START_PICKER';
/** The panel asks the content script to tear the picker overlay down on panel-side esc. */
export const CANCEL_PICKER = 'SNIPCODE_CANCEL_PICKER';
/** Carries a finished snip result from the content script back to the panel. */
export const SNIP_RESULT = 'SNIP_RESULT';

/** The request envelope shared by all messages. requestId correlates responses. */
export interface Envelope<TPayload, TResult = unknown> {
	type: MessageType;
	requestId: string; // Uuid v4, used for response correlation
	payload: TPayload;
	// TResult is part of the documented contract so callers can
	// annotate the response type they expect; it is intentionally phantom here.
	__result?: TResult;
}

/** The response envelope. `ok` gates whether `result` or `error` is populated. */
export interface Response<TResult> {
	requestId: string;
	ok: boolean;
	result?: TResult;
	error?: { code: ErrorCode; message: string };
}

/** Stable error codes returned across contexts. */
export type ErrorCode =
	| 'INVALID_SELECTOR'
	| 'CORS_BLOCKED'
	| 'NO_KEY_CONFIGURED'
	| `PROVIDER_ERROR_${number}`
	| 'STORAGE_QUOTA'
	| 'MALFORMED_REQUEST';

/** The byok providers supported one-at-a-time. */
export type Provider = 'openrouter' | 'anthropic' | 'openai' | 'google';

// ---------------------------------------------------------------------------
// Storage schemas
// ---------------------------------------------------------------------------

/** The 7 output formats. */
export type OutputFormat = 'tailwind' | 'bem-css' | 'bem-scss' | 'jsx-tailwind' | 'jsx-css' | 'vue' | 'html';

/**
 * One file in a split snip result: the index.html document plus the inline svgs
 * and data-uri images lifted out into their own referenced files (convert/assets.ts).
 * Text files, html/svg/json, carry `text`; image files carry the original `dataUrl`
 * so the panel can render them.
 */
export interface AssetFile {
	name: string; // 'index.html', 'icon-1.svg', 'image-1.png'
	language: 'html' | 'svg' | 'image' | 'json';
	text?: string; // Source for text files
	dataUrl?: string; // Original data: url for image files
}

/**
 * Token usage reported by a provider for one polish call, the only billed ai
 * step. Counts are exact, read straight from the response; dollars are not
 * tracked because providers return tokens, not cost, and per-model rates vary.
 */
export interface TokenUsage {
	input: number;
	output: number;
}

/** One stored snippet; last 50, fifo. */
export interface SnippetRecord {
	id: string; // Uuid v4
	capturedAt: string;
	page: Captured['page'];
	element: Captured['element'];
	output: { format: OutputFormat; html: string; css?: string; jsx?: string };
	screenshot: string; // Data url thumbnail (<=200x200)
}

/** User preferences. Byok keys live separately under `byok.<provider>`, never here. */
export interface UserPreferences {
	activeProvider: Provider;
	modelOverrides: Record<Provider, string | null>;
	defaultMode: 'snip' | 'assistive';
	defaultOutput: OutputFormat;
	assistiveDelivery: Array<'clipboard' | 'file' | 'webhook'>;
	webhookUrl: string | null;
}
