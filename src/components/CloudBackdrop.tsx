/**
 * components/CloudBackdrop.tsx: decorative cloud-sky backdrop
 *
 * Pipeline position: n/a. Ui chrome, not a pipeline phase.
 * Reads from Captured: n/a
 * Writes to Captured: n/a
 *
 * Principles applied: none. Ui only.
 *
 * Why this exists: v1's signature look is a soft procedural cloud sky behind the
 * frosted-glass panel. This reproduces it because the user asked for the same background
 * design. Clouds are generated deterministically from fixed shape/anchor data so
 * the layout is stable across renders, with no Math.random flicker, and identical to
 * v1's. The geometry classes (.cloud-*) live in global-css.ts; per-cloud and
 * per-piece position/blur/opacity are inline because they are data, not style.
 * Static by design: v1's backdrop does not animate, so neither does this.
 */

/** One soft white blob within a cloud cluster, in fractions of the cluster box. */
interface CloudPiece {
	x: number;
	y: number;
	w: number;
	h: number;
	alpha: number;
	gradient: string;
	rotation: number;
}

/** A positioned cluster of pieces, in percentages of the viewport. */
interface Cloud {
	id: number;
	left: number;
	top: number;
	width: number;
	ratio: number;
	opacity: number;
	blur: number;
	pieces: CloudPiece[];
}

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

/**
 * Indexes into a non-empty template list, wrapping with modulo so any id maps to a
 * real entry. The throw is unreachable for the constant lists below but lets the
 * type checker prove the result is defined without a non-null assertion; the rest
 * of the codebase avoids `!`.
 *
 * @param list - a non-empty constant template list
 * @param i - any index; wrapped into range
 */
function at<T>(list: readonly T[], i: number): T {
	const item = list[((i % list.length) + list.length) % list.length];
	if (item === undefined) throw new Error('cloud template list is empty');
	return item;
}

/** Base blob templates: the body of a cloud. One is chosen per cluster. */
const SHAPES: Array<Array<Omit<CloudPiece, 'gradient' | 'rotation'>>> = [
	[
		{ x: 0.08, y: 0.52, w: 0.46, h: 0.4, alpha: 0.84 },
		{ x: 0.24, y: 0.12, w: 0.46, h: 0.54, alpha: 0.96 },
		{ x: 0.46, y: 0.06, w: 0.44, h: 0.52, alpha: 0.9 },
		{ x: 0.62, y: 0.36, w: 0.34, h: 0.36, alpha: 0.74 },
	],
	[
		{ x: 0.04, y: 0.5, w: 0.5, h: 0.44, alpha: 0.86 },
		{ x: 0.22, y: 0.1, w: 0.5, h: 0.58, alpha: 0.98 },
		{ x: 0.48, y: 0.14, w: 0.44, h: 0.5, alpha: 0.9 },
		{ x: 0.64, y: 0.42, w: 0.34, h: 0.36, alpha: 0.76 },
	],
	[
		{ x: 0.1, y: 0.52, w: 0.46, h: 0.38, alpha: 0.82 },
		{ x: 0.28, y: 0.12, w: 0.42, h: 0.52, alpha: 0.92 },
		{ x: 0.5, y: 0.08, w: 0.46, h: 0.56, alpha: 0.95 },
		{ x: 0.66, y: 0.36, w: 0.32, h: 0.36, alpha: 0.72 },
	],
	[
		{ x: 0.06, y: 0.54, w: 0.48, h: 0.4, alpha: 0.86 },
		{ x: 0.24, y: 0.2, w: 0.44, h: 0.52, alpha: 0.92 },
		{ x: 0.48, y: 0.04, w: 0.48, h: 0.58, alpha: 0.94 },
		{ x: 0.64, y: 0.34, w: 0.34, h: 0.4, alpha: 0.76 },
	],
];

/** Smaller accent puffs layered over a shape for detail. */
const PUFFS: Array<Array<Omit<CloudPiece, 'gradient' | 'rotation'>>> = [
	[
		{ x: 0.14, y: 0.16, w: 0.2, h: 0.22, alpha: 0.6 },
		{ x: 0.66, y: 0.18, w: 0.2, h: 0.22, alpha: 0.56 },
	],
	[
		{ x: 0.12, y: 0.2, w: 0.22, h: 0.24, alpha: 0.62 },
		{ x: 0.56, y: 0.08, w: 0.22, h: 0.24, alpha: 0.58 },
		{ x: 0.72, y: 0.28, w: 0.18, h: 0.2, alpha: 0.5 },
	],
	[
		{ x: 0.2, y: 0.08, w: 0.2, h: 0.22, alpha: 0.58 },
		{ x: 0.7, y: 0.12, w: 0.22, h: 0.24, alpha: 0.54 },
	],
];

