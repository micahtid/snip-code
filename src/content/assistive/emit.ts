/**
 * assistive/emit.ts: assistive json build + delivery
 *
 * Phase: j (assistive mode), see SNIPCODE-REWRITE-PLAN.md section 12
 * Pipeline position: 1, capture (assistive runs phase 1, then emits)
 * Reads from Captured: page, capturedAt, element, screenshot, stylesheets, root
 * Writes to Captured: n/a (returns + delivers the json)
 *
 * Principles applied: none (serialization + io).
 *
 * Why this exists: assistive mode (mode 2) produces the section-9 json document a
 * coding agent can act on, page url, both selectors, bounding box, and the asset
 * manifest, instead of code. this builds that document verbatim to the section-9
 * schema and delivers it by the user's chosen channels (clipboard / file /
 * webhook, section 10). delivery failures never throw; each channel is attempted
 * independently.
 */
import type { Captured, UserPreferences } from '../types';
import { describeElement } from './selectors';
import { extractFonts } from './fonts';
import { extractAssets } from './assets';

/** the section-9 assistive document shape. */
export interface AssistiveDoc {
	version: '1.0';
	capturedAt: string;
	page: Captured['page'];
	element: Captured['element'];
	screenshot: string;
	stylesheets: Array<{ href: string | null; origin: string; rules: number }>;
	assets: { fonts: string[]; images: string[]; icons: string[] };
}

/**
 * builds the assistive json document verbatim to the section-9 schema.
 *
 * @param captured - the phase-1 capture
 */
export function buildAssistiveJson(captured: Captured): AssistiveDoc {
	const assets = extractAssets(captured.root);
	return {
		version: '1.0',
		capturedAt: captured.capturedAt,
		page: captured.page,
		element: describeElement(captured),
		screenshot: captured.screenshot,
		stylesheets: captured.stylesheets.map((s) => ({ href: s.href, origin: s.origin, rules: s.ruleCount })),
		assets: { fonts: extractFonts(captured.root), images: assets.images, icons: assets.icons },
	};
}

/**
 * delivers the document over each channel the user enabled (section 10). each
 * channel is independent and best-effort; a failure is recorded, never thrown.
 *
 * @param doc - the assistive document
 * @param prefs - user preferences (delivery channels + webhook url)
 * @returns the warnings accumulated across channels
 */
export async function deliver(doc: AssistiveDoc, prefs: UserPreferences): Promise<string[]> {
	const json = JSON.stringify(doc, null, 2);
	const warnings: string[] = [];

	for (const channel of prefs.assistiveDelivery) {
		try {
			if (channel === 'clipboard') await navigator.clipboard.writeText(json);
			else if (channel === 'file') downloadJson(json);
			else if (channel === 'webhook') await postWebhook(prefs.webhookUrl, json);
		} catch (err) {
			warnings.push(`assistive ${channel} delivery failed: ${(err as Error).message}`);
		}
	}
	return warnings;
}

/** trigger a browser download of the json via an object-url anchor. */
function downloadJson(json: string): void {
	const blob = new Blob([json], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = 'snipcode-assistive.json';
	document.body.appendChild(a);
	a.click();
	a.remove();
	// release the object url on the next tick so the download has started.
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** post the json to the configured webhook (best-effort; page csp may block). */
async function postWebhook(webhookUrl: string | null, json: string): Promise<void> {
	if (!webhookUrl) throw new Error('no webhook url configured');
	await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json });
}
