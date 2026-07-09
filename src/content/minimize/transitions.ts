/**
 * minimize/transitions.ts: drop dead transition entries and group shared timing
 *
 * Pipeline position: minimize, after normalize and before merge and the at-rule purge
 * Reads from Captured: nothing
 * Writes to Captured: nothing; transforms the normalized stylesheet string
 *
 * Why this exists: a Tailwind `transition-colors` or `transition` utility bakes a long
 * enumerated list, `color, background-color, border-color, outline-color, fill, stroke,
 * --tw-gradient-from, ...`, each layer carrying the same duration and easing, onto the resting
 * rule. Most of those properties no state or animation ever changes, so their layers can never
 * produce motion; a human would list only the properties that actually move. This drops every
 * layer whose property nothing changes, and when the survivors all share one timing it emits
 * the grouped form a human writes, `transition-property: color, background-color;
 * transition-duration: 0.15s; transition-timing-function: ...`, rather than repeating the
 * timing on each layer.
 *
 * Runs before the at-rule purge and var inlining so a dropped `--tw-gradient-*` layer removes
 * that name's last transition mention, letting the purge retire its now-unread `@property`
 * registration, and before merge so rules a fold makes identical collapse together.
 *
 * Liveness is judged by construction, never by the resting oracle, for the same reason the
 * at-rule purge is textual: a transition paints no resting pixel, yet getComputedStyle
 * enumerates transition-property and the timing longhands, so the oracle would read a dropped
 * layer as a render change and wrongly veto it. A layer for a property nothing changes is
 * unobservable, so removing it is render-neutral by construction; the grouped form cycles one
 * timing across the property list, exactly the engine's own rule, so it animates identically.
 * The corpus pixel backstop and the forced-state checks verify the batch at the gate.
 */
import { serializeRules, WITHHELD } from './declarations';
import { splitTopLevelCommas, TIMING_LONGHANDS } from '../resolve/transition';

/** The default each timing sub-list takes for a layer past its length, its css initial value. */
const TIMING_DEFAULTS = ['0s', 'ease', '0s', 'normal'] as const;

/** One transition layer: the property it animates and the timing it animates over. */
interface Layer {
	property: string;
	duration: string;
	easing: string;
	delay: string;
	behavior: string;
}

/**
 * Drops every transition layer whose property no state rule or animation changes, and groups a
 * surviving list that shares one timing. Parses the css into a constructable stylesheet, the
 * same side-effect-free cssom parse the at-rule purge uses, so nothing touches the live page.
 * Graceful by contract: returns the input unchanged when it will not parse or holds no
 * transition. Deterministic: a pure function of the input text.
 *
 * @param css - the normalized stylesheet, after normalize and before merge
 * @returns the stylesheet with dead transition layers dropped and shared timing grouped
 */
export function foldTransitions(css: string): string {
	if (!css.trim() || !/transition/.test(css)) return css;
	let sheet: CSSStyleSheet;
	try {
		sheet = new CSSStyleSheet();
		sheet.replaceSync(css);
	} catch {
		return css;
	}
	const rules = Array.from(sheet.cssRules);
	const changed = changedLonghands(rules);
	const reads = customPropertyReads(css);
	const scratch = document.createElement('span').style;
	foldRules(rules, changed, reads, scratch);
	return serializeRules(rules);
}

/** Recursively folds every style rule's transition, descending into @media/@supports/@layer. */
function foldRules(rules: CSSRule[], changed: Set<string>, reads: Set<string>, scratch: CSSStyleDeclaration): void {
	for (const rule of rules) {
		if (rule.type === CSSRule.STYLE_RULE) foldRuleTransition(rule as CSSStyleRule, changed, reads, scratch);
		else if ('cssRules' in rule && rule.type !== CSSRule.KEYFRAMES_RULE) foldRules(Array.from((rule as CSSGroupingRule).cssRules), changed, reads, scratch);
	}
}

/**
 * The set of longhands every withheld state or pseudo rule and every @keyframes changes,
 * lowercased. A transition layer whose property expands to one of these can produce motion;
 * one that expands to none cannot. The cssom stores each rule's declarations as expanded
 * longhands, so a state rule's `background` shorthand contributes `background-color` and the
 * rest, matching a `background-color` transition layer correctly.
 */
