// Grader: render each bundle's output.html in headless chromium at the matching
// original.jpg dimensions, then score the rendered png against the screenshot
// with pixelmatch (raw pixel diff) and ssim (structural similarity).
//
// v2 filenames: original.jpg (ground truth, from snapshot-bundles.mjs) and
// output.html (pipeline output, from run-pipeline.mjs). Was 0-screenshot.jpg /
// 4-final-ai.html in v1.

import { chromium } from 'playwright';
import pixelmatch from 'pixelmatch';
import ssimLib from 'ssim.js';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const ssim = ssimLib.default ?? ssimLib;
const DEFAULT_DATA_DIR = path.join(os.homedir(), 'Downloads', 'training-data');
const DEFAULT_TARGETS = ['output.html'];

function resolveTargetCandidates(target) {
	if (!target) return DEFAULT_TARGETS;
	return Array.isArray(target) ? target : [target];
}

// Walk the data dir and return every leaf folder holding original.jpg and at
// least one target candidate. Tier is the first path segment under the root.
async function findBundles(dataDir, targetCandidates) {
	const bundles = [];
	const tiers = await fs.readdir(dataDir, { withFileTypes: true });
	for (const tier of tiers) {
		if (!tier.isDirectory()) continue;
		const tierDir = path.join(dataDir, tier.name);
		const cases = await fs.readdir(tierDir, { withFileTypes: true });
		for (const c of cases) {
			if (!c.isDirectory()) continue;
			const caseDir = path.join(tierDir, c.name);
			const screenshot = path.join(caseDir, 'original.jpg');
			try {
				await fs.access(screenshot);
			} catch {
				continue;
			}
			let chosen = null;
			for (const cand of targetCandidates) {
				const p = path.join(caseDir, cand);
				try {
					await fs.access(p);
					chosen = { file: cand, path: p };
					break;
				} catch {
					// Try next
				}
			}
			if (!chosen) continue;
			bundles.push({ tier: tier.name, name: c.name, dir: caseDir, screenshot, target: chosen.path, targetFile: chosen.file });
		}
	}
	bundles.sort((a, b) => (a.tier + a.name).localeCompare(b.tier + b.name));
	return bundles;
}

// Render the target html sized to (width, height); reducedMotion freezes css
// animations at frame 0 for determinism, fonts.ready replaces a brittle timer.
async function renderTarget(browser, htmlPath, width, height) {
	const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
	const page = await context.newPage();
	await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
	await page.evaluate(() => document.fonts.ready);
	const png = await page.screenshot({ type: 'png', fullPage: false });
	await context.close();
	return png;
}

// Decode any image buffer to raw rgba at exactly (width, height) so pixelmatch
// and ssim see equivalent inputs (screenshot is jpg, render is png).
async function toRawRGBA(buffer, width, height) {
	const { data } = await sharp(buffer).resize(width, height, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
	return data;
}

async function gradeBundle(browser, bundle) {
	const screenshotBuf = await fs.readFile(bundle.screenshot);
	const meta = await sharp(screenshotBuf).metadata();
	const width = meta.width;
	const height = meta.height;

	const renderBuf = await renderTarget(browser, bundle.target, width, height);
	const srcRaw = await toRawRGBA(screenshotBuf, width, height);
	const renderRaw = await toRawRGBA(renderBuf, width, height);

	const totalPixels = width * height;
	const diffPixels = pixelmatch(srcRaw, renderRaw, null, width, height, { threshold: 0.1, includeAA: false });
	const pixelScore = 1 - diffPixels / totalPixels;
	const ssimScore = ssim({ data: srcRaw, width, height }, { data: renderRaw, width, height }).mssim;

	return { tier: bundle.tier, name: bundle.name, targetFile: bundle.targetFile, width, height, pixelScore, ssimScore, diffPixels, totalPixels };
}

export async function gradeAll(opts = {}) {
	const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
	const targetCandidates = resolveTargetCandidates(opts.target);
	const bundles = await findBundles(dataDir, targetCandidates);
	if (bundles.length === 0) throw new Error(`no bundles found under ${dataDir} matching targets ${targetCandidates.join(', ')}`);

	const browser = await chromium.launch({ headless: true });
	const cases = [];
	try {
		for (const bundle of bundles) {
			process.stdout.write(`grading ${bundle.tier}/${bundle.name} ... `);
			try {
				const result = await gradeBundle(browser, bundle);
				cases.push(result);
				console.log(`pixel=${result.pixelScore.toFixed(4)} ssim=${result.ssimScore.toFixed(4)}`);
			} catch (err) {
				console.log(`error: ${err.message}`);
				cases.push({ tier: bundle.tier, name: bundle.name, error: err.message });
			}
		}
	} finally {
		await browser.close();
	}

	const scored = cases.filter((c) => !c.error);
	const aggregate = {
		cases: scored.length,
		failed: cases.length - scored.length,
		meanPixel: scored.reduce((s, c) => s + c.pixelScore, 0) / (scored.length || 1),
		meanSsim: scored.reduce((s, c) => s + c.ssimScore, 0) / (scored.length || 1),
	};
	return { dataDir, target: targetCandidates, ranAt: new Date().toISOString(), cases, aggregate };
}

const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	const argv = process.argv.slice(2);
	let target;
	for (let i = 0; i < argv.length; i++) if (argv[i] === '--target') target = argv[++i];
	const result = await gradeAll({ target });
	console.log(`\naggregate (n=${result.aggregate.cases}, failed=${result.aggregate.failed}):`);
	console.log(`  mean pixel: ${result.aggregate.meanPixel.toFixed(4)}`);
	console.log(`  mean ssim:  ${result.aggregate.meanSsim.toFixed(4)}`);
}
