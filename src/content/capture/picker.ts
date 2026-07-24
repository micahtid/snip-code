/**
 * capture/picker.ts: in-page element picker overlay
 *
 * Pipeline position: capture (the front door, produces the chosen Element)
 * Reads from Captured: n/a (runs before Captured exists)
 * Writes to Captured: n/a (hands the chosen Element + screenshot to the orchestrator)
 *
 * Why this exists: every snip starts with the user choosing an element. This
 * overlay gives live visual feedback, a bright spotlight cut into a dimmed page
 * and a tag/size tooltip, that tracks whatever is under the pointer, then resolves to
 * the chosen element on click. Ported, rewritten not copied, from v1
 * element-selector.ts. The meaningful v2 change is the sticky arrow-climb, which
 * v1 lacked, letting the user grab a wrapping container instead of the leaf they
 * happen to be hovering.
 *
 * The climb is sticky: arrowup walks to the parent, arrowdown walks back down
 * toward the leaf the cursor is over, and a climbed selection is preserved while
 * the pointer stays inside it. A plain mousemove no longer snaps back to the leaf,
 * which was the regression that made wrapping containers unreachable. Moving the
 * pointer out of the selection re-baselines to the fresh leaf under the cursor.
 *
 * Multi-select (snip mode only, opt-in via the `multi` option): pressing shift turns the mode
 * on, and it stays on with the key released, so every plain click then pins or unpins. Shift
 * is a switch rather than a modifier to hold, because shift plus wheel is chrome's
 * horizontal-scroll binding, so a mode that required shift to stay held would make the page
 * unscrollable for exactly as long as the user was collecting elements. A pinned element
 * keeps a persistent outline with a numbered badge while the live highlight goes on tracking
 * the cursor. Enter finishes the selection and hands every pin to onSelectMany in pin order,
 * esc cancels it, and shift again leaves the mode while nothing is selected yet. Because the
 * mode is latched rather than held, nothing about the user's hands signals that it is on, so
 * a bottom-edge indicator names the count and the keys. Each pin's screenshot is captured
 * when it is pinned, not at the end, since the user may scroll earlier pins out of the
 * viewport while collecting later ones.
 *
 * Deliberately no Set<string> of "blocked" container tags, which v1 had to avoid
 * snapping to body/main. Hardcoded tag-name Sets are disallowed, and the sticky
 * climb makes the heuristic unnecessary, since the user climbs on purpose.
 */

/** One chosen element and the screenshot taken of it, the unit both callbacks deal in. */
export interface Pick {
	element: Element;
	/** Cropped png data url, or '' when the capture failed. Never blocks a snip. */
	screenshot: string;
}

/** Options the orchestrator passes to drive selection. */
export interface PickerOptions {
	/** Called with the chosen element and a cropped screenshot data url. */
	onSelect: (element: Element, screenshot: string) => void;
	/** Called when the user presses esc. */
	onCancel: () => void;
	/** Enable shift-to-pin multi-select. Snip mode only; assistive stays single-pick. */
	multi?: boolean;
	/** Called with every pinned element, in pin order, once the user presses enter. */
	onSelectMany?: (picks: Pick[]) => void;
}

/** One pinned element and the chrome drawn over it while the selection is being collected. */
interface Pinned extends Pick {
	box: HTMLDivElement;
	badge: HTMLDivElement;
}

const OVERLAY_ID = 'snipcode-overlay';
const TOOLTIP_ID = 'snipcode-tooltip';
const BANNER_ID = 'snipcode-multiselect';
const SCRIM_ID = 'snipcode-scrim';
// The live hover highlight sits on top; the persistent pin outlines one below it.
const Z_OVERLAY = 2147483647;
const Z_PINS = 2147483646;
// The dimming scrim sits below the outlines, so those paint over the veil, and above the
// page, which shows through its holes.
const Z_SCRIM = 2147483645;
/** Side length of the square selection badge, in px. */
const BADGE_SIZE = 20;
/** The badge's corner rounding. Square-with-soft-corners, not a circle. */
const BADGE_RADIUS = 6;
/**
 * How far the badge overhangs the outline's top left corner, in px. Small, so it sits mostly
 * on the corner rather than floating well outside it. The offset is fixed relative to the box,
 * so the badge tracks the corner and clips off screen with it, never sliding to stay visible.
 */
const BADGE_INSET = 9;
/** The page-dimming veil's color, painted over everything except the cut-out holes. */
const SCRIM_BG = 'rgba(7, 9, 15, 0.55)';
/** The indigo the number badges are filled with. */
const BADGE_BG = '#4f6ef6';
/** The dark slate surface behind the multi-select toggle and the cursor tooltip. */
const CHROME_BG = '#1e293b';
/** The family the overlay's own chrome is set in, registered on the page by loadChromeFont. */
const OVERLAY_FONT = 'SnipCodeMontserrat';
/** How long the page must sit still before the pins and highlight come back, in ms. */
const SCROLL_SETTLE = 250;

