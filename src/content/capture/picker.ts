/**
 * capture/picker.ts — in-page element picker overlay
 *
 * Phase: b (capture) — see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: 1 — capture (the front door; produces the chosen Element)
 * Reads from Captured: n/a (runs before Captured exists)
 * Writes to Captured: n/a (hands the chosen Element + screenshot to the orchestrator)
 *
 * Principles applied: none (interaction surface).
 *
 * Why this exists: every snip starts with the user choosing an element. this
 * overlay gives live visual feedback — a highlight box, edge guide lines, and a
 * tag/size tooltip — that tracks whatever is under the pointer, then resolves to
 * the chosen element on click. ported (rewritten, not copied) from v1
 * element-selector.ts; the meaningful v2 change is the arrowup decoration-climb
 * (section 19.7), which v1 lacked, letting the user grab a wrapping section
 * instead of the leaf they happen to be hovering.
 *
 * deliberately no Set<string> of "blocked" container tags (v1 had one to avoid
 * snapping to body/main): forbidden pattern #1 bans tag-name Sets, and the
 * arrowup climb makes the heuristic unnecessary — the user climbs on purpose.
 */

/** options the orchestrator passes to drive selection. */
export interface PickerOptions {
	/** called with the chosen element and a cropped screenshot data url. */
	onSelect: (element: Element, screenshot: string) => void;
	/** called when the user presses esc. */
	onCancel: () => void;
}

const OVERLAY_ID = 'snipcode-overlay';
const TOOLTIP_ID = 'snipcode-tooltip';
// sit one below the overlay so the box paints over the guide lines.
const Z_OVERLAY = 2147483647;
const Z_GUIDES = 2147483646;

/**
 * drives the pick interaction. construct, then call activate(); the overlay
 * tears itself down on select or cancel.
 */
export class ElementPicker {
	private readonly options: PickerOptions;
	private active = false;
	private current: Element | null = null;
	private scrolling = false;
	private scrollTimer: number | null = null;

	private overlay: HTMLDivElement | null = null;
	private tooltip: HTMLDivElement | null = null;
	private guides: HTMLDivElement[] = [];

	constructor(options: PickerOptions) {
		this.options = options;
	}

	/** show the overlay and start tracking the pointer. */
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

	/** remove the overlay and detach every listener. idempotent. */
	deactivate(): void {
		if (!this.active) return;
		this.active = false;
		this.current = null;
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

	/** build the highlight box, four edge guides, and the tooltip. */
	private buildChrome(): void {
		const overlay = document.createElement('div');
		overlay.id = OVERLAY_ID;
		Object.assign(overlay.style, {
			position: 'fixed',
			zIndex: String(Z_OVERLAY),
			pointerEvents: 'none', // never intercept the hover/click we track.
			border: '1.5px solid #4f6ef6',
			background: 'rgba(79, 110, 246, 0.10)',
			// dim the rest of the page so the target stands out (set-of-marks).
			boxShadow: '0 0 0 16000px rgba(7, 9, 15, 0.30)',
			borderRadius: '2px',
			// translate (gpu-composited) instead of top/left to avoid layout thrash.
			transform: 'translate(0,0)',
			transition: 'transform 0.12s ease-out, width 0.12s ease-out, height 0.12s ease-out, opacity 0.15s',
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

	/** track the element under the cursor (via hit-testing, not event.target). */
	private readonly onMove = (e: MouseEvent): void => {
		if (this.scrolling) return;
		// elementFromPoint is more reliable than e.target for nested/overlapped
		// layouts, and our chrome is pointer-events:none so it is never returned.
		const el = document.elementFromPoint(e.clientX, e.clientY);
		if (!el || el === this.overlay || el === this.tooltip || this.guides.includes(el as HTMLDivElement)) {
			return;
		}
		this.current = el;
		this.frame(el);
		this.label(el, e.clientX, e.clientY);
	};

	/** position the highlight box + guides flush around `el`'s border rect. */
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
		// top, bottom, left, right edge lines spanning the viewport.
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

	/** render `<tag#id.class> WxH` near the cursor, flipping at viewport edges. */
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
		// arrowup: climb to the parent so the user can grab a wrapping container
		// rather than the leaf under the cursor (section 19.7 decoration climb).
		if (e.key === 'ArrowUp' && this.current?.parentElement) {
			e.preventDefault();
			this.current = this.current.parentElement;
			this.frame(this.current);
		}
	};

	/** while scrolling, fade the chrome out; positions are stale until it settles. */
	private readonly onScrollOrResize = (): void => {
		this.scrolling = true;
		if (this.overlay) this.overlay.style.opacity = '0';
		if (this.tooltip) this.tooltip.style.opacity = '0';
		this.guides.forEach((g) => (g.style.opacity = '0'));
		this.current = null;
		if (this.scrollTimer !== null) window.clearTimeout(this.scrollTimer);
		this.scrollTimer = window.setTimeout(() => {
			this.scrolling = false;
			this.scrollTimer = null;
		}, 150);
	};

	private readonly onClick = (e: MouseEvent): void => {
		if (!this.current) return;
		// swallow the click entirely so the host page never sees it.
		e.preventDefault();
		e.stopPropagation();
		e.stopImmediatePropagation();
		const chosen = this.current;
		void this.complete(chosen);
	};

	/** hide the chrome, grab a cropped screenshot, then fire onSelect. */
	private async complete(element: Element): Promise<void> {
		// hide our own chrome before the capture so it is not in the screenshot.
		if (this.overlay) this.overlay.style.display = 'none';
		if (this.tooltip) this.tooltip.style.display = 'none';
		this.guides.forEach((g) => (g.style.display = 'none'));
		// let the browser paint one frame without the overlay before capturing.
		await new Promise((r) => requestAnimationFrame(() => r(null)));

		let screenshot = '';
		try {
			screenshot = await captureElementScreenshot(element);
		} catch {
			// a missing screenshot never blocks the snip; phases 1-4 do not need it.
			screenshot = '';
		}
		this.deactivate();
		this.options.onSelect(element, screenshot);
	}
}

/**
 * captures the visible tab and crops to the element's padded border box.
 *
 * the privileged screenshot lives in the background worker (content scripts
 * cannot call chrome.tabs.captureVisibleTab), so this messages CAPTURE_SCREENSHOT
 * and crops the returned full-viewport image to the element rect. a 24px pad
 * keeps drop shadows and ::before/::after decorations that bleed outside the
 * border box. accounts for devicePixelRatio so css px map to device px.
 *
 * @param element — the element to crop around
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
	// captureVisibleTab returns the whole viewport at device resolution; crop the
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

/** load a data url into an ImageBitmap-compatible source. */
async function loadImage(dataUrl: string): Promise<ImageBitmap> {
	const blob = await (await fetch(dataUrl)).blob();
	return await createImageBitmap(blob);
}

/** serialize a blob to a base64 data url. */
function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(reader.error ?? new Error('read failed'));
		reader.readAsDataURL(blob);
	});
}

/** a uuid v4 for message correlation; crypto.randomUUID is available in mv3. */
function cryptoId(): string {
	return crypto.randomUUID();
}
