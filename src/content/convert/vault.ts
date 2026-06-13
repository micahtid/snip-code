/**
 * convert/vault.ts: verbatim data vault
 *
 * Pipeline position: convert (stash) and polish (restore)
 * Reads from Captured: nothing (operates on the emitted code string)
 * Writes to Captured: nothing (the caller owns the vault instance)
 *
 * A token-economy mechanism.
 *
 * Why this exists: the llm polish step is text-only and bills per
 * token, and some values are both token-heavy and fragile: inline svgs, long
 * urls, gradients, multi-layer shadows, transitions, filters. Replacing them with
 * short @@V*@@ placeholders before the llm sees them cuts tokens and makes it
 * impossible for the model to corrupt data it never sees; restore() swaps the
 * originals back afterward. Html and css are vaulted with separate patterns so a
 * css regex never matches inside an html attribute (e.g. a tailwind arbitrary
 * value). Ported (rewritten) verbatim from v1 verbatim-vault.ts; the one fix is
 * restore() using split/join instead of String.replace so a vaulted value
 * containing "$" cannot be mangled by replacement-pattern interpretation.
 */

/** Stashes fragile/token-heavy substrings behind @@V*@@ placeholders, reversibly. */
export class VerbatimVault {
	private readonly vault = new Map<string, string>();
	private counter = 0;

	/** The next unique placeholder token. */
	private nextPlaceholder(): string {
		return `@@V${++this.counter}@@`;
	}

	/**
	 * Vaults an entire block (e.g. a whole css block) behind one placeholder.
	 *
	 * @param content - the block to stash
	 * @returns the placeholder standing in for it
	 */
	protectBlock(content: string): string {
		const placeholder = this.nextPlaceholder();
		this.vault.set(placeholder, content);
		return placeholder;
	}

	/**
	 * Replaces fragile and token-heavy content with placeholders. Two phases:
	 * html-element patterns first (svg, path data, long urls), then css values,
	 * only inside <style> blocks, so html attributes are never touched.
	 *
	 * @param code - the emitted document string
	 * @returns the same string with originals swapped for placeholders
	 */
	protect(code: string): string {
		let result = code;

		// Phase 1, html element vaulting (patterns that only match html).

		// Whole <svg>...</svg> blocks regardless of size: the biggest token sink.
		result = result.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, (match) => this.stash(match));

		// Svg d="..." Path data not already caught inside a vaulted <svg>.
		result = result.replace(/\bd="([^"]{10,})"/g, (_m, pathData: string) => `d="${this.stash(pathData)}"`);

		// Svg points="..." On polyline/polygon.
		result = result.replace(/\bpoints="([^"]{10,})"/g, (_m, points: string) => `points="${this.stash(points)}"`);

		// Long http(s) urls in src/href attributes.
		result = result.replace(
			/\b(src|href)="(https?:\/\/[^"]{60,})"/g,
			(_m, attr: string, url: string) => `${attr}="${this.stash(url)}"`,
		);

		// Phase 2, css value vaulting, scoped to <style> blocks only.
		result = result.replace(
			/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi,
			(_m, open: string, cssContent: string, close: string) => `${open}${this.vaultCssValues(cssContent)}${close}`,
		);

		return result;
	}

	/**
	 * Vaults fragile css values inside a css string. Safe because it only ever
	 * runs on css content, never on html attributes.
	 *
	 * @param css - css text (the body of a <style> block)
	 */
	private vaultCssValues(css: string): string {
		let result = css;

		// Multi-layer box-shadow (3+ layers): heavy and easy for an llm to garble.
		result = result.replace(/box-shadow:\s*([^;}{]+)/g, (match, value: string) => {
			const commasOutsideParens = value.replace(/\([^)]*\)/g, '').match(/,/g);
			if (!commasOutsideParens || commasOutsideParens.length < 2) return match;
			return `box-shadow: ${this.stash(value.trim())}`;
		});

		// Gradients (linear/radial/conic).
		result = result.replace(
			/(background(?:-image)?:\s*)((?:linear|radial|conic)-gradient\([^;}{]+\))/g,
			(_m, prefix: string, gradient: string) => `${prefix}${this.stash(gradient.trim())}`,
		);

		// Transition values (skip the trivial `none`).
		result = result.replace(/transition:\s*([^;}{]+)/g, (match, value: string) => {
			if (/^none$/i.test(value.trim())) return match;
			return `transition: ${this.stash(value.trim())}`;
		});

		// Filter / backdrop-filter values (skip `none`).
		result = result.replace(/((?:backdrop-)?filter):\s*([^;}{]+)/g, (match, prop: string, value: string) => {
			if (/^none$/i.test(value.trim())) return match;
			return `${prop}: ${this.stash(value.trim())}`;
		});

		// Strip --tw-* boilerplate that resolves to initial/empty values, except in
		// interactive-state rules where those vars are the animation targets.
		result = result.replace(/([^{}]*?)(\{)([^}]*)(})/g, (whole, selector: string, open: string, body: string, close: string) => {
			if (/:(hover|focus|active|focus-visible|focus-within)/i.test(selector)) return whole;
			const cleaned = body.replace(
				/\s*--tw-[\w-]+:\s*(?:0(?:px)?|1|none|0 0 #0000|initial|''|transparent|)(?=\s*[;}\n])\s*;?/g,
				'',
			);
			return cleaned === body ? whole : `${selector}${open}${cleaned}${close}`;
		});

		return result;
	}

	/**
	 * Strips the html document wrapper (doctype/html/head/body) for token economy
	 * before sending to the llm.
	 *
	 * @param code - a full or partial document string
	 */
	stripDocumentWrapper(code: string): string {
		return code
			.replace(/<!DOCTYPE[^>]*>/i, '')
			.replace(/<html[^>]*>/i, '')
			.replace(/<\/html>/i, '')
			.replace(/<head>[\s\S]*?<\/head>/i, '')
			.replace(/<body[^>]*>/i, '')
			.replace(/<\/body>/i, '')
			.trim();
	}

	/**
	 * Restores every placeholder back to its original value.
	 *
	 * Uses split/join (not String.replace) so a vaulted value containing "$" is
	 * inserted literally, never interpreted as a replacement pattern.
	 *
	 * @param code - llm output (or any string) carrying placeholders
	 */
	restore(code: string): string {
		let result = code;
		for (const [placeholder, original] of this.vault) {
			result = result.split(placeholder).join(original);
		}
		return result;
	}

	/** A copy of the vault map, for post-llm verification. */
	getVaultMap(): Map<string, string> {
		return new Map(this.vault);
	}

	/** Placeholders that are still present in `code` (i.e. not yet restored). */
	getUnrestoredPlaceholders(code: string): string[] {
		const remaining: string[] = [];
		for (const placeholder of this.vault.keys()) {
			if (code.includes(placeholder)) remaining.push(placeholder);
		}
		return remaining;
	}

	/** Number of items currently vaulted. */
	get size(): number {
		return this.vault.size;
	}

	/** Stash one value and return its placeholder. */
	private stash(value: string): string {
		const placeholder = this.nextPlaceholder();
		this.vault.set(placeholder, value);
		return placeholder;
	}
}