/**
 * Drives the pick interaction. Construct, then call activate(). The overlay
 * tears itself down on select or cancel.
 */
export class ElementPicker {
	private readonly options: PickerOptions;
	private active = false;
	/** The element that would be snipped on click. May be a climbed ancestor of `leaf`. */
	private current: Element | null = null;
	/** The actual element under the cursor, the floor that arrowdown descends toward. */
	private leaf: Element | null = null;
	/** True once the user has climbed above the leaf. Preserved across mousemove. */
	private climbed = false;
	/** Last cursor position, so a keyboard climb can re-place the tooltip. */
	private lastX = 0;
	private lastY = 0;
	private scrolling = false;
	private scrollTimer: number | null = null;

	private overlay: HTMLDivElement | null = null;
	private tooltip: HTMLDivElement | null = null;
	/** The bottom-edge indicator that multi-select is on. Only present while latched. */
	private banner: HTMLDivElement | null = null;
	/** The page-dimming veil, cut with a hole for the hover and one for every pin. */
	private scrim: HTMLDivElement | null = null;

	/**
	 * True once the user has entered multi-select. The mode latches rather than tracking the
	 * shift key, because shift plus wheel is chrome's horizontal-scroll binding, so a held
	 * modifier makes the page unscrollable for as long as the user is collecting elements.
	 * Latched, every plain click pins or unpins, and enter ends the batch.
	 */
	private latched = false;

	/** The pinned elements, in pin order. Empty unless the user is shift-selecting. */
	private pins: Pinned[] = [];
	/**
	 * Serializes the per-pin screenshots. Each capture hides every piece of picker chrome,
	 * waits a frame, and restores it, so two overlapping captures would restore each other's
	 * hidden state and leak the outline into the image. Chaining keeps them one at a time.
	 */
	private captures: Promise<void> = Promise.resolve();
	/** True once a finish is under way, so a second event cannot ship the batch twice. */
	private finishing = false;
	/** True while a screenshot is being taken, so a mousemove cannot repaint the hidden chrome into it. */
	private capturing = false;
	/** True while the tooltip is showing a pin rejection, so hover tracking leaves the message up. */
	private rejecting = false;
	private rejectTimer: number | null = null;

	constructor(options: PickerOptions) {
		this.options = options;
	}

	/** Show the overlay and start tracking the pointer. */
	activate(): void {
		if (this.active) return;
		this.active = true;
		loadChromeFont();
		this.buildChrome();
		document.addEventListener('mousemove', this.onMove, true);
		document.addEventListener('click', this.onClick, true);
		document.addEventListener('keydown', this.onKey, true);
		window.addEventListener('scroll', this.onScrollOrResize, true);
		window.addEventListener('resize', this.onScrollOrResize, true);
	}

	/** Remove the overlay and detach every listener. Idempotent. */
	deactivate(): void {
		if (!this.active) return;
		this.active = false;
		this.current = null;
		this.leaf = null;
		this.climbed = false;
		if (this.scrollTimer !== null) {
			window.clearTimeout(this.scrollTimer);
			this.scrollTimer = null;
		}
		if (this.rejectTimer !== null) {
			window.clearTimeout(this.rejectTimer);
			this.rejectTimer = null;
		}
		this.rejecting = false;
		document.removeEventListener('mousemove', this.onMove, true);
		document.removeEventListener('click', this.onClick, true);
		document.removeEventListener('keydown', this.onKey, true);
		window.removeEventListener('scroll', this.onScrollOrResize, true);
		window.removeEventListener('resize', this.onScrollOrResize, true);
		this.overlay?.remove();
		this.tooltip?.remove();
		this.banner?.remove();
		this.scrim?.remove();
		this.latched = false;
		// Pins are chrome too: an esc or a panel-side cancel clears the whole selection,
		// exactly as it clears the climb state above.
		this.pins.forEach((pin) => pin.box.remove());
		this.pins = [];
		this.finishing = false;
		this.capturing = false;
		this.overlay = this.tooltip = this.banner = this.scrim = null;
	}