/** Per-cluster squash/skew so repeated shapes do not read as identical. */
const VARIANTS = [
	{ ox: -0.04, oy: 0.02, sx: 1.12, sy: 0.86, lean: -0.08 },
	{ ox: 0.04, oy: -0.02, sx: 0.92, sy: 1.08, lean: 0.05 },
	{ ox: -0.02, oy: 0.03, sx: 1.06, sy: 0.9, lean: -0.04 },
	{ ox: 0.02, oy: 0.04, sx: 1.1, sy: 0.88, lean: 0.04 },
	{ ox: 0.05, oy: -0.03, sx: 0.9, sy: 1.12, lean: 0.08 },
	{ ox: -0.05, oy: 0.04, sx: 1.15, sy: 0.84, lean: -0.1 },
];

const GRADIENTS = [
	'radial-gradient(circle at 50% 50%, rgba(255,255,255,0.92) 0%, rgba(255,255,255,0.6) 42%, rgba(255,255,255,0) 78%)',
	'radial-gradient(circle at 52% 45%, rgba(255,255,255,0.96) 0%, rgba(255,255,255,0.55) 48%, rgba(255,255,255,0) 76%)',
	'radial-gradient(circle at 48% 52%, rgba(255,255,255,0.9) 0%, rgba(255,255,255,0.5) 44%, rgba(255,255,255,0) 80%)',
];

/**
 * The eight cloud anchors: horizontal position, size, and depth/blur/opacity that
 * place each cluster along a gentle horizon curve, with back clouds higher and blurrier.
 */
const ANCHORS = [
	{ x: -12, size: 120, lift: 16, template: 2, puff: 1, variant: 2, opacity: 0.16, blur: 34, ratio: 0.28, base: 6, depth: 34, baseW: 1.2, baseH: 1.35, baseShift: 0.08 },
	{ x: 48, size: 112, lift: 26, template: 3, puff: 2, variant: 3, opacity: 0.18, blur: 30, ratio: 0.27, base: 7, depth: 36, baseW: 1.1, baseH: 1.3, baseShift: 0.06 },
	{ x: 108, size: 118, lift: 18, template: 1, puff: 0, variant: 1, opacity: 0.16, blur: 36, ratio: 0.29, base: 6, depth: 32, baseW: 1.18, baseH: 1.34, baseShift: 0.07 },
	{ x: 8, size: 94, lift: -8, template: 0, puff: 1, variant: 4, opacity: 0.34, blur: 18, ratio: 0.32, base: 14, depth: 46, baseW: 0.88, baseH: 0.96, baseShift: -0.02 },
	{ x: 56, size: 90, lift: -6, template: 2, puff: 0, variant: 0, opacity: 0.38, blur: 16, ratio: 0.33, base: 16, depth: 48, baseW: 0.9, baseH: 1.0, baseShift: -0.02 },
	{ x: 92, size: 84, lift: -12, template: 1, puff: 2, variant: 5, opacity: 0.42, blur: 14, ratio: 0.34, base: 18, depth: 52, baseW: 0.82, baseH: 0.92, baseShift: -0.04 },
	{ x: 28, size: 70, lift: -18, template: 3, puff: 1, variant: 2, opacity: 0.6, blur: 10, ratio: 0.38, base: 22, depth: 58, baseW: 0.7, baseH: 0.82, baseShift: -0.06 },
	{ x: 72, size: 66, lift: -20, template: 0, puff: 0, variant: 3, opacity: 0.64, blur: 8, ratio: 0.38, base: 24, depth: 60, baseW: 0.66, baseH: 0.78, baseShift: -0.08 },
];

/**
 * Expands one anchor into a positioned cluster of pieces. Integer seeds drive the
 * jitter deterministically, so the sky is identical every render. The horizon curve
 * lifts edge clouds and seats centre clouds lower for a domed sky.
 */
