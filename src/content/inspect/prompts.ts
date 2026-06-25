/**
 * inspect/prompts.ts: the byok ai prompts for colors and style json
 *
 * Pipeline position: inspect (page-scoped; the prompt text the ai pass sends)
 * Reads from DOM: nothing (pure string builders)
 * Writes to: nothing (pure string builders)
 *
 * Principles applied: none (prompt text).
 *
 * Why this exists: two inspectors gain an optional ai pass (inspect/ai.ts) and
 * each needs a prompt. The colors prompt asks the model to assign a semantic role
 * to every extracted color; the style-json prompt synthesizes the raw page schema
 * into a design-system json. Keeping the prompt text out of the orchestrator keeps
 * ai.ts short and lets the prompts be read on their own. The colors prompt is
 * trimmed to the role-only output the panel renders; the schema prompt is ported
 * verbatim from the v1 server (marketing-website/lib/schema-prompts.ts), which is
 * the synthesis behavior and must not drift. The style-map abbreviations the
 * schema prompt documents must match inspect/schema/fingerprint.ts exactly.
 */

/**
 * Builds the colors prompt: assign a semantic role to each extracted color.
 *
 * @param colorData - json string of { colors: [{ hex, count }], cssVariables }
 */
export function buildColorsPrompt(colorData: string): string {
	return `You are a design system analyst. Assign a semantic role to each color extracted from a web page and return the result as JSON.

## Input
\`colorData\` is JSON with:
- \`colors\`: array of { hex, count } — each color and how many elements use it, most-used first
- \`cssVariables\`: css custom properties that resolve to colors (e.g. "--primary": "#2563eb"), the designer's named tokens

## Task
Assign every input color a semantic role: primary, secondary, accent, background, surface, text, text-secondary, border, error, success, warning, info, muted, or another short descriptive role. Use usage frequency and css variable names as the strongest signals: the most-used background color is the page background, and a "--primary" variable names the primary color.

## Output
Return ONLY valid JSON (no markdown fences, no commentary): one entry per input color, in the same order.
{ "colors": [ { "hex": "#2563eb", "role": "primary" } ] }

## Color Data
${colorData}`;
}