	/** Build the dimming scrim, the highlight box, and the tooltip. */
	private buildChrome(): void {
		// The scrim dims the whole page and is cut with a hole for the hovered element and one
		// for every pin, so a pinned element stays lit even once the cursor leaves it. The holes
		// are a clip-path rather than a box-shadow, because a box-shadow can only cut one hole and
		// multi-select needs many; the clip-path is transitioned so the hover hole glides between
		// elements rather than snapping, as long as the pin set (and so the path's shape) holds.
		const scrim = document.createElement('div');
		scrim.id = SCRIM_ID;
		Object.assign(scrim.style, {
			position: 'fixed',
			inset: '0',
			zIndex: String(Z_SCRIM),
			pointerEvents: 'none',
			background: SCRIM_BG,
			transition: 'clip-path 0.17s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.2s ease-out',
			display: 'none',
		} satisfies Partial<CSSStyleDeclaration>);
		document.body.appendChild(scrim);
		this.scrim = scrim;

		// The hover highlight is the bright hole the scrim cuts for the current element, not an
		// outline. This element stays as the invisible tracker that follows the pointer and marks
		// the picker as live; it draws nothing itself.
		const overlay = document.createElement('div');
		overlay.id = OVERLAY_ID;
		Object.assign(overlay.style, {
			position: 'fixed',
			zIndex: String(Z_OVERLAY),
			pointerEvents: 'none', // Never intercept the hover/click we track.
			// Translate, which is gpu-composited, instead of top/left to avoid layout thrash.
			transform: 'translate(0,0)',
			transition: 'opacity 0.2s ease-out',
			top: '0',
			left: '0',
			width: '0',
			height: '0',
			display: 'none',
		} satisfies Partial<CSSStyleDeclaration>);
		document.body.appendChild(overlay);
		this.overlay = overlay;

		const tooltip = document.createElement('div');
		tooltip.id = TOOLTIP_ID;
		Object.assign(tooltip.style, {
			position: 'fixed',
			zIndex: String(Z_OVERLAY),
			pointerEvents: 'none',
			background: CHROME_BG,
			color: '#fff',
			font: '12px ui-monospace, monospace',
			padding: '3px 6px',
			borderRadius: '4px',
			maxWidth: '400px',
			whiteSpace: 'nowrap',
			overflow: 'hidden',
			textOverflow: 'ellipsis',
			display: 'none',
		} satisfies Partial<CSSStyleDeclaration>);
		document.body.appendChild(tooltip);
		this.tooltip = tooltip;
	}

	/** Track the element under the cursor via hit-testing, not event.target. */
	private readonly onMove = (e: MouseEvent): void => {
		// While a capture is in flight the chrome is deliberately hidden, so tracking would
		// paint the highlight straight back into the screenshot.
		if (this.scrolling || this.capturing) return;
		// elementFromPoint is more reliable than e.target for nested/overlapped
		// layouts, and our chrome is pointer-events:none so it is never returned.
		const el = document.elementFromPoint(e.clientX, e.clientY);
		if (!el || el === this.overlay || el === this.tooltip) {
			return;
		}
		this.lastX = e.clientX;
		this.lastY = e.clientY;
		// Sticky climb: while a climbed selection still contains the cursor, keep it.
		// Only track the leaf underneath so arrowdown has a floor to descend toward.
		// This is the fix for the regression where any mousemove snapped the highlight
		// back to the leaf, leaving wrapping containers unreachable.
		if (this.climbed && this.current && this.current !== el && this.current.contains(el)) {
			this.leaf = el;
			return;
		}
		// Fresh target under the cursor: re-baseline and drop any climb.
		this.leaf = el;
		this.current = el;
		this.climbed = false;
		this.frame(el);
		this.label(el, e.clientX, e.clientY);
	};

	/** Position the highlight box flush around `el`'s border rect. */
	private frame(el: Element): void {
		if (!this.overlay) return;
		const r = el.getBoundingClientRect();
		Object.assign(this.overlay.style, {
			display: 'block',
			opacity: '1',
			transform: `translate(${r.left}px, ${r.top}px)`,
			width: `${r.width}px`,
			height: `${r.height}px`,
		});
		this.updateScrim();
	}

	/**
	 * Redraw the dimming veil so it has a bright hole for the hovered element and one for every
	 * pin. The veil is a solid dark div clipped to everything-but-the-holes with an even-odd
	 * clip path. The path lists the hover hole first, then the pins in a stable order, so while
	 * the pin set is unchanged the path keeps the same shape and the transitioned clip-path
	 * glides the hover hole from one element to the next. With nothing to highlight the scrim
	 * hides entirely, so the page is never left dark.
	 */
	private updateScrim(): void {
		if (!this.scrim) return;
		const rects: DOMRect[] = [];
		// Skip the hover hole when a pin already lights that element, so the two holes cannot
		// overlap and cancel under the even-odd rule, which would darken the element instead.
		if (this.current && !this.coveredByPin(this.current)) rects.push(this.current.getBoundingClientRect());
		for (const pin of this.pins) rects.push(pin.element.getBoundingClientRect());
		if (rects.length === 0) {
			this.scrim.style.display = 'none';
			return;
		}
		// The layout viewport excludes any scrollbar, which is the coordinate space both the
		// fixed inset:0 scrim and getBoundingClientRect live in, so the holes line up with it.
		const w = document.documentElement.clientWidth;
		const h = document.documentElement.clientHeight;
		let d = `M0 0 H${w} V${h} H0 Z`;
		for (const r of rects) {
			const x = Math.round(r.left);
			const y = Math.round(r.top);
			const x2 = Math.round(r.right);
			const y2 = Math.round(r.bottom);
			if (x2 <= 0 || y2 <= 0 || x >= w || y >= h || x2 <= x || y2 <= y) continue;
			d += ` M${x} ${y} H${x2} V${y2} H${x} Z`;
		}
		this.scrim.style.clipPath = `path(evenodd, "${d}")`;
		this.scrim.style.opacity = '1';
		this.scrim.style.display = 'block';
	}

