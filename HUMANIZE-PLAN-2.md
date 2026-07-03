# HUMANIZE-PLAN-2: candidate extensions, decide after HUMANIZE-PLAN M1

**Do not execute this plan yet.** It parks the ideas that came out of the HUMANIZE-PLAN
design discussion but were deliberately kept out of its scope. The decision point is after
HUMANIZE-PLAN's M1 measurements exist: the numbers there determine which of these matters
most, and in what order. Everything in HUMANIZE-PLAN's ground rules (section 3) and feedback
loop (section 5) applies verbatim here.

## Decision signals from M1

- If minimized output is already close to human-readable and the remaining offense is
  naming and grouping, extension 1 is next.
- If the HTML itself dominates the machine feel (wrapper soup, numbered sibling classes),
  extensions 2 and 3 are next.
- If the CSS reads mechanical because of how layout is expressed rather than how much of it
  there is, extension 4 is next.

## Extension 1: authored-CSS intent matching (highest expected value)

The original page's CSS was written by a human, and the capture phase already collects it:
`captured.componentRules` holds the site's authored rules and `element.classList` holds the
real class names. The reproduce path bakes computed styles and discards that structure. After
minimization, match surviving declarations back to the authored rules they came from and
adopt what the author wrote:

- **Names:** an element whose surviving declarations trace to the authored `.card` rule can
  be named `card` instead of a generated `block__tag-n`, with collision handling.
- **Grouping:** declarations that co-occurred in one authored rule belong together in one
  emitted rule, in the author's order.
- **Values:** where an authored declaration's computed result equals the minimized value,
  prefer the authored spelling, such as `gap: 1.5rem` over a computed equivalent.

This recovers true intent instead of guessing it, and shrinks the final LLM naming job to
near nothing. Verification is unchanged: every adoption is a candidate edit that must pass
the computed-style oracle. Risks: authored rules may be cross-origin-blocked (tracked in
`captured.inaccessible`), minified sites have meaningless class names (fall back to
generated names), and utility-class sites such as Tailwind name nothing semantically (the
grouping signal still helps; the naming signal does not).

## Extension 2: HTML tree minimization

HUMANIZE-PLAN only minimizes CSS; wrapper-div soup is the other half of what reads as
machine-generated. The same delta-debugging principle applies to elements: try unwrapping an
element (promote its children into its place), keep the unwrap when the oracle passes.
Candidates are elements that paint no ink of their own and carry no surviving declarations
after minimization. Constraints that make this riskier than CSS deletion, and why it waits:

- Selectors, state markers (`data-snip-state`, `data-snip-pseudo`), and measured-state
  triggers reference the tree; every unwrap must rewrite or re-verify them.
- The structural zip in the oracle must compare trees of different shapes, so the compare
  keys on the surviving elements rather than lockstep traversal.
- Semantics: never unwrap elements with ARIA roles, event-bearing tags such as `a` and
  `button`, or landmark tags.

## Extension 3: sibling class merging

After minimization, numbered sibling classes such as `.grid__group-1--1` through `--8` often
have identical bodies. A human writes one `.card` used eight times. Mechanics: hash each
class's surviving declaration set, merge identical ones into a single class, rewrite the HTML
class attributes, and verify with the oracle. Near-identical siblings (one or two divergent
declarations) split into the shared class plus a small modifier class, which is exactly the
human idiom. This composes with extension 1: the merged class is the natural adoption target
for an authored name.

## Extension 4: idiom substitution

Oracle-verified swaps from computed-style expression toward how humans write layout:

- Repeated child margins in one axis -> parent `gap`, when the parent is already flex or grid
  and the render is unchanged.
- Symmetric horizontal margins that resolve to centering -> `margin-inline: auto`.
- Absolute-position offsets that duplicate normal-flow geometry -> remove the positioning.
- Equal grid tracks -> `repeat(n, ...)`.

Each substitution is a candidate edit through the same accept-or-restore loop as deletion, so
none of it can regress rendering. This extends HUMANIZE-PLAN's relax milestone rather than
replacing it; keep the substitutions table-driven and universal, never keyed to a site.

## Ledger

Append decision notes and measurements here once HUMANIZE-PLAN M1 numbers exist.

### Jul 2 2026: byte attribution + direction research

Measured where the shipped stylesheet's bytes actually live, corpus-wide, on the existing
outputs plus fresh minimized snips. The style rules HUMANIZE-PLAN minimizes are a small
fraction of the file; the reported 46.7% decl removal operates on that fraction only.

- @font-face data uris: 78.8% of all output css (11.0MB of 14.0MB). gitlab's 427KB sheet
  is 423KB one embedded font. splitAssets lifts data:image only; fonts are never lifted.
- Style rules: 20.7%. The minimizer's 37-47% shrink applies here.
- @property registrations: 0.4% of bytes but 757 rules corpus-wide, 67-123 per
  tailwind-based bundle, almost all dead after prune removed their --tw-* usage sites.
- Measured-state duplication: shadcn emits 63 state rules with only 4 distinct bodies;
  merge withholds state rules, so none collapse.

Syntactic simulation of four candidate transforms on the minimized, font-lifted readable
slice (ceilings, no oracle): dead-@property purge, identical-body state merge, var
inlining + custom-property drop, tracking-color removal. Additional shrink: shadcn -59%,
hoverdev-2 -37%, zapier -18%, stripe -10%.

External research (two surveys, sources in session notes): no product or paper closes a
render-verification loop on extracted components, so the oracle is the differentiator and
stays. Pixel-exact acceptance provably forces frozen geometry (matches the M4 and
reconstruct findings); the literature's fix is a two-tier judge, hard structural gate plus
soft perceptual gate. Transferable ideas: multi-viewport verification to melt frozen
geometry into responsive css (css-ratiocinator's breakpoint sampling), LLM-proposes/
oracle-disposes hybrid reduction (LPR, arXiv 2312.13064), per-property visual relevance
(Ply, UIST '18). Var inlining is safe here because resolved values are per-usage-site
ground truth, strictly better than postcss's static resolution; reset-preamble injection
(add a canonical reset, then let the pruner delete the restatements it obsoletes) appears
novel. Prefer rounding over deletion for geometry relaxation.

Decision: extend deterministically before any llm rewrite. Order: font lifting in
splitAssets, dead-@property purge, state-rule merge, var inlining, reset preamble +
alias-property oracle awareness, logical-to-physical folding, then extensions 1 and 3,
then tolerant geometry. A perceptually-verified llm rewrite remains a candidate opt-in
mode after those land, never the default path.
