# Tasks

## To Do

### 1. Fix code-block output for JSX and Vue formats

**Problem:** After a snip, the result panel shows broken code when the chosen format is
`jsx-tailwind`, `jsx-css`, or `vue`. It wraps the component in a stray `<style>…</style>` tag that
does not belong there.

**Why:** The panel displays the pipeline's "composed document" (`<style>…</style>` + markup). That
is correct for `html`, `tailwind`, and `bem` formats, but JSX and Vue put their code in a different
field, so wrapping them in an HTML `<style>` tag produces invalid output.

**Fix:** For JSX/Vue, show the component code itself (the `html` field) plus its CSS separately. Keep
the composed document only for the HTML-family formats.

**Where:** `src/components/ResultPanel.tsx` (the `code` value). Output is shipped from
`src/content/index.ts` (`shipResult`).

---

## Notes / Decisions

### Readable output: de-noise (reconcile) + formatter (convert)

Snip output is now both de-noised and indented, deterministically, with no rendered-pixel change.

- **De-noise** (`src/content/reconcile/denoise.ts`, run after `runFeatures`): drops baked
  declarations that render identically when removed, measured against ground truth. A non-inherited
  value is dropped when it equals the per-tag ua default (read from an off-screen probe element); an
  inherited value when it equals the immediate parent's computed value. The shared, render-safe
  decision lives in `isRedundantDecl` in `reconcile/match.ts` and is reused by `features/pseudo.ts`.
  The snip root keeps its inherited values (it loses its ancestor chain). `features/pseudo.ts` now
  de-noises every pseudo (not just `::before`/`::after`) against the same ground truth via
  `pseudoDefaults` (a per-pseudo ua probe) and `effectiveInherited`, so `::placeholder`/`::marker`
  shed their inert noise (`content: normal`, `list-style-type: disc`, ...) while keeping real color
  and spacing.
- **Formatter** (`src/content/convert/format.ts`, run after polish via `assembleHtmlDocument`):
  pretty-prints both markup and stylesheet and composes the final document, all render-neutrally and
  gated to html-shaped formats via `isHtmlShaped` (jsx/vue self-indent). (1) Markup is indented one
  element per line where it is safe (all-block children, no significant text); a block element whose
  only content is text puts that text on its own line (a block trims its edge whitespace);
  inline/mixed content and whitespace-sensitive tags/`white-space:pre*` and injected nodes are emitted
  verbatim. It reads each element's effective `display`/`white-space` (inline style for `html`, the
  flat class rules for class-based formats) to decide. (2) The stylesheet is re-emitted one
  declaration per line (`formatCss`), splitting the cssom-serialized declaration block on top-level
  semicolons so a `;` inside a url()/data-uri/string never splits a value. (3) The reconcile-injected
  pseudo `<style>` is lifted out of the markup into the single head stylesheet (`liftEmbeddedStyles`),
  so all css lives in one place rather than both before and after the markup. Pseudo rules target
  pseudo-elements only, so their cascade position cannot change.

The **`html`** format is the default (`src/utils/storage.ts`) and emits the BEM output directly: a
self-contained HTML file with a `<style>` block of semantic BEM classes and indented markup, the most
human-readable format. `emitFormat` routes both `html` and the legacy `bem-css` value to the same BEM
emitter, so `bem-css` is no longer a separate dropdown choice (`components/SettingsView.tsx`); choosing
"html" is how you get BEM output, and it previews in a new tab like any self-contained document
(`components/ResultPanel.tsx`). The inline-styled emitter is retained as the grader's render-parity
reference only (`runHeadless` calls it directly). Stored snippets keep their own format.

Making `bem-css` the default surfaced two latent bem-emitter bugs that left the output unstyled, both
now fixed: (1) `cleanCss` matched selectors against `captured.clone`, but the bem emitter generates its
classes on a private copy, so every `.block__el` rule was wrongly pruned as dead code; the cleaner now
matches against the emitted markup for the class-based formats (`convert/clean.ts`, `index.ts`). (2)
`sanitize` did not guard a leading digit, so a hashed author class like `15kfc` emitted the invalid
selector `.15kfc`; it now prefixes an underscore (`convert/bem.ts`).

Both run inside the deterministic graded path (`runHeadless`), so `tests/loop.mjs` exercises them
with no ai nondeterminism.

Lossless css reduction (`reconcile/denoise.ts`, `reconcile/features/pseudo.ts`, `convert/bem.ts`): the
de-noise pass now resolves css-wide keywords (`initial`/`inherit`/`unset`) to the value they produce
before the redundancy test, so keyword-form defaults (`outline-color: initial`, `text-decoration-*:
initial`, `border-image: initial`) drop where they match the fallback; it also drops legacy
vendor-prefixed flexbox longhands (`-webkit-box-align` and friends) whenever the standard property sits
beside them. The bem emitter factors a shared base class out of near-identical rules, so the common
declarations of e.g. five button variants ship once as a base with per-member `--modifier` classes. The
split is guarded by a precise shorthand/longhand overlap test (`SHORTHAND_EXPANSIONS` / `overlaps`):
two properties are kept together in the modifier only when one is a shorthand that sets a longhand the
other also sets (so order is render-significant), which lets independent identical longhands
(`border-width` beside a differing `border-radius`, `font-weight` beside a differing `line-height`)
still hoist to the base. All three are render-neutral (every drop equals a measured fallback; the
factoring split is intersection-plus-overlap-guarded) and deterministic, so the graded output stays
byte-stable. The polish prompt is told to keep base + `--modifier` classes paired when renaming.

### Styling approach: inline styles + one injected CSS file

If you are new to this codebase: almost everything is styled with **inline style objects** written
directly on each element (`style={{ … }}`). There are deliberately **no `.css` files** in the source
tree, and `index.html` is kept bare on purpose.

During the v0.3.0 redesign we hit a wall: inline styles **cannot** do `:hover`, `:focus`, scrollbars,
or `@font-face`, and inline styles also **override** any matching stylesheet rule. So interactive
controls (buttons, inputs, the mode toggle) are now styled with **CSS classes** from a single injected
stylesheet, `src/global-css.ts`, while layout and spacing stay inline.

So the styling model is now an intentional **mix**:
- **Layout / spacing / one-off colors** → inline `style={{ … }}`.
- **Interactive controls (hover/focus/disabled states)** → CSS classes like `sc-btn`, `sc-input`,
  `sc-mode` from `src/global-css.ts`.
- **Shared values (colors, fonts, radii)** → `src/theme.ts`, imported by both sides so they stay in
  sync.

This is deliberate, not an accident. When adding a new button, give it the `sc-btn` classes rather
than writing inline hover logic.