	/** True when a pin already lights `el`, either it or an ancestor being pinned. */
	private coveredByPin(el: Element): boolean {
		return this.pins.some((pin) => pin.element === el || pin.element.contains(el));
	}

	/** Render `<tag#id.class> WxH` near the cursor, flipping at viewport edges. */
	private label(el: Element, x: number, y: number): void {
		if (!this.tooltip || this.rejecting) return;
		const r = el.getBoundingClientRect();
		const id = el.id ? `#${el.id}` : '';
		const cls = Array.from(el.classList)
			.filter((c) => !c.startsWith('snipcode'))
			.slice(0, 3)
			.map((c) => `.${c}`)
			.join('');
		this.tooltip.textContent = `<${el.tagName.toLowerCase()}${id}${cls}> ${Math.round(r.width)}×${Math.round(r.height)}`;
		this.tooltip.style.display = 'block';
		const tr = this.tooltip.getBoundingClientRect();
		let lx = x + 14;
		let ly = y + 14;
		if (lx + tr.width > window.innerWidth - 8) lx = x - tr.width - 14;
		if (ly + tr.height > window.innerHeight - 8) ly = y - tr.height - 14;
		this.tooltip.style.left = `${lx}px`;
		this.tooltip.style.top = `${ly}px`;
	}

	/**
	 * Flip multi-select on or off. Turning it on before any click is the whole point of the
	 * latch; turning it off again is allowed only while nothing is pinned yet, since once a
	 * collection exists enter finishes it and esc cancels it, and a stray shift must not throw
	 * the collection away. No-op outside snip mode, where multi-select is not offered.
	 *
	 * This is the one entry point for both shift paths: the page-side keydown below, and the
	 * panel-side keydown that App forwards as TOGGLE_MULTI while keyboard focus still sits in
	 * the side panel, before a pin has moved focus onto the page.
	 */
	toggleMulti(): void {
		if (!this.options.multi) return;
		this.latched = !(this.latched && this.pins.length === 0);
		this.renderBanner();
	}

	private readonly onKey = (e: KeyboardEvent): void => {
		// Shift is the mode's switch, not a modifier to hold: pressing it turns multi-select on
		// there and then, before any click, and pressing it again turns it back off as long as
		// nothing is selected yet. Repeats are ignored, since holding the key down would
		// otherwise flip the mode many times a second.
		if (e.key === 'Shift' && this.options.multi && !e.repeat) {
			this.toggleMulti();
			return;
		}
		if (e.key === 'Escape') {
			e.preventDefault();
			// Esc cancels everything, pins included. deactivate clears them.
			this.deactivate();
			this.options.onCancel();
			return;
		}
		// Enter is the one finish for a latched multi-select. The mode is explicit rather than
		// held, so it needs an explicit end; the indicator names this key.
		if (e.key === 'Enter' && this.latched && this.pins.length > 0) {
			e.preventDefault();
			void this.finishBatch();
			return;
		}
		// Arrowup: climb to the parent so the user can grab a wrapping container
		// rather than the leaf under the cursor. The climb is sticky, see onMove,
		// and the tooltip is re-rendered so the user sees which element they are
		// now on.
		if (e.key === 'ArrowUp' && this.current?.parentElement) {
			e.preventDefault();
			this.current = this.current.parentElement;
			this.climbed = true;
			this.frame(this.current);
			this.label(this.current, this.lastX, this.lastY);
			return;
		}
		// Arrowdown: walk back down one step toward the leaf under the cursor, undoing
		// one climb. Bottoming out at the leaf clears the climb so mousemove tracks again.
		if (e.key === 'ArrowDown' && this.current && this.leaf && this.current !== this.leaf && this.current.contains(this.leaf)) {
			e.preventDefault();
			const next = childTowardLeaf(this.current, this.leaf);
			if (next) {
				this.current = next;
				this.climbed = next !== this.leaf;
				this.frame(this.current);
				this.label(this.current, this.lastX, this.lastY);
			}
		}
	};

