/**
 * convert/bem.ts: inline styles -> bem classes + css/scss
 *
 * Pipeline position: convert
 * Reads from Captured: clone (inline-styled)
 * Writes to Captured: nothing (deep-copies the clone; canonical clone untouched)
 *
 * A format transform of the baked result.
 *
 * Why this exists: the bem-css and bem-scss formats want semantic
 * classes and a separate stylesheet instead of inline styles. This dedups
 * identical declaration sets into shared bem-named classes (block + block__element)
 * and emits either a flat css ruleset or a nested scss block. Like the other
 * emitters it works on a copy of the clone so all 7 formats stay derivable from
 * one capture. Ported (rewritten) from v1 css-to-bem.ts (inline-to-class dedup),
 * dropping the per-case branches.
 *
 * Beyond identical-set dedup, it factors a shared base class out of near-identical
 * rules (see factorBaseClasses): rules sharing a large declaration subset are split
 * into one base class holding the intersection and per-member modifier classes
 * carrying only the differences, so the common declarations ship once. The split is
 * render-neutral by construction (flat equal-specificity selectors, plus a family
 * guard that never separates a shorthand from an overlapping longhand) and fully
 * deterministic, so the output stays byte-stable.
 */
import type { Captured } from '../types';
import { snapValue } from './snap';
import { atRulesCss, type HtmlOutput } from './html';

/** One generated class and the declarations it carries. */
interface ClassRule {
	className: string;
	decls: Array<[string, string]>;
	isRoot: boolean;
}

/**
 * Emits the snip as bem-classed markup plus a css or scss stylesheet.
 *
 * @param captured - read-only; a deep copy of the clone is transformed
 * @param scss - true for nested scss output, false for flat css
 */
export function emitBem(captured: Captured, scss: boolean): HtmlOutput {
	const work = captured.clone.cloneNode(true) as Element;
	const block = sanitize(firstClassOrTag(work)) || 'snip';
	const elements = [work, ...Array.from(work.querySelectorAll('*'))] as HTMLElement[];

	const byDecls = new Map<string, ClassRule>(); // declString -> class (dedup)
	const rules: ClassRule[] = [];
	const tagCounters = new Map<string, number>();

	for (const el of elements) {
		const decls = readDecls(el);
		el.removeAttribute('style');
		if (decls.length === 0) {
			el.removeAttribute('class');
			continue;
		}
		const isRoot = el === work;
		const key = declKey(decls);
		let rule = byDecls.get(key);
		if (!rule) {
			const className = isRoot ? block : uniqueElementClass(block, el.tagName.toLowerCase(), tagCounters);
			rule = { className, decls, isRoot };
			byDecls.set(key, rule);
			rules.push(rule);
		}
		el.setAttribute('class', rule.className);
	}

	// Factor a shared base class out of near-identical rules, demoting each member to
	// a modifier carrying only its differences. Render-neutral by construction, so it
	// runs unconditionally; the screenshot grader is the backstop.
	const { rules: finalRules, renames } = factorBaseClasses(block, rules, tagCounters);
	applyBaseClasses(elements, renames);

	const css = (scss ? scssText(block, finalRules) : cssText(finalRules)) + atRulesAppendix(captured);
	return { html: work.outerHTML, css };
}

/** Read an element's inline declarations, snapping values for cleaner output. */
function readDecls(el: HTMLElement): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	const style = el.style;
	for (let i = 0; i < style.length; i++) {
		const prop = style.item(i);
		if (!prop) continue;
		out.push([prop, snapValue(prop, style.getPropertyValue(prop)).value]);
	}
	return out;
}

/** A stable key over a declaration set so identical sets share one class. */
function declKey(decls: Array<[string, string]>): string {
	return [...decls]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([p, v]) => `${p}:${v}`)
		.join(';');
}

/** A fresh `block__tag-n` class, numbered per tag so names stay readable. */
function uniqueElementClass(block: string, tag: string, counters: Map<string, number>): string {
	const n = (counters.get(tag) ?? 0) + 1;
	counters.set(tag, n);
	return `${block}__${sanitize(tag)}-${n}`;
}

/** A group of rules that share a declaration subset, with that shared intersection. */
interface FactorGroup {
	base: Array<[string, string]>;
	members: ClassRule[];
}