function changedLonghands(rules: CSSRule[]): Set<string> {
	const changed = new Set<string>();
	const visit = (list: CSSRule[]): void => {
		for (const rule of list) {
			if (rule.type === CSSRule.STYLE_RULE) {
				const styleRule = rule as CSSStyleRule;
				if (WITHHELD.test(styleRule.selectorText || '')) addLonghands(styleRule.style, changed);
			} else if (rule.type === CSSRule.KEYFRAMES_RULE) {
				for (const frame of Array.from((rule as CSSKeyframesRule).cssRules)) addLonghands((frame as CSSKeyframeRule).style, changed);
			} else if ('cssRules' in rule) {
				visit(Array.from((rule as CSSGroupingRule).cssRules));
			}
		}
	};
	visit(rules);
	return changed;
}

/** Adds every property a declaration block sets, lowercased, to `into`. */
function addLonghands(style: CSSStyleDeclaration, into: Set<string>): void {
	for (let i = 0; i < style.length; i++) into.add(style.item(i).toLowerCase());
}

/** The custom-property names read through a `var()` anywhere in the sheet. */
function customPropertyReads(css: string): Set<string> {
	const reads = new Set<string>();
	for (const m of css.matchAll(/var\(\s*(--[\w-]+)/g)) reads.add(m[1]!);
	return reads;
}

/**
 * Folds one rule's transition in place. Reads the transition as its cssom longhands, cycles the
 * timing sub-lists to the property-list length so each layer carries its own timing, drops the
 * layers no state changes, and rewrites only when a layer was dropped or grouping the survivors
 * is shorter, so a rule whose transition is already minimal keeps its exact serialization.
 */
function foldRuleTransition(rule: CSSStyleRule, changed: Set<string>, reads: Set<string>, scratch: CSSStyleDeclaration): void {
	const style = rule.style;
	const properties = splitTopLevelCommas(style.getPropertyValue('transition-property'));
	if (properties.length === 0) return; // No transition on this rule.
	const priority = style.getPropertyPriority('transition-property');
	const timings = TIMING_LONGHANDS.map((longhand) => splitTopLevelCommas(style.getPropertyValue(longhand)));
	const layers: Layer[] = properties.map((property, i) => ({
		property: property.trim(),
		duration: cycle(timings[0]!, i, TIMING_DEFAULTS[0]),
		easing: cycle(timings[1]!, i, TIMING_DEFAULTS[1]),
		delay: cycle(timings[2]!, i, TIMING_DEFAULTS[2]),
		behavior: cycle(timings[3]!, i, TIMING_DEFAULTS[3]),
	}));

	const kept = layers.filter((layer) => producesMotion(layer.property, changed, reads, scratch));
	const dropped = kept.length < layers.length;
	const shareable = kept.length >= 2 && kept.every((layer) => sameTiming(layer, kept[0]!));
	// Rewrite only when a layer was dropped, or grouping a shared-timing list is shorter than
	// the current serialization; otherwise leave the rule's transition exactly as it was.
	if (!dropped && !(shareable && groupedText(kept, priority).length < currentText(style).length)) return;

	clearTransition(style);
	if (kept.length === 0) return; // Every layer was dead: the rule animates nothing.
	if (shareable) applyGrouped(style, kept, priority);
	else applyList(style, kept, priority);
}

/** The value at `i` in a cycled sub-list, or the property's initial value when the list is empty. */
function cycle(values: string[], i: number, fallback: string): string {
	return values.length === 0 ? fallback : values[i % values.length]!.trim();
}

/** Whether two layers share the same duration, easing, delay, and behavior. */
function sameTiming(a: Layer, b: Layer): boolean {
	return a.duration === b.duration && a.easing === b.easing && a.delay === b.delay && a.behavior === b.behavior;
}

/**
 * Whether a transition layer for `property` can produce motion: some state rule or animation
 * changes the property, or a longhand it expands to. A custom property additionally must be
 * read through a `var()`, since a value nothing paints from animates nothing visible. The
 * keywords `all` and `none` are always kept, since `all` is not an enumerable property to test
 * and `none` disables the transition outright.
 */
function producesMotion(property: string, changed: Set<string>, reads: Set<string>, scratch: CSSStyleDeclaration): boolean {
	const name = property.toLowerCase();
	if (name === 'all' || name === 'none') return true;
	if (name.startsWith('--')) return changed.has(name) && reads.has(property);
	if (changed.has(name)) return true;
	for (const longhand of expandToLonghands(scratch, property)) if (changed.has(longhand)) return true;
	return false;
}

/**
 * The longhand names a property expands to, lowercased. Setting the property to `inherit`, a
 * value valid for every property, makes the cssom store a shorthand as its longhands and a
 * longhand as itself, so `background` yields `background-color` and the rest while `color`
 * yields `color`. An unknown property stores nothing and yields an empty list.
 */
function expandToLonghands(scratch: CSSStyleDeclaration, property: string): string[] {
	scratch.cssText = '';
	try {
		scratch.setProperty(property, 'inherit');
	} catch {
		return [];
	}
	const longhands: string[] = [];
	for (let i = 0; i < scratch.length; i++) longhands.push(scratch.item(i).toLowerCase());
	return longhands;
}

/** Removes every transition property from a declaration block, shorthand and longhands alike. */
function clearTransition(style: CSSStyleDeclaration): void {
	style.removeProperty('transition');
	style.removeProperty('transition-property');
	for (const longhand of TIMING_LONGHANDS) style.removeProperty(longhand);
}

/**
 * Sets the grouped form: the property list against one duration, easing, and, where not the
 * default, delay and behavior. The single timing values cycle across the property list, which
 * the cssom keeps as longhands rather than folding to the `transition` shorthand, exactly the
 * compact form a human writes for a list that shares one timing.
 */
function applyGrouped(style: CSSStyleDeclaration, layers: Layer[], priority: string): void {
	const first = layers[0]!;
	style.setProperty('transition-property', layers.map((l) => l.property).join(', '), priority);
	style.setProperty('transition-duration', first.duration, priority);
	style.setProperty('transition-timing-function', first.easing, priority);
	if (first.delay !== TIMING_DEFAULTS[2]) style.setProperty('transition-delay', first.delay, priority);
	if (first.behavior !== TIMING_DEFAULTS[3]) style.setProperty('transition-behavior', first.behavior, priority);
}

/**
 * Sets the `transition` shorthand as a per-layer list, each layer spelling out its property,
 * duration, easing, and, where not the default, its delay. A non-default behavior is carried on
 * the longhand list alongside, since it is not reliably part of the shorthand across engines.
 */
function applyList(style: CSSStyleDeclaration, layers: Layer[], priority: string): void {
	const list = layers.map((layer) => {
		const parts = [layer.property, layer.duration, layer.easing];
		if (layer.delay !== TIMING_DEFAULTS[2]) parts.push(layer.delay);
		return parts.join(' ');
	});
	style.setProperty('transition', list.join(', '), priority);
	if (layers.some((layer) => layer.behavior !== TIMING_DEFAULTS[3])) {
		style.setProperty('transition-behavior', layers.map((l) => l.behavior).join(', '), priority);
	}
}

/** The grouped serialization's length, for the shorter-than-current comparison. */
function groupedText(layers: Layer[], priority: string): string {
	const bang = priority ? ' !important' : '';
	const first = layers[0]!;
	let text = `transition-property: ${layers.map((l) => l.property).join(', ')}${bang}; transition-duration: ${first.duration}${bang}; transition-timing-function: ${first.easing}${bang}`;
	if (first.delay !== TIMING_DEFAULTS[2]) text += `; transition-delay: ${first.delay}${bang}`;
	if (first.behavior !== TIMING_DEFAULTS[3]) text += `; transition-behavior: ${first.behavior}${bang}`;
	return text;
}

/** The rule's current transition serialization, for the shorter-than-current comparison. */
function currentText(style: CSSStyleDeclaration): string {
	const shorthand = style.getPropertyValue('transition');
	if (shorthand) return `transition: ${shorthand}`;
	return ['transition-property', ...TIMING_LONGHANDS]
		.map((longhand) => (style.getPropertyValue(longhand) ? `${longhand}: ${style.getPropertyValue(longhand)}` : ''))
		.filter(Boolean)
		.join('; ');
}
