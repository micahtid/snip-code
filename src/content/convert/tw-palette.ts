/**
 * convert/tw-palette.ts: tailwind color palette matcher
 *
 * Pipeline position: convert
 * Reads from Captured: nothing (operates on color strings)
 * Writes to Captured: nothing (pure color matcher)
 *
 * A lookup feeding the tailwind converter.
 *
 * Why this exists: tailwind expresses colors as palette tokens (bg-slate-700).
 * To emit clean tailwind, an arbitrary captured color must map to the nearest
 * palette entry, but only when the match is perceptually faithful, else the
 * converter must fall back to an arbitrary value (bg-[#4287f5]) so brand colors
 * are not silently drifted. Matching uses ciede2000 (perceptual color distance),
 * with tight thresholds: <1 is exact, 1-2 is an acceptable nudge, >=2 forces an
 * arbitrary value. Ported (rewritten) from v1 tailwind-palette.ts, full module.
 *
 * The palette table below is the tailwind v3 vocabulary (a finite output-format
 * data table, not a hardcoded list of styling properties or tags, so the
 * no-hardcoded-list rule does not apply to format vocabularies).
 */

/** Tailwind v3 palette: "family-shade" -> hex. */
const TAILWIND_COLORS: Record<string, string> = {
	white: '#ffffff', black: '#000000',
	'slate-50': '#f8fafc', 'slate-100': '#f1f5f9', 'slate-200': '#e2e8f0', 'slate-300': '#cbd5e1', 'slate-400': '#94a3b8', 'slate-500': '#64748b', 'slate-600': '#475569', 'slate-700': '#334155', 'slate-800': '#1e293b', 'slate-900': '#0f172a', 'slate-950': '#020617',
	'gray-50': '#f9fafb', 'gray-100': '#f3f4f6', 'gray-200': '#e5e7eb', 'gray-300': '#d1d5db', 'gray-400': '#9ca3af', 'gray-500': '#6b7280', 'gray-600': '#4b5563', 'gray-700': '#374151', 'gray-800': '#1f2937', 'gray-900': '#111827', 'gray-950': '#030712',
	'zinc-50': '#fafafa', 'zinc-100': '#f4f4f5', 'zinc-200': '#e4e4e7', 'zinc-300': '#d4d4d8', 'zinc-400': '#a1a1aa', 'zinc-500': '#71717a', 'zinc-600': '#52525b', 'zinc-700': '#3f3f46', 'zinc-800': '#27272a', 'zinc-900': '#18181b', 'zinc-950': '#09090b',
	'neutral-50': '#fafafa', 'neutral-100': '#f5f5f5', 'neutral-200': '#e5e5e5', 'neutral-300': '#d4d4d4', 'neutral-400': '#a3a3a3', 'neutral-500': '#737373', 'neutral-600': '#525252', 'neutral-700': '#404040', 'neutral-800': '#262626', 'neutral-900': '#171717', 'neutral-950': '#0a0a0a',
	'stone-50': '#fafaf9', 'stone-100': '#f5f5f4', 'stone-200': '#e7e5e4', 'stone-300': '#d6d3d1', 'stone-400': '#a8a29e', 'stone-500': '#78716c', 'stone-600': '#57534e', 'stone-700': '#44403c', 'stone-800': '#292524', 'stone-900': '#1c1917', 'stone-950': '#0c0a09',
	'red-50': '#fef2f2', 'red-100': '#fee2e2', 'red-200': '#fecaca', 'red-300': '#fca5a5', 'red-400': '#f87171', 'red-500': '#ef4444', 'red-600': '#dc2626', 'red-700': '#b91c1c', 'red-800': '#991b1b', 'red-900': '#7f1d1d', 'red-950': '#450a0a',
	'orange-50': '#fff7ed', 'orange-100': '#ffedd5', 'orange-200': '#fed7aa', 'orange-300': '#fdba74', 'orange-400': '#fb923c', 'orange-500': '#f97316', 'orange-600': '#ea580c', 'orange-700': '#c2410c', 'orange-800': '#9a3412', 'orange-900': '#7c2d12', 'orange-950': '#431407',
	'amber-50': '#fffbeb', 'amber-100': '#fef3c7', 'amber-200': '#fde68a', 'amber-300': '#fcd34d', 'amber-400': '#fbbf24', 'amber-500': '#f59e0b', 'amber-600': '#d97706', 'amber-700': '#b45309', 'amber-800': '#92400e', 'amber-900': '#78350f', 'amber-950': '#451a03',
	'yellow-50': '#fefce8', 'yellow-100': '#fef9c3', 'yellow-200': '#fef08a', 'yellow-300': '#fde047', 'yellow-400': '#facc15', 'yellow-500': '#eab308', 'yellow-600': '#ca8a04', 'yellow-700': '#a16207', 'yellow-800': '#854d0e', 'yellow-900': '#713f12', 'yellow-950': '#422006',
	'lime-50': '#f7fee7', 'lime-100': '#ecfccb', 'lime-200': '#d9f99d', 'lime-300': '#bef264', 'lime-400': '#a3e635', 'lime-500': '#84cc16', 'lime-600': '#65a30d', 'lime-700': '#4d7c0f', 'lime-800': '#3f6212', 'lime-900': '#365314', 'lime-950': '#1a2e05',
	'green-50': '#f0fdf4', 'green-100': '#dcfce7', 'green-200': '#bbf7d0', 'green-300': '#86efac', 'green-400': '#4ade80', 'green-500': '#22c55e', 'green-600': '#16a34a', 'green-700': '#15803d', 'green-800': '#166534', 'green-900': '#14532d', 'green-950': '#052e16',
	'emerald-50': '#ecfdf5', 'emerald-100': '#d1fae5', 'emerald-200': '#a7f3d0', 'emerald-300': '#6ee7b7', 'emerald-400': '#34d399', 'emerald-500': '#10b981', 'emerald-600': '#059669', 'emerald-700': '#047857', 'emerald-800': '#065f46', 'emerald-900': '#064e3b', 'emerald-950': '#022c22',
	'teal-50': '#f0fdfa', 'teal-100': '#ccfbf1', 'teal-200': '#99f6e4', 'teal-300': '#5eead4', 'teal-400': '#2dd4bf', 'teal-500': '#14b8a6', 'teal-600': '#0d9488', 'teal-700': '#0f766e', 'teal-800': '#115e59', 'teal-900': '#134e4a', 'teal-950': '#042f2e',
	'cyan-50': '#ecfeff', 'cyan-100': '#cffafe', 'cyan-200': '#a5f3fc', 'cyan-300': '#67e8f9', 'cyan-400': '#22d3ee', 'cyan-500': '#06b6d4', 'cyan-600': '#0891b2', 'cyan-700': '#0e7490', 'cyan-800': '#155e75', 'cyan-900': '#164e63', 'cyan-950': '#083344',
	'sky-50': '#f0f9ff', 'sky-100': '#e0f2fe', 'sky-200': '#bae6fd', 'sky-300': '#7dd3fc', 'sky-400': '#38bdf8', 'sky-500': '#0ea5e9', 'sky-600': '#0284c7', 'sky-700': '#0369a1', 'sky-800': '#075985', 'sky-900': '#0c4a6e', 'sky-950': '#082f49',
	'blue-50': '#eff6ff', 'blue-100': '#dbeafe', 'blue-200': '#bfdbfe', 'blue-300': '#93c5fd', 'blue-400': '#60a5fa', 'blue-500': '#3b82f6', 'blue-600': '#2563eb', 'blue-700': '#1d4ed8', 'blue-800': '#1e40af', 'blue-900': '#1e3a8a', 'blue-950': '#172554',
	'indigo-50': '#eef2ff', 'indigo-100': '#e0e7ff', 'indigo-200': '#c7d2fe', 'indigo-300': '#a5b4fc', 'indigo-400': '#818cf8', 'indigo-500': '#6366f1', 'indigo-600': '#4f46e5', 'indigo-700': '#4338ca', 'indigo-800': '#3730a3', 'indigo-900': '#312e81', 'indigo-950': '#1e1b4b',
	'violet-50': '#f5f3ff', 'violet-100': '#ede9fe', 'violet-200': '#ddd6fe', 'violet-300': '#c4b5fd', 'violet-400': '#a78bfa', 'violet-500': '#8b5cf6', 'violet-600': '#7c3aed', 'violet-700': '#6d28d9', 'violet-800': '#5b21b6', 'violet-900': '#4c1d95', 'violet-950': '#2e1065',
	'purple-50': '#faf5ff', 'purple-100': '#f3e8ff', 'purple-200': '#e9d5ff', 'purple-300': '#d8b4fe', 'purple-400': '#c084fc', 'purple-500': '#a855f7', 'purple-600': '#9333ea', 'purple-700': '#7e22ce', 'purple-800': '#6b21a8', 'purple-900': '#581c87', 'purple-950': '#3b0764',
	'fuchsia-50': '#fdf4ff', 'fuchsia-100': '#fae8ff', 'fuchsia-200': '#f5d0fe', 'fuchsia-300': '#f0abfc', 'fuchsia-400': '#e879f9', 'fuchsia-500': '#d946ef', 'fuchsia-600': '#c026d3', 'fuchsia-700': '#a21caf', 'fuchsia-800': '#86198f', 'fuchsia-900': '#701a75', 'fuchsia-950': '#4a044e',
	'pink-50': '#fdf2f8', 'pink-100': '#fce7f3', 'pink-200': '#fbcfe8', 'pink-300': '#f9a8d4', 'pink-400': '#f472b6', 'pink-500': '#ec4899', 'pink-600': '#db2777', 'pink-700': '#be185d', 'pink-800': '#9d174d', 'pink-900': '#831843', 'pink-950': '#500724',
	'rose-50': '#fff1f2', 'rose-100': '#ffe4e6', 'rose-200': '#fecdd3', 'rose-300': '#fda4af', 'rose-400': '#fb7185', 'rose-500': '#f43f5e', 'rose-600': '#e11d48', 'rose-700': '#be123c', 'rose-800': '#9f1239', 'rose-900': '#881337', 'rose-950': '#4c0519',
};