/**
 * Factors a shared base class out of near-identical rules. Groups the non-root rules
 * by the largest [prop, value] intersection they share and, for each group above the
 * overlap/size thresholds, emits a base class holding the intersection and demotes each
 * member to a modifier carrying only its remaining declarations. Every member element
 * then references `base base--modifier` (or just `base` when its modifier is empty).
 *
 * Render-neutral by construction: all selectors are flat single classes of equal
 * specificity, and the family guard (see familyGuardedBase) never splits a
 * shorthand/longhand family across the base and a modifier, so no property appears in
 * both rules for one element and the base-then-modifier order cannot change a used
 * value. The element resolves to exactly its original declaration set.
 *
 * Deterministic for byte-stable output: candidates are processed in class-name order
 * with a fixed greedy intersection, no enumeration-order or random dependence.
 *
 * @param block - the bem block base, used to name the generated base classes
 * @param rules - the deduped class rules; members are mutated into modifiers in place
 * @param counters - per-tag name counters, shared so generated base names stay unique
 * @returns the rules in emission order (each base before its members) and a map from
 *   every grouped member's old class name to its new `base base--modifier` string
 */
function factorBaseClasses(
	block: string,
	rules: ClassRule[],
	counters: Map<string, number>,
): { rules: ClassRule[]; renames: Map<string, string> } {
	const groups = buildGroups(rules);
	if (groups.length === 0) return { rules, renames: new Map() };

	const renames = new Map<string, string>();
	const dropped = new Set<ClassRule>(); // Members whose modifier is empty: base only.
	const baseOf = new Map<ClassRule, ClassRule>(); // Member -> its base rule.

	for (const group of groups) {
		const baseClassName = uniqueElementClass(block, 'group', counters);
		const baseRule: ClassRule = { className: baseClassName, decls: group.base, isRoot: false };
		const baseSet = new Set(group.base.map(([p, v]) => `${p}:${v}`));
		let variant = 0;
		for (const member of group.members) {
			baseOf.set(member, baseRule);
			const modifierDecls = member.decls.filter(([p, v]) => !baseSet.has(`${p}:${v}`));
			const oldClassName = member.className;
			if (modifierDecls.length === 0) {
				// The member's whole set is the base; it needs no modifier rule.
				renames.set(oldClassName, baseClassName);
				dropped.add(member);
				continue;
			}
			variant++;
			const modifierClassName = `${baseClassName}--${variant}`;
			member.className = modifierClassName;
			member.decls = modifierDecls;
			renames.set(oldClassName, `${baseClassName} ${modifierClassName}`);
		}
	}

	// Emit each base immediately before its first member, preserving rule order
	// otherwise, and drop the now-empty members.
	const emitted = new Set<ClassRule>();
	const ordered: ClassRule[] = [];
	for (const rule of rules) {
		const base = baseOf.get(rule);
		if (base && !emitted.has(base)) {
			ordered.push(base);
			emitted.add(base);
		}
		if (!dropped.has(rule)) ordered.push(rule);
	}
	return { rules: ordered, renames };
}

/**
 * Greedily assigns the non-root rules to factor groups. Each unassigned rule in
 * class-name order seeds a group, then every other unassigned rule joins when it still
 * leaves the running intersection at or above the shared-declaration threshold. A group
 * is kept only when it has enough members and the family-guarded base is still large
 * enough; otherwise its seed stays solo. Class-name ordering makes the result
 * deterministic.
 *
 * @param rules - the deduped class rules (root excluded from grouping)
 * @returns the accepted groups, each with its guarded base and members
 */