	/** While scrolling, fade the chrome out. Positions are stale until it settles. */
	private readonly onScrollOrResize = (): void => {
		this.scrolling = true;
		if (this.overlay) this.overlay.style.opacity = '0';
		if (this.tooltip) this.tooltip.style.opacity = '0';
		if (this.scrim) this.scrim.style.opacity = '0';
		// Pinned boxes are position:fixed, so a scroll leaves them behind their element.
		// Fade them with the rest, then re-measure on settle rather than leaving them hidden,
		// since the user still needs to see what is already pinned.
		this.pins.forEach((pin) => (pin.box.style.opacity = '0'));
		// Positions are stale after a scroll. Drop the selection and any climb so the
		// next hover starts clean.
		this.current = null;
		this.leaf = null;
		this.climbed = false;
		// On settle, do both in the one callback so the pinned outlines and their badges come
		// back at the same instant the live highlight re-acquires, rather than the pins
		// snapping back first and the highlight following a beat later. A scroll moves the page
		// under a stationary pointer, so reacquire re-targets the highlight with no mouse move,
		// which is what stops the picker reading as switched off until the cursor twitches.
		if (this.scrollTimer !== null) window.clearTimeout(this.scrollTimer);
		this.scrollTimer = window.setTimeout(() => {
			this.scrolling = false;
			this.scrollTimer = null;
			this.repositionPins();
			this.reacquire();
		}, SCROLL_SETTLE);
	};

	/**
	 * Re-target the highlight at the element now under the last known cursor position. Called
	 * once the page has stopped moving, so the picker is live again without a mouse move.
	 */
	private reacquire(): void {
		if (!this.active || this.scrolling || this.capturing) return;
		const el = document.elementFromPoint(this.lastX, this.lastY);
		if (!el || el === this.overlay || el === this.tooltip || el === this.banner) return;
		this.leaf = el;
		this.current = el;
		this.climbed = false;
		this.frame(el);
		this.label(el, this.lastX, this.lastY);
	}

	private readonly onClick = (e: MouseEvent): void => {
		if (!this.current) return;
		// Swallow the click entirely so the host page never sees it.
		e.preventDefault();
		e.stopPropagation();
		e.stopImmediatePropagation();
		const chosen = this.current;
		// In multi-select every click collects an element instead of snipping it. A shift-click
		// gets there in one gesture too, for anyone who reaches for the modifier out of habit.
		// The overlay stays live either way, so the user can go pick the next one.
		if (this.options.multi && (e.shiftKey || this.latched)) {
			this.latched = true;
			this.togglePin(chosen);
			this.renderBanner();
			return;
		}
		void this.complete(chosen);
	};

	/** Pin an unpinned element, or unpin it if it is already in the selection. */
	private togglePin(element: Element): void {
		// Equality is checked before containment, since an element contains itself and the
		// exact-match case is the unpin path, not a conflict.
		const existing = this.pins.findIndex((pin) => pin.element === element);
		if (existing >= 0) {
			this.pins[existing]!.box.remove();
			this.pins.splice(existing, 1);
			this.renumberPins();
			this.updateScrim(); // One fewer hole in the veil.
			return;
		}
		const conflict = this.conflictingPin(element);
		if (conflict) {
			this.rejectPin(conflict, conflict.element.contains(element));
			return;
		}
		const { box, badge } = this.buildPinBox();
		const pin: Pinned = { element, screenshot: '', box, badge };
		this.pins.push(pin);
		this.renumberPins();
		this.positionPin(pin);
		this.updateScrim(); // Cut a lasting hole for the new pin.
		this.queueCapture(pin);
	}

	/**
	 * The pin a candidate would duplicate, if any. Pinning a card and then a button inside it
	 * ships the button's markup twice, once alone and once embedded in the card, so a nested
	 * or wrapping candidate is refused. Siblings that merely overlap visually are not related
	 * in the dom and are allowed, since overlap is not duplication.
	 *
	 * @param candidate - the element the user is trying to pin
	 * @returns the pin it conflicts with, or null when it is free to pin
	 */
	private conflictingPin(candidate: Element): Pinned | null {
		for (const pin of this.pins) {
			if (pin.element.contains(candidate) || candidate.contains(pin.element)) return pin;
		}
		return null;
	}