// Tightened from v1's earlier 3.0: above ~2.0 brand colors drift visibly, so we
// force an arbitrary value (bg-[#hex]) instead of an approximate palette token.
const DELTA_E_EXACT = 1;
const DELTA_E_CLOSE = 2;

/** Lazily-computed lab values for every palette entry (perf: compute once). */
let labCache: Array<{ name: string; lab: [number, number, number] }> | null = null;

/** The matched palette token plus whether it is perceptually exact. */
export interface PaletteMatch {
	name: string; // "Slate-700" (caller prefixes bg-/text-/border-)
	exact: boolean;
}

/**
 * Finds the nearest tailwind palette token to a css color, or null if no token
 * is within perceptual tolerance (caller should emit an arbitrary value).
 *
 * @param colorValue - any css color string (hex/rgb/hsl; oklch returns null)
 */
export function matchColor(colorValue: string): PaletteMatch | null {
	const hex = parseColor(colorValue);
	if (!hex) return null;

	// Exact hex hit wins immediately.
	for (const [name, palHex] of Object.entries(TAILWIND_COLORS)) {
		if (palHex === hex) return { name, exact: true };
	}

	const [r, g, b] = hexToRgb(hex);
	const lab = rgbToLab(r, g, b);
	let best: { name: string; dist: number } | null = null;
	for (const entry of paletteLab()) {
		const dist = deltaE2000(lab, entry.lab);
		if (!best || dist < best.dist) best = { name: entry.name, dist };
	}
	if (!best || best.dist >= DELTA_E_CLOSE) return null;
	return { name: best.name, exact: best.dist < DELTA_E_EXACT };
}