function buildCloud(anchor: (typeof ANCHORS)[number], id: number): Cloud {
	const position = (clamp(anchor.x, 0, 100) - 50) / 50;
	const curve = Math.pow(1 - position * position, 2.6);
	const edgeLift = Math.pow(Math.abs(position), 1.2) * 8;
	const top = clamp(anchor.base + anchor.depth * curve - edgeLift + anchor.lift, 2, 88);
	const variant = at(VARIANTS, anchor.variant);

	// A soft base band beneath the body so clouds sit on a flat bottom.
	const basePieces: Array<Omit<CloudPiece, 'gradient' | 'rotation'>> = [];
	const baseCount = 2 + (id % 3);
	for (let i = 0; i < baseCount; i++) {
		const seed = id * 11 + i * 5;
		basePieces.push({
			x: 0.06 + (0.78 / baseCount) * i + ((seed * 7) % 12) / 100,
			y: 0.58 + anchor.baseShift + ((seed * 3) % 10) / 100,
			w: (0.32 + ((seed * 9) % 18) / 100) * anchor.baseW * 1.4,
			h: (0.18 + ((seed * 13) % 12) / 100) * anchor.baseH,
			alpha: 0.4,
		});
	}

	// Scattered small blobs for a textured, non-uniform silhouette.
	const noisePieces: Array<Omit<CloudPiece, 'gradient' | 'rotation'>> = [];
	const noiseCount = 2 + (id % 4);
	for (let i = 0; i < noiseCount; i++) {
		const seed = id * 19 + i * 7;
		noisePieces.push({
			x: ((seed * 17) % 88) / 100,
			y: ((seed * 29) % 72) / 100,
			w: 0.08 + ((seed * 5) % 10) / 100,
			h: 0.08 + ((seed * 11) % 10) / 100,
			alpha: 0.26,
		});
	}

	const pieces: CloudPiece[] = [
		...basePieces,
		...at(SHAPES, anchor.template),
		...at(PUFFS, anchor.puff),
		...noisePieces,
	].map((piece, index) => {
		const seed = id * 97 + index * 17;
		const r1 = ((seed * 13) % 100) / 100;
		const r2 = ((seed * 23) % 100) / 100;
		const r3 = ((seed * 41) % 100) / 100;
		return {
			x: clamp(piece.x * variant.sx + variant.ox + variant.lean * (1 - piece.y), -0.14, 1.12),
			y: clamp(piece.y * variant.sy + variant.oy, -0.12, 1.12),
			w: piece.w * variant.sx * (0.86 + r1 * 0.3),
			h: piece.h * variant.sy * (0.86 + r2 * 0.3),
			alpha: piece.alpha * (0.6 + r3 * 0.5),
			gradient: at(GRADIENTS, seed),
			rotation: ((seed * 19) % 50) - 25,
		};
	});

	return { id, left: anchor.x, top, width: anchor.size, ratio: anchor.ratio, opacity: anchor.opacity, blur: anchor.blur, pieces };
}

/** Generated once at module load: the eight clusters that make up the sky. */
const CLOUDS: Cloud[] = ANCHORS.map(buildCloud);

/** Renders the fixed sky gradient and the eight procedural cloud clusters behind the ui. */
export function CloudBackdrop() {
	return (
		<div className="cloud-backdrop" aria-hidden="true">
			<div className="cloud-sky" />
			<div className="cloud-field">
				{CLOUDS.map((cloud) => (
					<div
						key={cloud.id}
						className="cloud-cluster"
						style={{
							left: `calc(${cloud.left}% - ${cloud.width / 2}%)`,
							top: `${cloud.top}%`,
							width: `${cloud.width}%`,
							aspectRatio: (1 / cloud.ratio).toFixed(3),
							opacity: cloud.opacity,
							filter: `blur(${cloud.blur}px)`,
						}}
					>
						{cloud.pieces.map((piece, index) => (
							<span
								key={index}
								className="cloud-piece"
								style={{
									left: `${piece.x * 100}%`,
									top: `${piece.y * 100}%`,
									width: `${piece.w * 100}%`,
									height: `${piece.h * 100}%`,
									opacity: piece.alpha,
									background: piece.gradient,
									transform: `rotate(${piece.rotation}deg)`,
								}}
							/>
						))}
					</div>
				))}
			</div>
		</div>
	);
}
