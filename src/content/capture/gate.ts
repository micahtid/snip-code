/**
 * capture/gate.ts: website-builder gate
 *
 * Phase: b (capture), see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: 1, capture (final step; refuses unsupported pages)
 * Reads from Captured: root (runs before Captured exists, on the live element)
 * Writes to Captured: n/a (gates the pipeline before it builds Captured)
 *
 * Principles applied: none (a locked product gate, decision 5).
 *
 * Why this exists: framer / wix / webflow / elementor / readymag render runtime-
 * dependent, non-portable markup (scale-to-fit transforms, hashed class soups,
 * sprite refs to document-root <symbol>s). snipping them produces broken output,
 * so v2 refuses with a static "unsupported" message instead of degrading
 * silently (decision 5, no fallback). detection is purely structural: data-*
 * rendering-chrome attributes and class-name fingerprints, sampled from a
 * bounded subtree walk. ported (rewritten) from v1 vision/builder-detection.ts;
 * the v1 version routed to a vision model, v2 drops that path and blocks.
 *
 * note: the runtime Set in collectSampleClassNames dedups sampled class names; it
 * is not a hardcoded tag/role/property enumeration, so it does not fall under
 * forbidden pattern #1.
 */

/** the builders v2 refuses, plus the not-a-builder sentinel. */
export type BuilderName = 'framer' | 'wix' | 'webflow' | 'elementor' | 'readymag' | 'unknown';

/** one weighted fingerprint hit, kept for diagnostics. */
interface GateSignal {
	id: string;
	description: string;
	weight: number;
}

/** the gate verdict the orchestrator acts on. */
export interface GateResult {
	/** true when the page is an unsupported builder and the snip must be refused. */
	blocked: boolean;
	builder: BuilderName;
	confidence: number; // [0..1]
	/** the static user-facing refusal, present only when blocked. */
	message?: string;
}

// a single strong rendering-chrome signal (weight 0.4-0.5) clears this, so one
// unambiguous fingerprint is enough to block. mirrors v1's routing threshold.
const BLOCK_THRESHOLD = 0.4;
// the dominant builder must own at least this much weight to be named (vs noise).
const NAME_THRESHOLD = 0.3;

/**
 * classifies the picked element's page and decides whether to refuse the snip.
 *
 * sums weighted fingerprints per builder, takes the dominant family, and blocks
 * when its confidence clears BLOCK_THRESHOLD. cheap enough (one bounded dom walk)
 * to run unconditionally on every snip.
 *
 * @param root - the live picked element
 * @returns the gate verdict; `blocked` gates the rest of the pipeline
 */
export function detectBuilder(root: Element): GateResult {
	const classes = collectSampleClassNames(root, 50);
	const totals: Record<Exclude<BuilderName, 'unknown'>, number> = {
		framer: sum(detectFramer(root, classes)),
		wix: sum(detectWix(root, classes)),
		webflow: sum(detectWebflow(root, classes)),
		elementor: sum(detectElementor(root, classes)),
		readymag: sum(detectReadymag(classes)),
	};

	let builder: BuilderName = 'unknown';
	let top = 0;
	for (const [name, total] of Object.entries(totals)) {
		if (total > top) {
			top = total;
			builder = name as BuilderName;
		}
	}

	const confidence = Math.min(1, top);
	// only name a builder when its signal is meaningful, not incidental noise.
	if (builder !== 'unknown' && top < NAME_THRESHOLD) builder = 'unknown';
	const blocked = builder !== 'unknown' && confidence >= BLOCK_THRESHOLD;

	return blocked
		? { blocked, builder, confidence, message: unsupportedMessage(builder) }
		: { blocked: false, builder, confidence };
}

/** the static refusal text (decision 5: no fallback, just an honest message). */
function unsupportedMessage(builder: BuilderName): string {
	const label = builder.charAt(0).toUpperCase() + builder.slice(1);
	return (
		`this page is built with ${label}, which snipcode does not support. ` +
		`${label} renders runtime-dependent markup (scale-to-fit transforms, generated class hashes, ` +
		`out-of-subtree sprite references) that cannot be snipped into clean, portable code. ` +
		`try snipping a hand-coded page instead.`
	);
}