/**
 * Parses a css color to a 6-digit #hex, or null for colors we cannot/should not
 * match (transparent, currentcolor, oklch/oklab, keywords). Alpha is dropped, 
 * the caller preserves opacity separately.
 *
 * @param value - the css color string
 */
export function parseColor(value: string): string | null {
	const v = value.trim().toLowerCase();
	if (v === 'transparent' || v === 'inherit' || v === 'currentcolor' || v === 'initial' || v === 'unset') return null;

	if (v.startsWith('#')) {
		if (v.length === 4) return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
		return v.length >= 7 ? v.slice(0, 7) : null;
	}
	const rgb = v.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
	if (rgb) {
		return toHex(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]));
	}
	const hsl = v.match(/^hsla?\(\s*([\d.]+)\s*[\s,]+([\d.]+)%\s*[\s,]+([\d.]+)%/);
	if (hsl) {
		const [r, g, b] = hslToRgb(Number(hsl[1]) / 360, Number(hsl[2]) / 100, Number(hsl[3]) / 100);
		return toHex(r, g, b);
	}
	// oklch/oklab and named colors other than white/black: not matched here.
	return null;
}

/** Parse #rrggbb into [r,g,b] 0-255. */
export function hexToRgb(hex: string): [number, number, number] {
	const n = parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** [R,g,b] 0-255 -> CIELAB (D65). */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
	// sRGB -> linear.
	const lin = [r, g, b].map((c) => {
		const cs = c / 255;
		return cs <= 0.04045 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
	}) as [number, number, number];
	// Linear -> XYZ (D65).
	const x = (lin[0] * 0.4124 + lin[1] * 0.3576 + lin[2] * 0.1805) / 0.95047;
	const y = lin[0] * 0.2126 + lin[1] * 0.7152 + lin[2] * 0.0722;
	const z = (lin[0] * 0.0193 + lin[1] * 0.1192 + lin[2] * 0.9505) / 1.08883;
	const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
	const fx = f(x);
	const fy = f(y);
	const fz = f(z);
	return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** ciede2000 perceptual distance between two lab colors. */
export function deltaE2000(lab1: [number, number, number], lab2: [number, number, number]): number {
	const [L1, a1, b1] = lab1;
	const [L2, a2, b2] = lab2;
	const avgL = (L1 + L2) / 2;
	const C1 = Math.hypot(a1, b1);
	const C2 = Math.hypot(a2, b2);
	const avgC = (C1 + C2) / 2;
	const avgC7 = Math.pow(avgC, 7);
	const G = 0.5 * (1 - Math.sqrt(avgC7 / (avgC7 + Math.pow(25, 7))));
	const a1p = a1 * (1 + G);
	const a2p = a2 * (1 + G);
	const C1p = Math.hypot(a1p, b1);
	const C2p = Math.hypot(a2p, b2);
	let h1p = (Math.atan2(b1, a1p) * 180) / Math.PI;
	if (h1p < 0) h1p += 360;
	let h2p = (Math.atan2(b2, a2p) * 180) / Math.PI;
	if (h2p < 0) h2p += 360;
	const dLp = L2 - L1;
	const dCp = C2p - C1p;
	let dhp: number;
	if (C1p * C2p === 0) dhp = 0;
	else if (Math.abs(h2p - h1p) <= 180) dhp = h2p - h1p;
	else if (h2p - h1p > 180) dhp = h2p - h1p - 360;
	else dhp = h2p - h1p + 360;
	const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI) / 360);
	const avgCp = (C1p + C2p) / 2;
	let avgHp: number;
	if (C1p * C2p === 0) avgHp = h1p + h2p;
	else if (Math.abs(h1p - h2p) <= 180) avgHp = (h1p + h2p) / 2;
	else if (h1p + h2p < 360) avgHp = (h1p + h2p + 360) / 2;
	else avgHp = (h1p + h2p - 360) / 2;
	const T =
		1 -
		0.17 * Math.cos(((avgHp - 30) * Math.PI) / 180) +
		0.24 * Math.cos((2 * avgHp * Math.PI) / 180) +
		0.32 * Math.cos(((3 * avgHp + 6) * Math.PI) / 180) -
		0.2 * Math.cos(((4 * avgHp - 63) * Math.PI) / 180);
	const SL = 1 + (0.015 * Math.pow(avgL - 50, 2)) / Math.sqrt(20 + Math.pow(avgL - 50, 2));
	const SC = 1 + 0.045 * avgCp;
	const SH = 1 + 0.015 * avgCp * T;
	const avgCp7 = Math.pow(avgCp, 7);
	const RT =
		-2 *
		Math.sqrt(avgCp7 / (avgCp7 + Math.pow(25, 7))) *
		Math.sin((60 * Math.exp(-Math.pow((avgHp - 275) / 25, 2)) * Math.PI) / 180);
	return Math.sqrt(
		Math.pow(dLp / SL, 2) + Math.pow(dCp / SC, 2) + Math.pow(dHp / SH, 2) + RT * (dCp / SC) * (dHp / SH),
	);
}

/** Build (and cache) the lab value for every palette entry. */
function paletteLab(): Array<{ name: string; lab: [number, number, number] }> {
	if (labCache) return labCache;
	labCache = Object.entries(TAILWIND_COLORS).map(([name, hex]) => {
		const [r, g, b] = hexToRgb(hex);
		return { name, lab: rgbToLab(r, g, b) };
	});
	return labCache;
}

/** Clamp + format three channels to #rrggbb. */
function toHex(r: number, g: number, b: number): string {
	return `#${[r, g, b].map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`;
}

/** Hsl (0-1 each) -> [r,g,b] 0-255. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
	const hue = (p: number, q: number, t: number): number => {
		if (t < 0) t += 1;
		if (t > 1) t -= 1;
		if (t < 1 / 6) return p + (q - p) * 6 * t;
		if (t < 1 / 2) return q;
		if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
		return p;
	};
	if (s === 0) return [l * 255, l * 255, l * 255];
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
}
