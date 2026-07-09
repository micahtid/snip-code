/**
 * reconcile/properties.ts: registered custom properties (@property)
 *
 * Pipeline position: reconcile, a leaf utility read live from the cssom
 * Reads from Captured: nothing, it reads document.styleSheets directly
 * Writes to Captured: nothing, it is a pure read
 *
 * It exists because a custom property registered with `@property` carries a syntax, an
 * inherits flag, and often an initial-value that govern how it falls back and
 * interpolates. Two phases need that registration. features/layers.ts re-emits the
 * rules so the artifact keeps the behavior, and resolve/vars.ts treats a registered
 * property with an initial-value as resolvable, since a `var()` to it yields its initial
 * even when nothing sets it, so a state rule referencing it renders standalone. The two
 * shared this scan rather than walk the cssom twice with copied logic.
 *
 * CSSPropertyRule is not in every dom lib version, so the rule is detected
 * structurally by its descriptor fields, exactly as before.
 */

/** One registered @property: its name, its initial-value or null when none, and its source text. */
export interface RegisteredProperty {
	/** The custom-property name, including the leading `--`. */
	name: string;
	/** The registered initial-value, or null when the registration declares none. */
	initialValue: string | null;
	/** The rule's serialized text, for re-emission. */
	cssText: string;
}

/**
 * The custom properties registered via `@property` anywhere in the document, keyed by
 * name. Cross-origin sheets that cannot be read are skipped: their registrations are
 * unreadable from the content script, the same boundary every cssom read accepts.
 *
 * @returns a name -> registration map
 */
export function registeredProperties(): Map<string, RegisteredProperty> {
	const out = new Map<string, RegisteredProperty>();
	for (const sheet of Array.from(document.styleSheets)) {
		let rules: CSSRuleList;
		try {
			rules = sheet.cssRules;
		} catch {
			continue; // Cross-origin sheet, cannot read.
		}
		collect(rules, out);
	}
	return out;
}

/** Recursively collect @property registrations (CSSPropertyRule), detected structurally. */
function collect(rules: CSSRuleList, out: Map<string, RegisteredProperty>): void {
	for (const rule of Array.from(rules)) {
		const r = rule as unknown as { name?: unknown; syntax?: unknown; inherits?: unknown; initialValue?: unknown; cssText?: string };
		if (typeof r.name === 'string' && typeof r.syntax === 'string' && r.name.startsWith('--')) {
			const initialValue = typeof r.initialValue === 'string' && r.initialValue !== '' ? r.initialValue : null;
			out.set(r.name, { name: r.name, initialValue, cssText: r.cssText ?? serialize(r, initialValue) });
		} else if ('cssRules' in rule && (rule as { cssRules?: unknown }).cssRules instanceof CSSRuleList) {
			collect((rule as CSSRule & { cssRules: CSSRuleList }).cssRules, out);
		}
	}
}

/** Fallback serializer for an @property rule when cssText is unavailable. */
function serialize(r: { name?: unknown; syntax?: unknown; inherits?: unknown }, initialValue: string | null): string {
	const initial = initialValue ? `\n\tinitial-value: ${initialValue};` : '';
	return `@property ${String(r.name)} {\n\tsyntax: ${String(r.syntax)};\n\tinherits: ${String(r.inherits)};${initial}\n}`;
}
