/**
 * minimize/atrules.ts: dead at-rule purge
 *
 * Pipeline position: minimize, after merge and before format
 * Reads from Captured: nothing
 * Writes to Captured: nothing. It transforms the merged stylesheet string.
 *
 * Why this exists: a tailwind-based sheet registers dozens of custom properties with
 * `@property` (67 to 123 per bundle). After prune deletes the declarations that used them,
 * almost all of those registrations govern nothing, because their property name appears
 * nowhere else in the sheet. A registration whose name is never set, read by var(), or
 * named in a transition is dead weight a human would never write, so this drops it.
 *
 * Liveness is judged textually and conservatively, never by the resting oracle, for two
 * reasons. First, a registration's real job can be invisible at rest. reconcile/properties.ts
 * re-emits registrations precisely so a custom property interpolates smoothly in a transition
 * (the shadcn ring recovery), and the resting render cannot see that motion. Second, the render
 * oracle is actively unfit here. getComputedStyle enumerates a registered custom property, so
 * removing its registration changes that property's computed value even though it is
 * unreferenced and paints nothing, which the oracle would read as a render change and veto.
 *
 * So liveness is a read count. A registration is kept whenever its name is read, whether by a
 * var() reference or by a mention in a transition or animation property list, in a resting rule
 * or a withheld state rule alike. A write, meaning a declaration that merely sets the name, is
 * not liveness, because a value nothing reads governs no paint. A name that is only written, or
 * present only in its own registration, is dead. Because a dead name governs nothing, removing
 * its registration is a no-op at rest and in motion by construction, the same style of
 * by-construction safety that colorize relies on. The corpus pixel backstop and the
 * forced-state checks verify the batch at the gate.
 *
 * Because the var() inlining step removes reference sites, registrations can become newly dead
 * after it. This purge is idempotent and cheap, so it runs again after that step.
 */
import { serializeRules } from './declarations';

/** A grouping rule (@media/@layer/@supports) whose child rules can be walked and deleted. */
type RuleContainer = CSSStyleSheet | CSSGroupingRule;

/** One registered @property in the parsed sheet, recording where it sits so it can be deleted. */
interface PropertyRuleRef {
	container: RuleContainer;
	index: number;
	name: string;
}

/**
 * Drops every `@property` registration whose custom-property name is never read, meaning no
 * var() reference and no transition or animation mention anywhere in the sheet. Parses the css
 * into a constructable stylesheet, the same side-effect-free cssom parse formatCss uses, so
 * nothing touches the live page. It is graceful by contract, returning the input unchanged when
 * the css will not parse or carries no registration. It is deterministic, a pure function of
 * the input text.
 *
 * @param css - the merged stylesheet, after merge and before format
 * @returns the stylesheet with dead registrations removed, or the input unchanged
 */
export function purgeAtRules(css: string): string {
	if (!css.trim() || !/@property\s/.test(css)) return css;
	let sheet: CSSStyleSheet;
	try {
		sheet = new CSSStyleSheet();
		sheet.replaceSync(css);
	} catch {
		return css;
	}
	const registrations: PropertyRuleRef[] = [];
	collectPropertyRules(sheet, registrations);
	const dead = registrations.filter((r) => nameReads(css, r.name) === 0);
	if (dead.length === 0) return css;
	deleteRules(dead);
	return serializeRules(Array.from(sheet.cssRules));
}

/**
 * Recursively collects every `@property` rule under a container, into `out`. A property rule
 * is detected structurally, by its `name`/`syntax` descriptor fields, because CSSPropertyRule
 * is absent from some dom lib versions. Grouping rules are descended so a registration nested
 * in an @layer or @media is found too.
 */
function collectPropertyRules(container: RuleContainer, out: PropertyRuleRef[]): void {
	const rules = container.cssRules;
	for (let i = 0; i < rules.length; i++) {
		const rule = rules[i]!;
		const r = rule as unknown as { name?: unknown; syntax?: unknown };
		if (typeof r.name === 'string' && typeof r.syntax === 'string' && r.name.startsWith('--')) {
			out.push({ container, index: i, name: r.name });
		} else if (isGroupingRule(rule)) {
			collectPropertyRules(rule, out);
		}
	}
}

/** True when a rule can contain and delete child rules, an @media/@layer/@supports block. */
function isGroupingRule(rule: CSSRule): rule is CSSGroupingRule {
	return 'cssRules' in rule && typeof (rule as CSSGroupingRule).deleteRule === 'function';
}

/**
 * Deletes the given registrations from their containers. Grouped by container and deleted in
 * descending index order, so each deletion leaves the still-to-delete indices in that
 * container valid.
 */
function deleteRules(refs: PropertyRuleRef[]): void {
	const byContainer = new Map<RuleContainer, number[]>();
	for (const ref of refs) {
		const list = byContainer.get(ref.container);
		if (list) list.push(ref.index);
		else byContainer.set(ref.container, [ref.index]);
	}
	for (const [container, indices] of byContainer) {
		for (const index of indices.sort((a, b) => b - a)) container.deleteRule(index);
	}
}

/**
 * How many times a custom-property name is read in the sheet. A read is a `var()` reference to
 * it, or a mention of it in a transition or animation property list, where it names a property
 * to interpolate. A write, meaning a declaration that sets the name, is not a read and keeps no
 * registration alive, because a value nothing reads governs no paint. The name's own
 * `@property` line is not a read either. A registration with zero reads is therefore dead. The
 * token boundary rejects a name that is a prefix of another (`--tw-ring` inside
 * `--tw-ring-color`), because a hyphen is a name character, not a word boundary.
 *
 * @param css - the whole stylesheet text
 * @param name - a custom-property name including the leading `--`
 */
function nameReads(css: string, name: string): number {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const boundary = `(?<![-\\w])${escaped}(?![-\\w])`;
	let reads = (css.match(new RegExp(`var\\(\\s*${boundary}`, 'g')) || []).length;
	// A name listed in a transition or animation value names a property to interpolate, a read.
	for (const decl of css.matchAll(/(?:transition|transition-property|animation|animation-name)\s*:[^;}]*/g)) {
		reads += (decl[0].match(new RegExp(boundary, 'g')) || []).length;
	}
	return reads;
}