	/**
	 * Refuse a pin visibly. A silent no-op reads as a broken click, so the conflicting pin
	 * blinks and the tooltip says which selection is in the way. The batch is never ended by
	 * a rejection: the overlay stays live and shift stays held.
	 *
	 * @param conflict - the pin standing in the way
	 * @param inside - true when the candidate sits inside the conflicting pin
	 */
	private rejectPin(conflict: Pinned, inside: boolean): void {
		const number = this.pins.indexOf(conflict) + 1;
		conflict.box.style.opacity = '0.25';
		window.setTimeout(() => {
			if (this.pins.includes(conflict)) conflict.box.style.opacity = '1';
		}, 200);
		if (!this.tooltip) return;
		this.rejecting = true;
		this.tooltip.textContent = inside ? `Already inside selection ${number}` : `Contains selection ${number}`;
		this.tooltip.style.display = 'block';
		if (this.rejectTimer !== null) window.clearTimeout(this.rejectTimer);
		this.rejectTimer = window.setTimeout(() => {
			this.rejectTimer = null;
			this.rejecting = false;
			if (this.current) this.label(this.current, this.lastX, this.lastY);
		}, 1200);
	}

	/**
	 * The per-pin element: an invisible box that tracks the pinned element's rect and anchors
	 * its number badge at the corner. The pinned element is shown lit by its scrim hole, so the
	 * box itself draws no outline.
	 */
	private buildPinBox(): { box: HTMLDivElement; badge: HTMLDivElement } {
		const box = document.createElement('div');
		Object.assign(box.style, {
			position: 'fixed',
			zIndex: String(Z_PINS),
			pointerEvents: 'none',
			transition: 'opacity 0.2s ease-out',
			top: '0',
			left: '0',
			width: '0',
			height: '0',
		} satisfies Partial<CSSStyleDeclaration>);
		const badge = document.createElement('div');
		Object.assign(badge.style, {
			position: 'absolute',
			// Rest on the top left corner, overhanging it by a few px. Fixed relative to the box,
			// so the badge stays glued to the corner and clips off with it when the element
			// scrolls out, rather than sliding along the viewport edge to keep itself visible.
			top: `${-BADGE_INSET}px`,
			left: `${-BADGE_INSET}px`,
			width: `${BADGE_SIZE}px`,
			height: `${BADGE_SIZE}px`,
			boxSizing: 'border-box',
			display: 'flex',
			alignItems: 'center',
			justifyContent: 'center',
			background: BADGE_BG,
			color: '#fff',
			font: `600 11px ${CHROME_FONT}`,
			borderRadius: `${BADGE_RADIUS}px`,
			// No ring and no shadow: either reads as a second mark and makes the badge look noisy.
			transform: 'scale(0.6)',
			transition: 'transform 0.12s cubic-bezier(0.22, 1, 0.36, 1)',
		} satisfies Partial<CSSStyleDeclaration>);
		box.appendChild(badge);
		document.body.appendChild(box);
		// Next frame, so the browser has a start value to animate the entrance from.
		requestAnimationFrame(() => (badge.style.transform = 'scale(1)'));
		return { box, badge };
	}

	/** Re-flow the badge numbers after a pin or an unpin, so they always read 1..n. */
	private renumberPins(): void {
		this.pins.forEach((pin, i) => {
			const label = String(i + 1);
			pin.badge.textContent = label;
			// Past nine the square widens rather than clipping the second digit.
			const wide = label.length > 1;
			Object.assign(pin.badge.style, {
				width: wide ? 'auto' : `${BADGE_SIZE}px`,
				minWidth: wide ? `${BADGE_SIZE}px` : '',
				padding: wide ? '0 5px' : '',
			});
		});
	}

	/**
	 * Place one pin's outline flush around its element's current border rect. The badge is a
	 * child of the box at a fixed corner offset (set in buildPinBox), so it moves with the box
	 * and needs no positioning here.
	 */
	private positionPin(pin: Pinned): void {
		const r = pin.element.getBoundingClientRect();
		Object.assign(pin.box.style, {
			transform: `translate(${r.left}px, ${r.top}px)`,
			width: `${r.width}px`,
			height: `${r.height}px`,
			// An element the page has covered, typically by a sticky header it scrolled under,
			// gets a faded outline. The outline is fixed chrome above the whole page, so at full
			// strength it paints over that header and reads as a rendering bug rather than as a
			// mark on something behind it.
			opacity: isOccluded(pin.element, r) ? '0.35' : '1',
		});
	}

	/** Re-measure every pin after a scroll or resize, since the boxes are position:fixed. */
	private repositionPins(): void {
		this.pins.forEach((pin) => this.positionPin(pin));
		this.updateScrim(); // The pins' holes moved with the page.
	}

	/**
	 * Take this pin's screenshot now rather than when the batch finishes, because the user
	 * may scroll it out of the viewport while collecting the rest, and captureVisibleTab can
	 * only see what is on screen. Queued behind any capture already running.
	 *
	 * @param pin - the pin to fill the screenshot in on
	 */
	private queueCapture(pin: Pinned): void {
		this.captures = this.captures.then(async () => {
			if (!this.active) return;
			this.capturing = true;
			this.hideChrome();
			await nextFrame();
			try {
				pin.screenshot = await captureElementScreenshot(pin.element);
			} catch {
				// A missing screenshot never blocks the snip. The code phases do not need it.
				pin.screenshot = '';
			}
			this.showChrome();
			this.capturing = false;
		});
	}

