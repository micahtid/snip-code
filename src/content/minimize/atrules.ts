/**
 * minimize/atrules.ts: dead at-rule purge
 *
 * Pipeline position: minimize, after merge and before format
 * Reads from Captured: nothing
 * Writes to Captured: nothing; transforms the merged stylesheet string
 *
 * Why this exists: a tailwind-based sheet registers dozens of custom properties with
 * `@property` (67 to 123 per bundle), and after prune deletes the declarations that used
 * them, almost all of those registrations govern nothing: their property name appears
 * nowhere else in the sheet. A registration whose name is never set, read by var(), or
 * named in a transition is dead weight a human would never write, so this drops it.
 *
 * Liveness is judged textually and conservatively, never by the resting oracle, for two
 * reasons. A registration's real job can be invisible at rest: reconcile/properties.ts
 * re-emits registrations precisely so a custom property interpolates smoothly in a
 * transition (the shadcn ring recovery), and the resting render cannot see that motion. And
 * the render oracle is actively unfit here: getComputedStyle enumerates a registered custom
 * property, so removing its registration changes that property's computed value even though
 * it is unreferenced and paints nothing, which the oracle would read as a render change and
 * veto. So a registration is kept whenever its exact property-name token occurs anywhere else
 * in the sheet, set or referenced, resting rule or withheld state rule alike; only a name
 * that occurs nowhere but its own registration is dead. Because that name then governs
 * nothing, removing the registration is a no-op at rest and in motion by construction, the
 * same style of by-construction safety colorize relies on. The corpus pixel backstop and the
 * forced-state checks verify the batch at the gate.
 *
 * Because M5's var() inlining removes reference sites, registrations can become newly dead
 * after it; this purge is idempotent and cheap, so it runs again there.
 */
import { serializeRules } from './declarations';

/** A grouping rule (@media/@layer/@supports) whose child rules can be walked and deleted. */
type RuleContainer = CSSStyleSheet | CSSGroupingRule;

/** One registered @property in the parsed sheet: where it sits, so it can be deleted. */
interface PropertyRuleRef {
	container: RuleContainer;
	index: number;
	name: string;
}

/**
 * Drops every `@property` registration whose custom-property name occurs nowhere else in the
 * sheet. Parses the css into a constructable stylesheet, the same side-effect-free cssom
 * parse formatCss uses, so nothing touches the live page. Graceful by contract: returns the
 * input unchanged when the css will not parse or carries no registration. Deterministic: a
 * pure function of the input text.
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
	const dead = registrations.filter((r) => nameOccurrences(css, r.name) === 1);
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
 * How many times a custom-property name occurs in the sheet as a whole token, its own
 * registration included. A registration is the only occurrence when the count is one. The
 * token boundary rejects a name that is a prefix of another (`--tw-ring` inside
 * `--tw-ring-color`), since a hyphen is a name character, not a word boundary.
 *
 * @param css - the whole stylesheet text
 * @param name - a custom-property name including the leading `--`
 */
function nameOccurrences(css: string, name: string): number {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const token = new RegExp(`(?<![-\\w])${escaped}(?![-\\w])`, 'g');
	return (css.match(token) || []).length;
}
