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
