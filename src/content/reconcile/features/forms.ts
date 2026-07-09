/**
 * features/forms.ts: form control rendering + state
 *
 * Pipeline position: reconcile
 * Reads from Captured: root, clone
 * Writes to Captured: bakedStyles + clone, the appearance/accent-color + live state
 *
 * Principles applied: this extends the "ship what renders" rule to form-control
 * styling, and it preserves the live control state that cloneNode drops.
 *
 * CSS/spec reference: https://developer.mozilla.org/en-US/docs/Web/CSS/appearance
 * also covers accent-color. ::file-selector-button is emitted by features/pseudo.
 * Detection criterion: an element matching the form-control selector. That selector
 * is the form-element spec surface expressed as a selector rather than a tag Set.
 * Transform contract: it bakes non-default appearance, -webkit-appearance, and
 * accent-color onto matching clone controls. It also mirrors the live value,
 * checked, and selected state onto the clone as attributes, so the rendered control
 * matches the capture. It touches bakedStyles and the clone only.
 *
 * Why this exists: appearance: none is how authors replace native control chrome
 * with custom styling. If it is lost, the control snaps back to the os widget.
 * Accent-color tints checkboxes, radios, and range inputs. And cloneNode copies a
 * control's attributes but not its current value, checked, or selected state, so a
 * filled input or ticked checkbox renders empty in the clone. Mirroring the state
 * fixes that.
 */
import type { Captured } from '../../types';
import { pairedSubtrees } from '../match';

const FORM_CONTROL = 'input, select, textarea, button, meter, progress, option';

/**
 * Bakes form-control styling and mirrors live control state onto the clone.
 *
 * @param captured - bakedStyles + clone mutated in place
 */
export function apply(captured: Captured): Captured {
	for (const [original, clone] of pairedSubtrees(captured.root, captured.clone)) {
		let isControl = false;
		try {
			isControl = original.matches(FORM_CONTROL);
		} catch {
			isControl = false;
		}
		if (!isControl) continue;

		const computed = getComputedStyle(original);
		const baked = captured.bakedStyles.get(clone) ?? new Map<string, string>();
		bake(clone, baked, 'appearance', computed.getPropertyValue('appearance'), (v) => v === 'auto' || v === '');
		bake(clone, baked, '-webkit-appearance', computed.getPropertyValue('-webkit-appearance'), (v) => v === 'auto' || v === '');
		bake(clone, baked, 'accent-color', computed.getPropertyValue('accent-color'), (v) => v === 'auto' || v === '');
		if (baked.size > 0) captured.bakedStyles.set(clone, baked);

		mirrorState(original, clone);
	}
	return captured;
}

/** Mirror a control's live value/checked/selected onto the clone as attributes. */
function mirrorState(original: Element, clone: Element): void {
	if (original instanceof HTMLInputElement && clone instanceof HTMLInputElement) {
		if (original.type === 'checkbox' || original.type === 'radio') {
			if (original.checked) clone.setAttribute('checked', '');
			else clone.removeAttribute('checked');
		} else if (original.value) {
			clone.setAttribute('value', original.value);
		}
	} else if (original instanceof HTMLTextAreaElement && clone instanceof HTMLTextAreaElement) {
		clone.textContent = original.value;
	} else if (original instanceof HTMLOptionElement && clone instanceof HTMLOptionElement) {
		if (original.selected) clone.setAttribute('selected', '');
		else clone.removeAttribute('selected');
	} else if (
		(original instanceof HTMLMeterElement || original instanceof HTMLProgressElement) &&
		(clone instanceof HTMLMeterElement || clone instanceof HTMLProgressElement)
	) {
		clone.setAttribute('value', String(original.value));
	}
}

/** Bake a value onto the clone + baked map when a predicate says it is non-default. */
function bake(clone: Element, baked: Map<string, string>, prop: string, value: string, isDefault: (v: string) => boolean): void {
	if (baked.has(prop) || !value || isDefault(value)) return;
	baked.set(prop, value);
	try {
		(clone as HTMLElement).style.setProperty(prop, value);
	} catch {
		// Invalid for this element, so skip it.
	}
}
