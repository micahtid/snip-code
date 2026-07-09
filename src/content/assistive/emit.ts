/**
 * assistive/emit.ts: assistive json build + delivery.
 *
 * Pipeline position: capture. Assistive runs the capture phase, then emits.
 * Reads from Captured: page, capturedAt, element, screenshot, stylesheets, root.
 * It does not write to Captured. It returns and delivers the json.
 *
 * No principles apply here, since this is serialization and io.
 *
 * Why this exists: assistive mode produces a json document a coding agent can act on, rather
 * than code. The document holds the page url, both selectors, the bounding box, and the asset
 * manifest. This builds that document verbatim to the assistive schema and delivers it by the
 * user's chosen channels: clipboard, file, or webhook. Delivery failures never throw, and
 * each channel is attempted independently.
 */
import type { Captured, UserPreferences } from '../types';
import { describeElement } from './selectors';
import { extractFonts } from './fonts';
import { extractAssets } from './assets';

/** The assistive document shape. */
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
 * Builds the assistive json document verbatim to the assistive schema.
 *
 * @param captured - the capture-phase output
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
 * Delivers the document over each channel the user enabled. Each channel is independent and
 * best-effort. A failure is recorded, never thrown.
 *
 * @param doc - the assistive document
 * @param prefs - user preferences: delivery channels and webhook url
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

/** Trigger a browser download of the json via an object-url anchor. */
function downloadJson(json: string): void {
	const blob = new Blob([json], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = 'snipcode-assistive.json';
	document.body.appendChild(a);
	a.click();
	a.remove();
	// Release the object url on the next tick so the download has started.
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Post the json to the configured webhook. This is best-effort, because the page csp may block. */
async function postWebhook(webhookUrl: string | null, json: string): Promise<void> {
	if (!webhookUrl) throw new Error('no webhook url configured');
	await fetch(webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json });
}