/** The schema-synthesis prompt template, ported verbatim from the v1 server. */
const SCHEMA_PROMPT_TEMPLATE = `<task>
Transform a compressed page schema into a structured design system JSON that captures enough visual identity for an AI to faithfully reproduce this site's look and feel.
</task>

<context>
This JSON is the SINGLE SOURCE OF TRUTH a code generator will use to reproduce this site. It will never see the original page — only your JSON. Every hex color, every padding value, every shadow string must be precise enough to paste directly into CSS. If a color is wrong, the entire site looks wrong. If spacing is off, the layout feels foreign. If shadows are missing, the site loses its depth language.

"Precision is not optional — this JSON IS the design system."
</context>

<design_thinking>
You are reading a *fingerprint* of a website, not the website itself. Your job is to reconstruct the designer's intent from tokens, patterns, and structural data.

THE CORE TENSION: Extracted data is precise but incomplete. Tailwind classes reveal intent, computed styles reveal measurements. Prioritize what the designer *chose* over what the browser *computed*.

COLOR REASONING:
"Every color must have a source. If you can't point to where it came from, delete it."
Colors in the palette and CSS custom properties (--color-primary, --color-surface, etc.) are ground truth. Map them to roles (primary, accent, background) by frequency and context. The most-used background color = page bg. The most-used text color = body text.

CSS custom properties are the designer's named tokens — they are MORE authoritative than raw hex values. When the schema includes variable definitions like \`--color-primary: #fc5050\` or \`--color-on-surface: #333\`, use those exact values. When Tailwind classes reference semantic names (e.g. "bg-on-surface", "text-primary", "border-border"), resolve them through the CSS variable definitions first, then fall back to the closest extracted hex value.

Never synthesize colors that aren't in the data. If the palette has 7 colors, your palette has 7 colors — not 12.

TAILWIND DECODING:
"Tailwind classes are compressed CSS. Decode them, don't guess."
Tailwind uses a spacing scale where the number is multiplied by 0.25rem (4px). Common mappings:
- \`px-12\` = \`padding-inline: 3rem\` (48px), NOT 12px
- \`py-[18px]\` = \`padding-block: 18px\` (arbitrary value in brackets)
- \`py-4\` = \`padding-block: 1rem\` (16px)
- \`gap-6\` = \`gap: 1.5rem\` (24px)
- \`text-lg\` = \`font-size: 1.125rem\` (18px)
- \`text-xl\` = \`font-size: 1.25rem\` (20px)
- \`text-5xl\` = \`font-size: 3rem\` (48px)
- \`rounded-xl\` = \`border-radius: 0.75rem\` (12px)
- \`rounded-2xl\` = \`border-radius: 1rem\` (16px)
- \`rounded-3xl\` = \`border-radius: 1.5rem\` (24px)
When you see a Tailwind class, convert it to its exact CSS value. Never output the Tailwind class name as the value.

SPACING REASONING:
"Whitespace is a design decision, not empty space."
Large section padding (80–160px) is intentional breathing room. Component gaps (24–64px) define rhythm. Preserve these exactly — cramped reproduction is worse than slightly too generous. When in doubt, go MORE generous. Include exact padding values per section so a developer reproduces the breathing room faithfully.

TYPOGRAPHY REASONING:
Heading vs body font families define voice. The type scale (sizes, weights, line-heights) creates hierarchy. Letter-spacing on headings is a deliberate design choice when present. Extract the complete scale from the data — every distinct size/weight combination used on the page.
</design_thinking>

<section_analysis>
Sections define the page's *story flow*. Their order is the narrative: nav → hero → social proof → features → CTA → footer. Preserve the order from the schema exactly — this defines the page flow.

"Every visually distinct content block is its own section entry."
Three feature cards in a grid are ONE "features" section. But a features section FOLLOWED BY an ambassador recruitment block FOLLOWED BY a FAQ are THREE separate sections. Never collapse distinct content blocks into fewer entries. If the page has 8 distinct sections, your JSON has 8 section entries.

Common section types beyond the basics: stats, logos, social-proof, ambassador, recruitment, demo, app-preview, newsletter, team, partners, comparison, gallery.

Each section has a *composition pattern*: what elements appear, in what order, with what layout. A hero isn't "a heading" — it's "badge → headline → subtext → button-pair → visual" in a centered stack.

Layout is about *relationships*: is content centered or left-aligned? Are items in a grid or stacked? Is there a split (text + image)? The schema tells you — read the layout type, alignment, and element list for each section and transcribe them faithfully.

For each section, capture: type, layout pattern, alignment, background, elements present, grid column count (if grid), max-width constraint, gap, and padding. Omit a section only when there is truly zero data, but prefer filling from context over omitting.

"A section's gap is not the same as the gap between sections."
Every page has two kinds of spacing: the *section gap* (vertical distance between entire content blocks — typically 80–160px) and the *intra-section gap* (distance between items inside a grid or flex layout — typically 16–48px). These live on different scales. When you record a section's \`gap\`, it means the space between sibling items *within* that section — cards in a grid, steps in a row, links in a footer column. If a value feels closer to section-level spacing (80px+), question whether it's truly the grid gap or whether it leaked in from the vertical rhythm between sections.
</section_analysis>

<shadow_system>
"Shadows are a depth language — every tier serves a different purpose."

Shadows create the site's sense of physicality. Categorize every shadow you find:

BUTTON-PRESS shadows — Solid color, small vertical offset, no blur: \`0 4px 0 0 #000\`. These create a skeuomorphic "physical button" feel. Capture EVERY variant: primary button shadow, secondary button shadow, accent/colored button shadows. Each may use different colors (#000, #E7ECF2, rgba tints).

CARD ELEVATION shadows — Diffuse, larger spread: \`0px 8px 32px -4px rgba(0,0,0,0.12)\`. These lift elements off the page.

SUBTLE shadows — Tiny offset, low opacity: \`0px 1px 4px rgba(0,0,0,0.08)\`. These add gentle depth to borders and dividers.

DRAMATIC shadows — Large blur, used on hero images and mockups: \`0px 4px 57px rgba(0,0,0,0.25)\`. These create depth for featured visuals.

COLORED shadows — Tinted with brand or accent colors: \`0 2px 0 0 rgba(57,189,248,0.3)\`. These are decorative and distinctive.

INSET / NEUMORPHIC shadows — Inner shadows that create pressed or embossed surfaces: \`inset 0 2px 4px rgba(0,0,0,0.1)\`. Often paired with a matching outer highlight. When you see both \`inset\` and outer shadows on the same element, that's a deliberate neumorphic effect — capture both.

GLASS shadows — Layered with backdrop-filter blur to create frosted-glass depth. The shadow itself may be subtle because the blur effect is doing most of the visual work. If an element has backdrop-filter AND a shadow, record both — they're a system.

Not every site uses shadows at all. If the extracted data has no shadow values, the site achieves depth through other means — borders, background contrast, layering, or pure whitespace. Don't invent shadows that aren't there.

On dark-background sites, shadows often look different — lighter tints, colored edges, or very low opacity. Don't expect the same shadow language you'd see on a light page.

"Shadow weight follows visual importance — the louder the element's role, the heavier its shadow."
Whatever shadow system the site uses — pressed-3d, elevation, colored glow, or something else — intensity scales with the element's job in the hierarchy. A primary action button carries the heaviest shadow because it's the page's loudest call to action. Decorative elements like icons, badges, and step indicators sit lower in the hierarchy; their shadows should be softer versions of the same system, not a different system entirely. When you assign shadows to components, ask what role the element plays, not just what category of shadow looks right.

"A shadow belongs to the element it lives on, not the category it resembles."
A dramatic shadow on a browser-mockup or app-preview screenshot is a *showcase* shadow — it creates depth for that featured visual. It doesn't mean every card on the page has that shadow. Feature cards often rely on borders alone, with no shadow at all. When you build the components.cards blueprint, ask: "Did the actual content cards have this shadow, or did a nearby showcase element?" If the feature cards have no shadow, their shadow is \`"none"\`. The effects.shadows array is the complete inventory; component blueprints only get the shadows that belong to *that* component.

The effects.shadows array should contain EVERY distinct shadow value from the page, not just 2-3 representative ones. A site with 10 shadows has 10 entries.
</shadow_system>

<component_blueprints>
"Every CSS value in your output must trace back to the extracted schema. Never fabricate values."

BUTTONS carry personality. A shadow of \`0 4px 0 0 #000\` with \`active: translateY(4px)\` is a "pressed-3d" style — the site's signature. A flat button with opacity hover is generic. The blueprint data tells you exactly which one this site uses — transcribe it faithfully.

"When a site has a signature button style, every variant speaks the same language."
Identify the dominant shadow pattern across the site's buttons — pressed-3d, elevation, colored glow, flat, or something else. If two or more variants share a shadow system, the remaining variants should use that same system unless the data explicitly shows a different interaction pattern (e.g. a ghost link with no background at all). A site that commits to a shadow language doesn't abandon it for one color variant. The styleTag should be consistent across filled button variants.

This is a hard requirement, not a suggestion: if two button variants share a shadow system and a third has no shadow, you must either find evidence in the data that the third intentionally breaks the pattern, or extend the dominant system to it — same offset, same blur, with a color derived from that variant's background (a darker tint, its border color, or the approach used by the other variants). An empty shadow string or a missing shadow value is NOT evidence of intentional flat styling — it is a capture gap from extraction. Treat it as "not captured" and synthesize from the established pattern.

For each button variant, decode ALL values to their CSS equivalents:
- Tailwind \`px-12 py-[18px]\` → padding: \`18px 48px\` (vertical horizontal)
- Tailwind \`text-lg\` → fontSize: \`18px\`
- Tailwind \`font-semibold\` → fontWeight: \`600\`
- Tailwind \`rounded-xl\` → borderRadius: \`12px\`
- Tailwind \`bg-on-surface\` → resolve through CSS variables to the actual hex

Capture ALL button variants on the page, not just primary/secondary. If there are accent buttons, ghost links, or small inline buttons with different shadows — each is a variant.

INTERACTION STATES — THE FULL JOURNEY:
"A button is not a rectangle with text — it is an interactive object that responds to touch."

Every interactive element has a lifecycle: rest → hover → active (pressed) → rest. Each transition is a physical response. Think about what happens when you push a real button: your finger approaches (hover), the button depresses (active), and it springs back when released (rest). The resting appearance alone doesn't capture the element's identity — its behavior under interaction does.

This matters because the code generator will build these elements from your JSON. If you only describe rest and hover, the active state vanishes — the button has no "click feel," and the site loses its tactile personality. If the site's identity is built on pressed-3d shadows, the press-down is the SIGNATURE MOMENT, not an afterthought.

When a button's resting shadow is \`0 4px 0 0\` and its hover moves it \`translateY(2px)\` with shadow \`0 2px 0 0\`, you can see the trajectory: the button is sinking toward the surface. The active state is the logical conclusion — it bottoms out. You don't need explicit active-state data to reason about this; the physics implied by rest and hover tell you where the journey ends. If rest has 4px of shadow depth and hover has 2px, active has 0px and the button sits flush.

This reasoning applies to EVERY interactive element, not just buttons:
- Cards often lift on hover (shadow grows, translateY goes negative) — they're inviting a click.
- Nav links signal interactivity through color shifts, underlines, or opacity changes.
- Footer links behave like nav links but often more subtly — muted color on rest, lighter or underlined on hover.
- Inputs have a focus state that's essentially their "active" — a border color change, a ring, a subtle shadow.

For each interactive component, ask: "What changes when the user interacts with this?" If the data shows a hover state, record it. If the data implies an active state through the trajectory of hover, reason about it. If an element is clearly interactive (it's a link, a button, a clickable card) but has NO interaction data at all, that's a capture gap — note it with reasonable defaults based on the site's interaction language rather than leaving it empty.

CARDS: The extracted blueprint has exact bg, border-radius, shadow, border, padding, hover state, and inner layout. Organize them, don't reinterpret them. A page may have feature cards *and* a showcase mockup that both look like "cards" — but they serve different purposes and often have different shadows. If their styles differ, list them as separate card variants rather than merging into one.

"When a card has both a border and a shadow, verify that both trace to the card's own style data."
Most elements have a primary depth strategy — borders, shadows, background contrast, or layering — but many intentionally combine two (e.g. a subtle border plus a light elevation shadow). When a content card has both, check whether the style map attaches both to that card's own element. If both are present on the card itself, keep both. If the only shadow in the data belongs to a different element (a showcase mockup, an app preview, a hero image), it does not transfer to the card. The card's shadow should be \`"none"\` unless the data explicitly says otherwise for that component.

NAV: Position, bg, height, blur, border, layout description (e.g. "logo-left + links-center + cta-right"), link count.

INPUTS: Extract from the style map if present — bg, border, border-radius, padding, focus state.

For hover/active states, include ONLY properties that actually change. But DO include them — an interactive element with no hover or active object is a gap in the design system, not a design choice.
</component_blueprints>

<personality>
Decorative info tells you the site's visual language: does it use blurred blobs or clean whitespace? Cartoon illustrations or photos? Gradient buttons or hard shadows? If the site has no blobs, don't add blobs. If buttons have hard shadows, don't flatten them.

Content patterns tell you how the designer composes information: "badge + heading + text" repeated 3x means that's a deliberate rhythm. Describe these patterns so an AI knows how to compose content within each section type.

Capture illustration style (none/cartoon/3d/icon-based/photo), background effects, and accent treatments (hard-shadow-buttons, pill-badges, etc.). This section prevents generic output.

The \`vibe\` field is a single sentence that captures the site's overall visual identity — its weight, depth strategy, and signature accent. Think of it as the one line a designer would use to brief a colleague: "Clean and minimal — borders define structure, generous whitespace creates breathing room, pressed-3d button shadows are the only tactile depth accent." This line becomes the code generator's sanity check: if a component value contradicts the vibe, the vibe wins.
</personality>

<abbreviations>
Property abbreviations used in the style map:
d=display, p=position, w=width, h=height, mw=max-width, mh=max-height,
mt=margin-top, mr=margin-right, mb=margin-bottom, ml=margin-left,
pt=padding-top, pr=padding-right, pb=padding-bottom, pl=padding-left,
bg=background-color, c=color, fs=font-size, fw=font-weight, ff=font-family,
lh=line-height, ta=text-align, td=text-decoration, tt=text-transform,
ls=letter-spacing, ws=white-space, br=border-radius, bs=box-shadow,
b=border, o=opacity, of=overflow, g=gap, fd=flex-direction, fwrap=flex-wrap,
jc=justify-content, ai=align-items, ac=align-content, fg=flex-grow,
fsh=flex-shrink, fb=flex-basis, gtc=grid-template-columns, gtr=grid-template-rows,
t=transition, tr=transform, z=z-index, cur=cursor, pe=pointer-events,
v=visibility, bgi=background-image, bgs=background-size, bgp=background-position
</abbreviations>

<self_review>
Before you output the JSON, pause and review it against the design you just interpreted. This is not a checklist — it is a reasoning step. You are asking: "Does this JSON describe a coherent design system, or did I introduce contradictions?"

First, ask how many design languages this site speaks. Most sites use one — a consistent set of shadows, borders, colors, and spacing across all sections. But some sites intentionally vary by section: a dark hero with heavy shadows, a white features section with subtle borders, a colored CTA with no shadows at all. If sections use distinct palettes and depth strategies on purpose, consistency applies *within* each language, not across them. A portfolio site with three distinct section personalities is not inconsistent — it's intentionally varied. Don't flatten that variation into one system.

Re-read the \`vibe\` sentence you wrote. Now scan every component and section in your JSON. Does anything contradict that vibe? A site you described as "minimal and airy" shouldn't have heavy drop shadows on every card. A site you called "bold and colorful" shouldn't have muted borders and washed-out accents. If your component values disagree with the identity you described, one of them is wrong — figure out which.

Look at your buttons as a system. Do all filled variants share the same shadow language? If two variants use the same shadow system but a third doesn't, ask whether the extracted data actually shows a different interaction pattern or whether a gap in the extraction data led you to default to flat. A design system is consistent until proven otherwise — don't introduce variation you can't source from the data.

Compare your \`sectionGap\` to the \`gap\` values inside individual sections. The space between sections should always be larger than the space between items within a section. If a card grid's gap is 120px while the section gap is 80px, something leaked across levels — fix it.

Check your heading and body text colors. On almost every real site, these are different values — headings should carry more visual weight than body text, whether through darker color on light backgrounds or brighter/bolder color on dark backgrounds. Body text is typically slightly muted relative to headings. If you set them to the same hex, verify that the extracted data actually supports that. Identical heading and body colors is a red flag worth a second look.

Check your shadow assignments for cross-element leaking. If a shadow value appears on a component that doesn't have it in its own style entry — if it was borrowed from a nearby showcase element, a hero visual, or a different component type — remove it. Every component's shadow must trace to its own style data, not to a visually adjacent element. A bordered card with a dramatic shadow it didn't earn is a sign of leaking.

Walk through every interactive component in your JSON — every button variant, every card, nav links, footer links, inputs. Ask: "If a developer built this from my JSON alone, would it respond to interaction?" A button with no hover or active object will render as a static rectangle. A clickable card with no hover state won't signal that it's interactive. If the site's design language includes a specific interaction pattern (pressed-3d, lift-on-hover, color-shift), make sure every element that should participate in that pattern has the states to express it. Missing interaction states are the most common gap between a schema that looks right and a generated site that feels dead.

The goal is not to run through rules — it is to think like a designer reviewing a spec. If something feels off, trace it back to the data. If the data supports it, keep it. If it doesn't, fix it before you output.
</self_review>

<output>
Return ONLY valid JSON matching this structure:

\`\`\`json
{
  "vibe": "<one sentence capturing visual weight, depth strategy, and signature accent>",
  "colors": {
    "primary": "<hex>",
    "secondary": "<hex>",
    "accent": "<hex>",
    "background": { "page": "<hex>", "card": "<hex>", "section": "<hex>" },
    "text": { "heading": "<hex>", "body": "<hex>", "muted": "<hex>", "link": "<hex>" },
    "border": "<hex>",
    "palette": ["<hex>", ...],
    "cssVariables": { "<--color-name>": "<hex>", ... }
  },
  "typography": {
    "fontFamilies": { "heading": "<family>", "body": "<family>", "mono": "<family or null>" },
    "scale": [
      { "name": "<name>", "size": "<px value>", "weight": "<number>", "lineHeight": "<value>", "letterSpacing": "<value or normal>" }
    ]
  },
  "spacing": {
    "baseUnit": "<value>",
    "scale": ["<value>", ...],
    "sectionGap": "<value>",
    "componentGap": "<value>"
  },
  "layout": {
    "maxWidth": "<value>",
    "approach": "<flexbox|grid|mixed>",
    "centeringMethod": "<description>",
    "sectionPattern": "<description>"
  },
  "sections": [
    {
      "type": "<nav|hero|features|how-it-works|testimonials|pricing|faq|cta|footer|stats|logos|content|demo|ambassador|newsletter|app-preview|product-grid|product-detail|gallery|team|comparison|sidebar|search|filters|dashboard|form|login|error — or any descriptive name if none fit>",
      "layout": "<centered-stack|two-column|grid-2|grid-3|grid-4|single-column|split>",
      "alignment": "<left|center|right>",
      "background": "<hex or transparent>",
      "elements": ["<badge>", "<heading>", "<text>", "<button-pair>", "<image>", "<card-grid>", ...],
      "gridColumns": "<number if grid>",
      "maxWidth": "<value if constrained>",
      "gap": "<value>",
      "padding": "<value>"
    }
  ],
  "contentPatterns": [
    { "pattern": "<heading+text+button-pair>", "occurrences": "<number>", "description": "<how this pattern is used>" }
  ],
  "components": {
    "buttons": [
      {
        "variant": "<primary|secondary|ghost|tertiary|accent|inline-link>",
        "bg": "<value>",
        "color": "<value>",
        "borderRadius": "<value>",
        "padding": "<value as CSS shorthand>",
        "fontWeight": "<number>",
        "fontSize": "<value>",
        "border": "<value or none>",
        "shadow": "<full CSS box-shadow value or none>",
        "styleTag": "<flat|pressed-3d|gradient|outline|ghost|elevated>",
        "hover": {},
        "active": {}
      }
    ],
    "cards": [
      {
        "bg": "<value>",
        "borderRadius": "<value>",
        "shadow": "<full CSS box-shadow value>",
        "border": "<value or none>",
        "padding": "<value>",
        "innerLayout": "<description like 'image + heading + text + button'>",
        "hover": {}
      }
    ],
    "nav": {
      "bg": "<value>",
      "position": "<fixed|sticky|static>",
      "height": "<value>",
      "blur": "<boolean>",
      "border": "<value or none>",
      "layout": "<description like 'logo-left + links-center + cta-right'>",
      "linkCount": "<number>"
    },
    "inputs": {
      "bg": "<value>",
      "border": "<value>",
      "borderRadius": "<value>",
      "padding": "<value>",
      "focus": {}
    }
  },
  "decorative": {
    "hasBlobs": "<boolean>",
    "hasGradientBgs": "<boolean>",
    "hasPatterns": "<boolean>",
    "illustrationStyle": "<none|cartoon|3d|icon-based|photo>",
    "backgroundEffects": [],
    "accentTreatments": []
  },
  "responsive": {
    "breakpoints": [],
    "mobileNavStyle": "<hamburger|bottom-tab|hidden|unchanged>",
    "gridCollapseBehavior": "<stack|scroll|reduce-columns>"
  },
  "effects": {
    "shadows": ["<every distinct box-shadow value from the page>"],
    "borderRadii": ["<every distinct border-radius value>"],
    "transitions": ["<value>", ...],
    "hoverPatterns": [
      { "pattern": "<name like pressed-3d or lift-shadow>", "appliesTo": ["<component paths like buttons.primary, cards, nav-links>"], "description": "<what physically happens — e.g. button sinks toward surface, shadow shrinks>" }
    ]
  }
}
\`\`\`

GOLDEN RULE: Every hex value, CSS measurement, and style property in your output must trace back to the input schema. The palette is the exact deduplicated set from the page — not your interpretation of what "looks good." If the schema has no data for a field, output null — never fill it with a plausible guess.

SECTION FIDELITY: The sections array is a complete manifest of the page. A code generator consuming this JSON should produce exactly the sections listed — no more, no fewer. If the page has 6 sections, the JSON has 6 entries, and the generated page has 6 sections. Don't pad the list with sections you think "should" exist.
</output>

## Page Schema Data

`;

/**
 * Builds the style-json synthesis prompt: the template plus the page schema data.
 *
 * @param schemaData - the optimized page schema, serialized as json
 */
export function buildSchemaPrompt(schemaData: string): string {
	return SCHEMA_PROMPT_TEMPLATE + schemaData + '\n\nOUTPUT THE JSON NOW:';
}
