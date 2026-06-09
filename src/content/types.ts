/**
 * content/types.ts — the shared contracts that bind every pipeline phase
 *
 * Phase: b (capture) — see SNIPCODE-REWRITE-PLAN.md section 12 for phase map
 * Pipeline position: spans 1-5 (the type every phase reads/writes)
 * Reads from Captured: n/a (defines it)
 * Writes to Captured: n/a (defines it)
 *
 * Principles applied: none (type definitions).
 *
 * Why this exists: the entire extension is a pipeline that threads one mutable
 * object (`Captured`) through five phases. defining that object — plus the
 * message envelope (section 19.2) and the storage schemas (section 19.10) — in
 * one place is what lets the phases stay decoupled: each phase only needs to
 * know the shape, not the other phases. these definitions are copied verbatim
 * from the build spec (section 19.1) and must not drift; deviations break
 * inter-module assumptions.
 *
 * feature handlers (src/content/reconcile/features/*) may extend `Captured` via
 * typescript module augmentation in a paired `<module>.d.ts`, but only with a
 * header comment declaring which phase reads the new field (section 19.1).
 */

// ---------------------------------------------------------------------------
// the Captured object (section 19.1)
// ---------------------------------------------------------------------------

/** the shared object that flows through pipeline phases 1-5. */
export interface Captured {
	// page metadata
	page: {
		url: string;
		title: string;
		viewport: { width: number; height: number; devicePixelRatio: number };
		userAgent: string;
	};
	capturedAt: string; // iso 8601

	// element metadata (also used by assistive mode, section 9)
	element: {
		tagName: string;
		selector: string; // shortest unique css selector
		robustSelector: string; // prefers data-* and stable ids
		xpath: string;
		boundingBox: { x: number; y: number; w: number; h: number };
		innerText: string;
		innerTextSnippet: string; // first 200 chars
		classList: string[];
		id: string | null;
		ancestors: Array<{ tagName: string; selector: string; role?: string }>;
	};

	// captured pixels
	screenshot: string; // "data:image/png;base64,..."

	// dom (only valid during capture + reconcile phases; serialized at html emit)
	root: Element; // original element reference (live dom)
	clone: Element; // detached working copy that bake.ts mutates

	// css
	stylesheets: Stylesheet[];
	foundationRules: CssRule[]; // broadly-scoped rules (body, html, *, etc)
	componentRules: CssRule[]; // element-scoped rules
	variables: CssVariable[];
	fonts: FontFace[];
	keyframes: Keyframes[];

	// accessibility / inaccessibility notes (warnings only, never block)
	inaccessible: {
		crossOriginStylesheets: string[]; // hrefs we couldn't read
		closedShadowRoots: number; // count of cdp-pierce failures
	};

	// reconciliation working state (populated by bake.ts, consumed by emit)
	bakedStyles: Map<Element, Map<string, string>>;

	// warnings accumulated across phases (never throw; always append)
	warnings: string[];
}

/** metadata about one discovered stylesheet (not its rules — those are flattened into CssRule[]). */
export interface Stylesheet {
	href: string | null;
	origin: 'same-origin' | 'cross-origin' | 'inline' | 'shadow';
	ruleCount: number;
}

/** one style rule flattened out of any sheet, with its grouping context preserved. */
export interface CssRule {
	selector: string;
	properties: Map<string, string>;
	specificity: number; // standard formula: a*10000 + b*100 + c
	mediaQuery?: string; // populated if rule lives inside @media
	containerQuery?: string; // populated if inside @container
	layer?: string; // populated if inside @layer
	supports?: string; // populated if inside @supports
	source: 'cssom' | 'cdp' | 'inline' | 'shadow';
}

/** a captured custom property, either already resolved or pending literal resolution (P3). */
export interface CssVariable {
	name: string; // includes leading "--"
	value: string; // either resolved or literal-pending
	resolved: boolean;
	scope: 'root' | 'element' | 'shadow-host';
}

/** an @font-face rule, family + src + all descriptors. */
export interface FontFace {
	family: string;
	src: string;
	descriptors: Record<string, string>; // font-weight, font-style, unicode-range, font-display, etc
}

/** a named @keyframes block, body serialized for re-emission. */
export interface Keyframes {
	name: string;
	rules: string; // serialized @keyframes body
}

// ---------------------------------------------------------------------------
// message protocol (section 19.2)
// ---------------------------------------------------------------------------

/** the discriminator for every cross-context message. */
export type MessageType =
	| 'HEADLESS_SNIP'
	| 'FETCH_STYLESHEET'
	| 'CAPTURE_SCREENSHOT'
	| 'LLM_REQUEST'
	| 'STORE_SNIPPET'
	| 'LIST_SNIPPETS'
	| 'EXPORT_ALL'
	| 'VALIDATE_KEY'
	| 'GET_PREFS'
	| 'SET_PREFS';

/** the request envelope shared by all messages. requestId correlates responses. */
export interface Envelope<TPayload, TResult = unknown> {
	type: MessageType;
	requestId: string; // uuid v4, used for response correlation
	payload: TPayload;
	// TResult is part of the documented contract (section 19.2) so callers can
	// annotate the response type they expect; it is intentionally phantom here.
	__result?: TResult;
}

/** the response envelope. `ok` gates whether `result` or `error` is populated. */
export interface Response<TResult> {
	requestId: string;
	ok: boolean;
	result?: TResult;
	error?: { code: ErrorCode; message: string };
}

/** stable error codes returned across contexts (section 19.2). */
export type ErrorCode =
	| 'INVALID_SELECTOR'
	| 'CORS_BLOCKED'
	| 'NO_KEY_CONFIGURED'
	| `PROVIDER_ERROR_${number}`
	| 'STORAGE_QUOTA'
	| 'MALFORMED_REQUEST';

/** the byok providers supported one-at-a-time (decision 9). */
export type Provider = 'openrouter' | 'anthropic' | 'openai' | 'google';

// ---------------------------------------------------------------------------
// storage schemas (section 19.10)
// ---------------------------------------------------------------------------

/** the 7 output formats (decision 10). */
export type OutputFormat = 'tailwind' | 'bem-css' | 'bem-scss' | 'jsx-tailwind' | 'jsx-css' | 'vue' | 'html';

/** one stored snippet (last 50, fifo — decision 12). */
export interface SnippetRecord {
	id: string; // uuid v4
	capturedAt: string;
	page: Captured['page'];
	element: Captured['element'];
	output: { format: OutputFormat; html: string; css?: string; jsx?: string };
	screenshot: string; // data url thumbnail (<=200x200)
}

/** user preferences. byok keys live separately under `byok.<provider>`, never here. */
export interface UserPreferences {
	activeProvider: Provider;
	modelOverrides: Record<Provider, string | null>;
	defaultMode: 'snip' | 'assistive';
	defaultOutput: OutputFormat;
	assistiveDelivery: Array<'clipboard' | 'file' | 'webhook'>;
	webhookUrl: string | null;
}