function buildGroups(rules: ClassRule[]): FactorGroup[] {
	// Richest rules seed first so a dominant pattern (e.g. a button reset) forms its
	// group before a sparse rule can claim its members; ties break by class name so the
	// order stays deterministic.
	const candidates = rules
		.filter((r) => !r.isRoot)
		.sort((a, b) => b.decls.length - a.decls.length || a.className.localeCompare(b.className));
	const assigned = new Set<ClassRule>();
	const groups: FactorGroup[] = [];

	for (const seed of candidates) {
		if (assigned.has(seed)) continue;
		let base = new Map(seed.decls);
		const members = [seed];
		for (const candidate of candidates) {
			if (candidate === seed || assigned.has(candidate)) continue;
			const shared = intersectDecls(base, candidate.decls);
			// Admit a candidate only when the shared set is large enough AND covers most of
			// the candidate's own declarations. A rule that overlaps by just a few generic
			// declarations (a shared font-family, a transition duration) would otherwise
			// pollute the group and shrink the base to those few, leaving the real members
			// duplicating their common declarations across modifiers.
			if (shared.size >= MIN_SHARED_DECLS && shared.size >= candidate.decls.length * MIN_COHESION) {
				base = shared;
				members.push(candidate);
			}
		}
		if (members.length < MIN_GROUP_SIZE) continue;
		const guarded = familyGuardedBase(base, members);
		if (guarded.size < MIN_SHARED_DECLS) continue;
		for (const member of members) assigned.add(member);
		// Order the base by the seed's original declaration order: deterministic, and it
		// preserves intra-family order for the conflict-free families left in the base.
		const baseDecls = seed.decls.filter(([p, v]) => guarded.get(p) === v);
		groups.push({ base: baseDecls, members });
	}
	return groups;
}

/** The [prop, value] pairs shared by an intersection map and a declaration list. */
function intersectDecls(base: Map<string, string>, decls: Array<[string, string]>): Map<string, string> {
	const other = new Map(decls);
	const out = new Map<string, string>();
	for (const [prop, value] of base) {
		if (other.get(prop) === value) out.set(prop, value);
	}
	return out;
}

/**
 * Removes from the candidate base every property whose source order relative to another
 * declaration in the same member is render-significant, so hoisting it into the base
 * (which is emitted before every modifier) while its partner stays in a modifier could
 * reorder them and change the used value. Order matters exactly when two declarations
 * share a longhand: a shorthand and one of the longhands it sets (e.g. `border` and
 * `border-color`, `padding` and `padding-top`), where whichever comes later wins for the
 * shared longhand. When a member holds such a pair both properties are excluded from the
 * base and kept whole inside each modifier, preserving the member's original order.
 *
 * Order-sensitivity is read from the engine (see orderSensitive), never a hand-listed
 * shorthand table, so it covers every shorthand the browser knows (and any it gains
 * later) and never misclassifies independent properties. Identical independent
 * declarations therefore still hoist to the base even when a sibling differs across
 * members. For the common case of computed-longhand-only rules the guard is a no-op.
 *
 * @param base - the pre-guard intersection (prop -> shared value)
 * @param members - the rules sharing that intersection
 * @returns the subset of the base that is safe to hoist
 */
function familyGuardedBase(base: Map<string, string>, members: ClassRule[]): Map<string, string> {
	const probe = document.createElement('div');
	const memo = new Map<string, boolean>();
	const unsafe = new Set<string>();
	for (const member of members) {
		const decls = member.decls;
		for (let i = 0; i < decls.length; i++) {
			for (let j = i + 1; j < decls.length; j++) {
				const a = decls[i] as [string, string];
				const b = decls[j] as [string, string];
				if (orderSensitive(probe, memo, a, b)) {
					unsafe.add(a[0]);
					unsafe.add(b[0]);
				}
			}
		}
	}
	const out = new Map<string, string>();
	for (const [prop, value] of base) {
		if (!unsafe.has(prop)) out.set(prop, value);
	}
	return out;
}

/**
 * Whether two declarations' relative order changes the result, asked of the engine: it
 * sets them on a throwaway style in both orders and compares the resulting declaration
 * blocks. Equal blocks mean the two are independent and safe to separate; different
 * blocks mean they share a longhand one overrides, so order is significant. A false
 * positive only makes factoring more cautious, and the test has no false negatives (if
 * order genuinely matters the blocks differ), so the guard stays render-safe. Memoized
 * per value pair, since the same declarations recur across a group's members.
 *
 * @param probe - a throwaway element whose style is reused as the parser
 * @param memo - per-call cache keyed by the ordered value pair
 * @param a - one declaration as [prop, value]
 * @param b - the other declaration as [prop, value]
 */