/** framer: data-framer-* rendering chrome + framer-* class prefixes. */
function detectFramer(root: Element, classes: string[]): GateSignal[] {
	const signals: GateSignal[] = [];
	if (root.hasAttribute('data-framer-name') || root.querySelector('[data-framer-name]')) {
		signals.push({ id: 'framer-name-attr', description: 'data-framer-name present', weight: 0.5 });
	}
	if (root.hasAttribute('data-framer-component-type') || root.querySelector('[data-framer-component-type]')) {
		signals.push({ id: 'framer-component-type', description: 'data-framer-component-type present', weight: 0.4 });
	}
	if (classes.some((c) => /^framer-[A-Za-z0-9]/.test(c))) {
		signals.push({ id: 'framer-class-prefix', description: 'framer-* class prefix', weight: 0.3 });
	}
	if (classes.some((c) => /^framer-styles-preset-/.test(c))) {
		signals.push({ id: 'framer-styles-preset', description: 'framer typography preset class', weight: 0.2 });
	}
	return signals;
}

/** wix: _wix-/_Capitalized_ class soups, data-mesh-id, comp-* prefixes. */
function detectWix(root: Element, classes: string[]): GateSignal[] {
	const signals: GateSignal[] = [];
	if (classes.some((c) => /^_wix-/.test(c) || /^_[A-Z][a-zA-Z0-9]+_/.test(c))) {
		signals.push({ id: 'wix-class-pattern', description: 'wix class naming pattern', weight: 0.4 });
	}
	if (root.hasAttribute('data-mesh-id') || root.querySelector('[data-mesh-id]')) {
		signals.push({ id: 'wix-mesh-id', description: 'data-mesh-id present (wix classic)', weight: 0.4 });
	}
	if (classes.some((c) => /^comp-/.test(c))) {
		signals.push({ id: 'wix-comp-prefix', description: 'comp-* class prefix', weight: 0.2 });
	}
	return signals;
}

/** webflow: data-w-id + w-{button|nav|container|row|col|tab} utility classes. */
function detectWebflow(root: Element, classes: string[]): GateSignal[] {
	const signals: GateSignal[] = [];
	if (root.hasAttribute('data-w-id') || root.querySelector('[data-w-id]')) {
		signals.push({ id: 'webflow-data-w-id', description: 'data-w-id present', weight: 0.4 });
	}
	if (classes.some((c) => /^w-(button|nav|container|row|col|tab)/.test(c))) {
		signals.push({ id: 'webflow-class-prefix', description: 'w-* utility class', weight: 0.3 });
	}
	return signals;
}

/** elementor: data-elementor-type + elementor-* class prefix. */
function detectElementor(root: Element, classes: string[]): GateSignal[] {
	const signals: GateSignal[] = [];
	if (root.hasAttribute('data-elementor-type') || root.querySelector('[data-elementor-type]')) {
		signals.push({ id: 'elementor-data-attr', description: 'data-elementor-type present', weight: 0.5 });
	}
	if (classes.some((c) => /^elementor-/.test(c))) {
		signals.push({ id: 'elementor-class-prefix', description: 'elementor-* class prefix', weight: 0.4 });
	}
	return signals;
}

/** readymag: rmgs-/rmgr- class prefixes (readymag-only convention). */
function detectReadymag(classes: string[]): GateSignal[] {
	if (classes.some((c) => /^rmgs-/.test(c) || /^rmgr-/.test(c))) {
		return [{ id: 'readymag-class-prefix', description: 'rmgs-/rmgr- class prefix', weight: 0.5 }];
	}
	return [];
}

/** sum the weights of a builder's signals. */
function sum(signals: GateSignal[]): number {
	return signals.reduce((acc, s) => acc + s.weight, 0);
}

/**
 * collects up to `cap` distinct class names from a bounded subtree walk.
 *
 * caps both the result set and the traversal stack so detection stays cheap on
 * enormous pages. all fingerprint regexes test against this bounded sample.
 *
 * @param root - subtree to sample
 * @param cap - max distinct class names to collect
 */
function collectSampleClassNames(root: Element, cap: number): string[] {
	const seen = new Set<string>();
	const stack: Element[] = [root];
	while (stack.length > 0 && seen.size < cap) {
		const el = stack.pop();
		if (!el) break;
		const className = (el.getAttribute('class') ?? '').trim();
		if (className) {
			for (const c of className.split(/\s+/)) {
				seen.add(c);
				if (seen.size >= cap) break;
			}
		}
		for (let i = el.children.length - 1; i >= 0 && stack.length < 200; i--) {
			const child = el.children[i];
			if (child) stack.push(child);
		}
	}
	return [...seen];
}
