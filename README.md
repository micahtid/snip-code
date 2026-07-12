<div align="center">

# SnipCode

**Snip any element on any website into clean code, right in your browser.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4.svg)](./public/manifest.json)
![Chrome Web Store: coming soon](https://img.shields.io/badge/Chrome%20Web%20Store-Coming%20Soon-lightgrey.svg)

[Website](https://snipcode.micahtid.com) &nbsp;·&nbsp; [Report a Bug](https://github.com/micahtid/snip-code/issues)

</div>

## Demo

https://github.com/user-attachments/assets/8cbb6ea7-0f3c-45a4-ab38-709e22ed3f2a

## What It Does

Point at any element and SnipCode turns it into clean, ready-to-use code. It
reads the styles the browser actually rendered, not just the markup, so the
result matches what you saw and works in the framework you pick.

The whole web becomes your component library. No account, no server, no cloud
sync. Everything runs in your browser.

## Features

- **Snip.** Turn any element into clean, ready-to-use code.
- **Fonts.** See every font family the page uses, with its variants.
- **Assets.** Grab every image, icon, background, and SVG in one click.
- **Colors.** Pull the page's real palette, ranked by how often each color appears.
- **Schemas.** Export the whole design system as clean JSON an AI can build from.

## Output Formats

| Format | Output |
|---|---|
| `html` | Self-contained, inline-styled HTML |
| `tailwind` | HTML with Tailwind classes |
| `bem-css` | BEM classes plus a CSS file |
| `bem-scss` | BEM classes plus an SCSS file |
| `jsx-tailwind` | React component, Tailwind classes |
| `jsx-css` | React component, BEM plus CSS |
| `vue` | Vue single-file component |

Pick your default in Settings. All seven come from one capture.

## Installation

> Coming soon to the Chrome Web Store. For now, load the extension unpacked.

### Load unpacked

```bash
npm install
npm run build      # Builds dist/ (side panel, content script, manifest, icons)
```

Then load it into Chrome:

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `dist/` folder.

The toolbar icon opens the side panel. Requires Chrome 122 or later.

## Usage

1. Click the SnipCode toolbar icon to open the side panel.
2. Click **Capture**. The page dims and a highlight follows your cursor.
3. Hover the element you want. Press the **up arrow** to select its parent, or **Esc** to cancel.
4. Click to snip. The code appears in the panel and is saved to your history.
5. Switch formats, or copy and download in a click.

To scan the whole page instead of one element, open the mode menu and pull its
**fonts**, **assets**, **colors**, or full **schema**.

## Bring Your Own Key

SnipCode works fully offline with no key. Adding one turns on an optional AI
polish step that renames classes and adds hover and focus styles. Your key is
stored only on your machine, in the browser's local storage, and never syncs to
the cloud or reaches any server.

Open the **Settings** tab and choose a provider:

| Provider | Get a key | Default model |
|---|---|---|
| OpenRouter | [openrouter.ai/keys](https://openrouter.ai/keys) | `google/gemini-2.5-flash` |
| Anthropic | [console.anthropic.com](https://console.anthropic.com/) | `claude-haiku-4-5-20251001` |
| OpenAI | [platform.openai.com](https://platform.openai.com/api-keys) | `gpt-5-mini` |
| Google | [aistudio.google.com](https://aistudio.google.com/app/apikey) | `gemini-3.0-flash` |

Paste your key, optionally override the model, and click **Test key** to check it.

## Permissions & Privacy

Everything runs in your browser. SnipCode makes only two kinds of network
request: calls to your own AI provider (with your key, for the optional polish
step), and requests for stylesheets on other domains, so it can read the page's
styles correctly. No telemetry, no analytics, no account.

| Permission | Why |
|---|---|
| Site access | Read the element you snip |
| `scripting` | Run capture on the page |
| `storage`, `unlimitedStorage` | Store settings, keys, and snippets locally |
| `downloads` | Save assets to your device |
| `sidePanel` | Open the side panel |
| `debugger` | Read exact styles for accurate output |

## Contributing

Contributions are welcome. To develop locally:

```bash
npm install
npm run typecheck
npm run build       # Produces dist/, then load unpacked
```

The pipeline runs in five phases under `src/content/`. The grader in `tests/`
scores each output against a reference screenshot with pixelmatch and SSIM. Open
an issue to report a bug or suggest a feature.

## License

[MIT](./LICENSE)