	/**
	 * Draw, update, or remove the multi-select indicator. The mode is latched rather than held,
	 * so nothing about the user's hands says it is on; this strip is the only thing that does.
	 * It sits against the bottom edge, away from the page headers users most often snip, and
	 * names the count and the keys that end the mode.
	 */
	private renderBanner(): void {
		if (!this.latched) {
			this.banner?.remove();
			this.banner = null;
			return;
		}
		if (!this.banner) {
			const banner = document.createElement('div');
			banner.id = BANNER_ID;
			// The tooltip's dark slate surface, so the two pieces of floating chrome match.
			Object.assign(banner.style, {
				position: 'fixed',
				left: '50%',
				bottom: '20px',
				transform: 'translateX(-50%)',
				zIndex: String(Z_OVERLAY),
				pointerEvents: 'none',
				display: 'flex',
				alignItems: 'center',
				padding: '7px 12px',
				borderRadius: '4px',
				background: CHROME_BG,
				color: '#fff',
				font: `500 12px ${CHROME_FONT}`,
				whiteSpace: 'nowrap',
			} satisfies Partial<CSSStyleDeclaration>);
			document.body.appendChild(banner);
			this.banner = banner;
		}
		// The count shows from the first shift press, at zero, so the mode is unmistakably on
		// before any element is picked. The tail hint follows what is possible yet: nothing to
		// snip at zero, so it names the way back out instead.
		const count = this.pins.length;
		const tail = count === 0 ? 'Shift to Exit' : 'Enter to Snip · Esc to Cancel';
		this.banner.textContent = `Multi-Select On · ${count} Selected · ${tail}`;
	}

	/** Hide every piece of picker chrome, pins included, so none of it lands in a capture. */
	private hideChrome(): void {
		if (this.overlay) this.overlay.style.display = 'none';
		if (this.tooltip) this.tooltip.style.display = 'none';
		if (this.banner) this.banner.style.display = 'none';
		if (this.scrim) this.scrim.style.display = 'none';
		this.pins.forEach((pin) => (pin.box.style.display = 'none'));
	}

	/** Restore what hideChrome hid. The live highlight only comes back if there is a target. */
	private showChrome(): void {
		if (this.overlay && this.current) this.overlay.style.display = 'block';
		if (this.tooltip && this.current) this.tooltip.style.display = 'block';
		if (this.banner) this.banner.style.display = 'flex';
		this.pins.forEach((pin) => (pin.box.style.display = 'block'));
		this.updateScrim(); // Redraw the veil and its holes, or hide it if nothing is lit.
	}

	/**
	 * End a multi-select: wait for any in-flight screenshot, tear the overlay down, and hand
	 * every pin to onSelectMany in pin order. Guarded so two events arriving together cannot
	 * ship the batch twice.
	 */
	private async finishBatch(): Promise<void> {
		if (this.finishing) return;
		this.finishing = true;
		await this.captures;
		const picks: Pick[] = this.pins.map((pin) => ({ element: pin.element, screenshot: pin.screenshot }));
		this.deactivate();
		this.options.onSelectMany?.(picks);
	}

	/** Hide the chrome, grab a cropped screenshot, then fire onSelect. */
	private async complete(element: Element): Promise<void> {
		// Hide our own chrome before the capture so it is not in the screenshot.
		this.capturing = true;
		this.hideChrome();
		// Let the browser paint one frame without the overlay before capturing.
		await nextFrame();

		let screenshot = '';
		try {
			screenshot = await captureElementScreenshot(element);
		} catch {
			// A missing screenshot never blocks the snip. The code phases do not need it.
			screenshot = '';
		}
		this.deactivate();
		this.options.onSelect(element, screenshot);
	}
}