function orderSensitive(probe: HTMLElement, memo: Map<string, boolean>, a: [string, string], b: [string, string]): boolean {
	if (a[0] === b[0]) return false;
	const key = a[0] < b[0] ? `${a[0]}:${a[1]}|${b[0]}:${b[1]}` : `${b[0]}:${b[1]}|${a[0]}:${a[1]}`;
	const cached = memo.get(key);
	if (cached !== undefined) return cached;
	const result = declBlock(probe, a, b) !== declBlock(probe, b, a);
	memo.set(key, result);
	return result;
}

/**
 * Sets two declarations in order on a throwaway style and returns its resulting set of
 * declarations, sorted so only an order-dependent difference (one declaration overriding
 * the other) shows up, not the insertion order itself.
 *
 * @param probe - the element whose style is used as a throwaway parser
 * @param first - the declaration set first
 * @param second - the declaration set second
 */
function declBlock(probe: HTMLElement, first: [string, string], second: [string, string]): string {
	const style = probe.style;
	style.cssText = '';
	style.setProperty(first[0], first[1]);
	style.setProperty(second[0], second[1]);
	const out: string[] = [];
	for (let i = 0; i < style.length; i++) {
		const prop = style.item(i);
		out.push(`${prop}:${style.getPropertyValue(prop)}`);
	}
	return out.sort().join(';');
}

/** Sets each grouped member element's class to its `base base--modifier` replacement. */
function applyBaseClasses(elements: HTMLElement[], renames: Map<string, string>): void {
	if (renames.size === 0) return;
	for (const el of elements) {
		const current = el.getAttribute('class');
		if (current === null) continue;
		const replacement = renames.get(current);
		if (replacement !== undefined) el.setAttribute('class', replacement);
	}
}

/** Flat css: one rule per generated class. */
function cssText(rules: ClassRule[]): string {
	return rules.map((r) => `.${r.className} {\n${declLines(r.decls)}\n}`).join('\n\n');
}

/**
 * Nested scss: the block rule with its element rules nested via `&__...`. Bem
 * names are flat regardless of dom depth, so every element rule nests one level
 * under the block.
 */
function scssText(block: string, rules: ClassRule[]): string {
	const root = rules.find((r) => r.isRoot);
	const children = rules.filter((r) => !r.isRoot);
	const inner = children
		.map((r) => `\t&__${r.className.slice(block.length + 2)} {\n${declLines(r.decls, 2)}\n\t}`)
		.join('\n');
	const rootDecls = root ? declLines(root.decls, 1) : '';
	return `.${block} {\n${rootDecls}${rootDecls && inner ? '\n' : ''}${inner}\n}`;
}

/** Serialize declarations as indented `prop: value;` lines. */
function declLines(decls: Array<[string, string]>, indent = 1): string {
	const pad = '\t'.repeat(indent);
	return decls.map(([p, v]) => `${pad}${p}: ${v};`).join('\n');
}

/** The @font-face/@keyframes block, prefixed with a blank line if present. */
function atRulesAppendix(captured: Captured): string {
	const at = atRulesCss(captured);
	return at ? `\n\n${at}` : '';
}

/** The first author class token on the root, or its tag name, as the block base. */
function firstClassOrTag(el: Element): string {
	const first = Array.from(el.classList)[0];
	return first ?? el.tagName.toLowerCase();
}

/**
 * Lowercase, hyphenate, and trim a token for use in a class name. A leading digit is
 * prefixed with an underscore: a css class selector cannot start with an unescaped
 * digit, so a hashed author class like `15kfc` (common in css-in-js) would otherwise
 * emit the invalid selector `.15kfc`, which the browser silently ignores, leaving the
 * snip unstyled. Underscore is a valid identifier start, so `._15kfc` renders.
 */
function sanitize(name: string): string {
	const base = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return /^[0-9]/.test(base) ? `_${base}` : base;
}

/**
 * The minimum number of declarations a group must share for factoring to pay off: a
 * smaller overlap is not worth the extra base rule and class tokens, so it is left as
 * separate rules.
 */
const MIN_SHARED_DECLS = 4;

/** The minimum number of rules a group must hold to be worth a shared base class. */
const MIN_GROUP_SIZE = 2;

/**
 * The minimum fraction of a candidate rule's declarations that the shared base must
 * cover for it to join a group. Below this a rule overlaps only incidentally (a common
 * font or transition timing), so admitting it would shrink the base to those few generic
 * declarations and strand each member's real commonality in its modifier.
 */
const MIN_COHESION = 0.5;
