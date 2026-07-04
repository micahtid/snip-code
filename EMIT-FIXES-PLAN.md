# Emit-layer fixes: text fill colour + transition timing

Two systemic defects in the reconcile/bake emit layer. Both predate the humanize
work, both hit multiple corpus bundles, both are one principled, ground-truth change
rather than per-site patchwork. Each fix ships behind a render-verify feedback loop:
change, render the affected bundles, confirm the pixels against the original, adjust.

The mechanisms below were confirmed against the live engine, not assumed.

## Fix A: a root colour that only follows `currentcolor` is frozen concrete

### Symptom
A light-coloured button paints its label dark. Confirmed on supermemory
("Start Building" plus three more), sumup ("Loading", "Get SumUp Connected"), gitlab
("Try for free").

### Root cause
`-webkit-text-fill-color` initial value is `currentcolor`: unless set, it follows
`color`. On the live page the root's fill just followed the root's dark `color`, and
each button's fill just followed its own light `color`.

`bakeInheritedDivergence` (reconcile/bake.ts) sees the root's computed fill diverges
from the ua default and bakes it onto the root as a concrete dark colour. That
concrete value inherits down and overrides every descendant, because a descendant
that sets only `color` no longer has its fill tracking along. The button keeps its
light `color` but inherits the frozen dark fill and paints dark.

Verified: with only `color` set on root and child, the child's computed fill follows
its own colour (white); baking a concrete fill on the root flips the child to dark;
removing that root fill restores the child to white.

### Change
In `bakeInheritedDivergence`, extend the existing skip conditions: alongside
`rootVal === defaultVal`, also skip when `rootVal === rootComputed color`, i.e. the
property is merely resolving from `currentcolor`. The baked `color` (itself an
inherited divergence, baked in the same pass) already carries the value down
correctly, so freezing the colour-derived property is both redundant and harmful.

### Why this is universal and clean
- The condition is `value === computed color`, read from ground truth. No property
  list, no per-site branch: it fires for every `currentcolor`-derived inherited
  property (`-webkit-text-fill-color`, `-webkit-text-stroke-color`, `caret-color`,
  `text-emphasis-color`, `-webkit-tap-highlight-color`) and, by construction, never
  for a non-colour property, whose value can never equal the colour string.
- It mirrors the guard already on the line above it (`rootVal === defaultVal`), so it
  reads as a natural extension, not a special case.
- Output shrinks slightly (one fewer baked declaration on the root); nothing grows.
- A root that carries a genuinely different explicit fill (`fill != color`) still
  bakes, so real explicit fills are preserved.

### Gaps considered
- An explicit descendant fill (e.g. cluely's transparent gradient text) is captured
  per element by `bakeElement` from the authored cascade, on a different path, so the
  root-only guard cannot touch it. cluely is the mandatory regression check.
- The fix depends on `color` being baked on the root; it is, in the same divergence
  pass, so the value still reaches descendants.

### Feedback loop
1. Re-confirm the mechanism on supermemory after the build (computed `color` vs fill
   on the flagged span).
2. Apply, rebuild.
3. Re-render supermemory, sumup, gitlab: flagged labels must paint their light
   colour; compare against each bundle's original.jpg.
4. Re-render cluely: gradient text unchanged (fill still transparent, gradient shows).
5. Full corpus render + existing pixel backstop: 23/23 hold, no new drift.
6. Report render evidence, pause for direction before commit.

## Fix B: the `transition` shorthand loses per-property timing

### Symptom
On hover, colour eases but background/border/fill/gradient snap, a choppy
half-animated flash. Confirmed on hoverdev-2, cluely, ai-cofounder, superset,
supermemory.

### Root cause
Tailwind's colour transition sets a multi-entry `transition-property` list with a
single `transition-duration` (0.15s), which CSS cycles across all properties. When
all five transition longhands are present, the CSSOM folds them into the `transition`
shorthand as it serialises; with mismatched list lengths it writes the duration only
on the first layer:
`color 0.15s cubic-bezier(...), background-color, border-color, ...`. Re-parsed in the
output sheet, every bare layer takes the initial duration `0s` and snaps.

Verified: computed `transition-duration` is not expanded (stays `0.15s` for five
properties), so nothing downstream expands it for us; and the folded shorthand,
re-parsed, gives the trailing properties `0s`.

### Change
Before the longhands are folded, expand the shorter sub-lists
(`transition-duration`, `-timing-function`, `-delay`, `-behavior`) to the
`transition-property` list length by CSS cycling. The CSSOM then folds losslessly to
`color 0.15s cubic, background-color 0.15s cubic, ...`, and every property animates.

Verified: with all sub-lists padded to the property length, the folded shorthand
re-parses to the full duration on every property.

Location: the lossy fold happens at CSSOM serialisation, so the expansion must run at
or before the first serialisation. Step 1 confirms whether the lossy string is
already present in `assembled.css` (BEM assembly serialises the baked longhands) or is
introduced later; the expansion then lands at that source. The natural home is a
small, self-contained transform mirroring `minimize/logical.ts`: a targeted,
spec-equivalent rewrite of one property family, deterministic and key-free.

### Why this is universal and clean
- Cycling is exactly the rule the engine already applies, so the rewrite is
  render-neutral by construction, no property table and no per-site tuning, and the
  computed-style oracle verifies it as a backstop just as `logical.ts` and
  `normalize.ts` do.
- It only redistributes timing the original already declared; it never adds motion to
  a property the original left static. A single-property transition stays single.
- `transition-property: all` or a single-entry property list needs no expansion and is
  left untouched.

### Gaps considered
- `transition-behavior` is the newest longhand; only pad it when present, so an engine
  that omits it is unaffected.
- The resting render has no motion, so this cannot shift the pixel backstop; its proof
  is a hover-time measurement, not a still.

### Feedback loop
1. On the live original (or its computed capture), read the real per-property
   `transition-duration` for a flagged element to establish the target truth.
2. Apply, rebuild.
3. Re-render a flagged bundle, drive hover, sample background/fill/border over time:
   they must ease over the real duration, not snap.
4. Confirm no property gained motion the original lacked.
5. Full corpus render + pixel backstop (resting render unaffected, 23/23 hold);
   confirm byte-determinism across two runs.
6. Report, pause for direction before commit.

## Sequencing
1. Fix A first: a ~3-line guard in one function, fully self-contained, through its
   loop.
2. Then Fix B: the transition-list expansion, through its loop.
3. Neither is committed without explicit go-ahead; changes stay in the working tree
   with render evidence attached for review.