/** Resolve after the browser has painted one frame, so a style change is on screen. */
function nextFrame(): Promise<void> {
	return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Given an `ancestor` and a `leaf` somewhere beneath it, returns the direct child
 * of `ancestor` that sits on the path down to `leaf`. Used by the arrowdown descend
 * to step exactly one level back toward the element under the cursor.
 *
 * @param ancestor - the currently selected, climbed element
 * @param leaf - the element under the cursor, a descendant of `ancestor`
 * @returns the child of `ancestor` containing `leaf`, or null if not on the path
 */
function childTowardLeaf(ancestor: Element, leaf: Element): Element | null {
	let node: Element = leaf;
	while (node.parentElement && node.parentElement !== ancestor) {
		node = node.parentElement;
	}
	return node.parentElement === ancestor ? node : null;
}

/**
 * Captures the visible tab and crops to the element's padded border box.
 *
 * The privileged screenshot lives in the background worker, since content scripts
 * cannot call chrome.tabs.captureVisibleTab, so this messages CAPTURE_SCREENSHOT
 * and crops the returned full-viewport image to the element rect. A 24px pad
 * keeps drop shadows and ::before/::after decorations that bleed outside the
 * border box. Accounts for devicePixelRatio so css px map to device px.
 *
 * @param element - the element to crop around
 * @returns a png data url, or throws if capture/crop fails
 */
async function captureElementScreenshot(element: Element): Promise<string> {
	const rect = element.getBoundingClientRect();
	const pad = 24;
	const left = Math.max(0, rect.left - pad);
	const top = Math.max(0, rect.top - pad);
	const right = Math.min(window.innerWidth, rect.right + pad);
	const bottom = Math.min(window.innerHeight, rect.bottom + pad);

	const res = (await chrome.runtime.sendMessage({
		type: 'CAPTURE_SCREENSHOT',
		requestId: cryptoId(),
		payload: { rect: { x: left, y: top, w: right - left, h: bottom - top } },
	})) as { ok: boolean; result?: { dataUrl: string } };
	if (!res?.ok || !res.result?.dataUrl) throw new Error('screenshot capture failed');

	const dpr = window.devicePixelRatio || 1;
	const img = await loadImage(res.result.dataUrl);
	// captureVisibleTab returns the whole viewport at device resolution. Crop the
	// element's padded region out of it.
	const sx = left * dpr;
	const sy = top * dpr;
	const sw = (right - left) * dpr;
	const sh = (bottom - top) * dpr;
	const canvas = new OffscreenCanvas(Math.max(1, Math.round(sw)), Math.max(1, Math.round(sh)));
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('no 2d context');
	ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
	const blob = await canvas.convertToBlob({ type: 'image/png' });
	return await blobToDataUrl(blob);
}

/** Load a data url into an ImageBitmap-compatible source. */
async function loadImage(dataUrl: string): Promise<ImageBitmap> {
	const blob = await (await fetch(dataUrl)).blob();
	return await createImageBitmap(blob);
}

/** Serialize a blob to a base64 data url. */
function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(reader.error ?? new Error('read failed'));
		reader.readAsDataURL(blob);
	});
}

/** A uuid v4 for message correlation. crypto.randomUUID is available in mv3. */
function cryptoId(): string {
	return crypto.randomUUID();
}

/**
 * True when something else in the page paints over the pinned element, which in practice
 * means a sticky header or a floating bar it has scrolled beneath.
 *
 * It hit-tests one point, the element's center clamped into the viewport, and asks whether
 * the topmost node there still belongs to the element. Our own chrome is pointer-events:none
 * so it is never the answer. One point rather than four corners on purpose: this runs for
 * every pin on every scroll settle, a corner can legitimately sit under a neighbor without
 * the element being covered, and the result only drives an opacity.
 *
 * @param element - the pinned element
 * @param r - its current border rect, already measured by the caller
 * @returns whether the element is covered at its center
 */
function isOccluded(element: Element, r: DOMRect): boolean {
	if (r.width === 0 || r.height === 0) return false;
	const x = Math.round(r.left + r.width / 2);
	const y = Math.round(r.top + r.height / 2);
	// Off screen entirely: nothing to be covered by, and elementFromPoint would answer null.
	if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
	const top = document.elementFromPoint(x, y);
	if (!top) return false;
	return top !== element && !element.contains(top);
}

/** The picker chrome's own font stack: the extension's montserrat, then the system ui font. */
const CHROME_FONT = `'${OVERLAY_FONT}', ui-sans-serif, system-ui, sans-serif`;

/**
 * Load the extension's montserrat into the host page so the overlay's badges and indicator
 * are set in the same face as the side panel, rather than in whatever the system supplies.
 *
 * It is registered through the FontFace api rather than by injecting an @font-face rule,
 * deliberately: an injected rule joins document.styleSheets, which capture/sheets.ts walks,
 * so the extension's own font would become a candidate face in the user's snip. A FontFace
 * added to document.fonts is invisible to that walk. Best-effort throughout, since the whole
 * point is cosmetic and no failure here may block a snip; the stack falls back on its own.
 */
function loadChromeFont(): void {
	if (fontRequested) return;
	fontRequested = true;
	try {
		const url = chrome.runtime.getURL('fonts/montserrat-latin.woff2');
		if (!url) return;
		const face = new FontFace(OVERLAY_FONT, `url("${url}")`, { weight: '400 800', style: 'normal' });
		void face
			.load()
			.then((loaded) => document.fonts.add(loaded))
			.catch(() => {});
	} catch {
		// No runtime url, no FontFace support, or a page that forbids the load. The stack falls back.
	}
}

/** Guard so the face is requested once per page rather than on every activate(). */
let fontRequested = false;
