/**
 * capture/picker.ts: in-page element picker overlay
 *
 * Pipeline position: capture (the front door, produces the chosen Element)
 * Reads from Captured: n/a (runs before Captured exists)
 * Writes to Captured: n/a (hands the chosen Element + screenshot to the orchestrator)
 *
 * Why this exists: every snip starts with the user choosing an element. This
 * overlay gives live visual feedback, a highlight box, edge guide lines, and a
 * tag/size tooltip, that tracks whatever is under the pointer, then resolves to
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
 * Deliberately no Set<string> of "blocked" container tags, which v1 had to avoid
 * snapping to body/main. Hardcoded tag-name Sets are disallowed, and the sticky
 * climb makes the heuristic unnecessary, since the user climbs on purpose.
 */

/** Options the orchestrator passes to drive selection. */
export interface PickerOptions {
	/** Called with the chosen element and a cropped screenshot data url. */
	onSelect: (element: Element, screenshot: string) => void;
	/** Called when the user presses esc. */
	onCancel: () => void;
}

const OVERLAY_ID = 'snipcode-overlay';
const TOOLTIP_ID = 'snipcode-tooltip';
// Sit one below the overlay so the box paints over the guide lines.
const Z_OVERLAY = 2147483647;
const Z_GUIDES = 2147483646;

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
	private guides: HTMLDivElement[] = [];

	constructor(options: PickerOptions) {
		this.options = options;
	}

	/** Show the overlay and start tracking the pointer. */
	activate(): void {
		if (this.active) return;
		this.active = true;
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
		document.removeEventListener('mousemove', this.onMove, true);
		document.removeEventListener('click', this.onClick, true);
		document.removeEventListener('keydown', this.onKey, true);
		window.removeEventListener('scroll', this.onScrollOrResize, true);
		window.removeEventListener('resize', this.onScrollOrResize, true);
		this.overlay?.remove();
		this.tooltip?.remove();
		this.guides.forEach((g) => g.remove());
		this.overlay = this.tooltip = null;
		this.guides = [];
	}

	/** Build the highlight box, four edge guides, and the tooltip. */
	private buildChrome(): void {
		const overlay = document.createElement('div');
		overlay.id = OVERLAY_ID;
		Object.assign(overlay.style, {
			position: 'fixed',
			zIndex: String(Z_OVERLAY),
			pointerEvents: 'none', // Never intercept the hover/click we track.
			border: '1.5px solid #4f6ef6',
			background: 'rgba(79, 110, 246, 0.10)',
			// Dim the rest of the page so the target stands out, the set-of-marks technique.
			boxShadow: '0 0 0 16000px rgba(7, 9, 15, 0.30)',
			borderRadius: '2px',
			// Translate, which is gpu-composited, instead of top/left to avoid layout thrash.
			transform: 'translate(0,0)',
			// Elastic settle that matches v1's selection feel. Opacity fades faster.
			transition:
				'transform 0.25s cubic-bezier(0.22, 1, 0.36, 1), width 0.25s cubic-bezier(0.22, 1, 0.36, 1), height 0.25s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.2s ease-out',
			top: '0',
			left: '0',
			width: '0',
			height: '0',
			display: 'none',
		} satisfies Partial<CSSStyleDeclaration>);
		document.body.appendChild(overlay);
		this.overlay = overlay;

		for (let i = 0; i < 4; i++) {
			const line = document.createElement('div');
			Object.assign(line.style, {
				position: 'fixed',
				zIndex: String(Z_GUIDES),
				pointerEvents: 'none',
				background: 'rgba(79, 110, 246, 0.5)',
				display: 'none',
			} satisfies Partial<CSSStyleDeclaration>);
			document.body.appendChild(line);
			this.guides.push(line);
		}

		const tooltip = document.createElement('div');
		tooltip.id = TOOLTIP_ID;
		Object.assign(tooltip.style, {
			position: 'fixed',
			zIndex: String(Z_OVERLAY),
			pointerEvents: 'none',
			background: '#1e293b',
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
		if (this.scrolling) return;
		// elementFromPoint is more reliable than e.target for nested/overlapped
		// layouts, and our chrome is pointer-events:none so it is never returned.
		const el = document.elementFromPoint(e.clientX, e.clientY);
		if (!el || el === this.overlay || el === this.tooltip || this.guides.includes(el as HTMLDivElement)) {
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

	/** Position the highlight box + guides flush around `el`'s border rect. */
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
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		// Top, bottom, left, right edge lines spanning the viewport.
		const edges: Array<Partial<CSSStyleDeclaration>> = [
			{ left: '0', top: `${r.top}px`, width: `${vw}px`, height: '1px' },
			{ left: '0', top: `${r.bottom}px`, width: `${vw}px`, height: '1px' },
			{ left: `${r.left}px`, top: '0', width: '1px', height: `${vh}px` },
			{ left: `${r.right}px`, top: '0', width: '1px', height: `${vh}px` },
		];
		this.guides.forEach((line, i) => {
			Object.assign(line.style, { display: 'block', opacity: '1', ...edges[i] });
		});
	}

	/** Render `<tag#id.class> WxH` near the cursor, flipping at viewport edges. */
	private label(el: Element, x: number, y: number): void {
		if (!this.tooltip) return;
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

	private readonly onKey = (e: KeyboardEvent): void => {
		if (e.key === 'Escape') {
			e.preventDefault();
			this.deactivate();
			this.options.onCancel();
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
		this.guides.forEach((g) => (g.style.opacity = '0'));
		// Positions are stale after a scroll. Drop the selection and any climb so the
		// next hover starts clean.
		this.current = null;
		this.leaf = null;
		this.climbed = false;
		if (this.scrollTimer !== null) window.clearTimeout(this.scrollTimer);
		this.scrollTimer = window.setTimeout(() => {
			this.scrolling = false;
			this.scrollTimer = null;
		}, 150);
	};

	private readonly onClick = (e: MouseEvent): void => {
		if (!this.current) return;
		// Swallow the click entirely so the host page never sees it.
		e.preventDefault();
		e.stopPropagation();
		e.stopImmediatePropagation();
		const chosen = this.current;
		void this.complete(chosen);
	};

	/** Hide the chrome, grab a cropped screenshot, then fire onSelect. */
	private async complete(element: Element): Promise<void> {
		// Hide our own chrome before the capture so it is not in the screenshot.
		if (this.overlay) this.overlay.style.display = 'none';
		if (this.tooltip) this.tooltip.style.display = 'none';
		this.guides.forEach((g) => (g.style.display = 'none'));
		// Let the browser paint one frame without the overlay before capturing.
		await new Promise((r) => requestAnimationFrame(() => r(null)));

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
