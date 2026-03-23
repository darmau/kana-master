# Kana Master

Chrome extension (Manifest V3) that adds furigana readings and translations to Japanese text on any webpage. Bring your own API key — supports OpenAI, Anthropic, and Google.

<p align="center">
  <ruby>日本語<rt>にほんご</rt></ruby>を<ruby>勉強<rt>べんきょう</rt></ruby>する<ruby>時<rt>とき</rt></ruby>、<ruby>漢字<rt>かんじ</rt></ruby>の<ruby>読<rt>よ</rt></ruby>み<ruby>方<rt>かた</rt></ruby>が<ruby>難<rt>むずか</rt></ruby>しい。
</p>

## Features

- **Furigana annotation** — Alt+Click any Japanese text to add ruby readings above kanji
- **Streaming translation** — Real-time translation into 17 languages, displayed word by word
- **Reader mode** — Clean reading view with paragraph selection, bulk translation, and TTS playback
- **Text-to-speech** — Natural Japanese pronunciation via OpenAI TTS with progressive prefetching
- **Multi-provider** — Each function can use a different provider/model; mix and match freely
- **Local translation** — Optional Chrome Built-in AI for fully offline translation

## Supported Providers

| Provider | Furigana | Translation | TTS |
|----------|----------|-------------|-----|
| OpenAI | Yes | Yes (streaming) | Yes |
| Anthropic | Yes | Yes (streaming) | — |
| Google Gemini | Yes | Yes (streaming) | — |
| Chrome Built-in AI | — | Yes (local, no streaming) | — |

## Installation

1. Clone this repo or download the source
2. Open `chrome://extensions/` and enable **Developer mode**
3. Click **Load unpacked** and select the project folder
4. Open the extension options and enter your API key(s)

No build step required — pure vanilla JS with zero dependencies.

## Usage

### Alt+Click (Content Script)

Hold **Alt** to enter annotation mode (crosshair cursor). Hover to highlight elements, click to trigger furigana + streaming translation. A play button appears after translation for TTS playback.

### Reader Mode

Click the extension icon → open Reader Mode. Select paragraphs, translate in bulk, and listen with TTS.

- Paragraphs are editable, selectable (click / shift+click), and deletable
- Concurrent translation (3 paragraphs at a time) with streaming output
- TTS with progressive prefetching and auto-scroll

## Configuration

Open the extension options page to configure:

- **API keys** for OpenAI, Anthropic, and/or Google
- **Custom base URL** for OpenAI-compatible providers (Azure, OpenRouter, etc.)
- **Per-function model selection** — choose a model for furigana, translation, grammar, and TTS independently
- **Target language** — 17 languages including Chinese, English, Korean, French, Spanish, German, Arabic, and more
- **Translation engine** — Cloud (API) or Local (Chrome Built-in AI)
- **TTS voice** selection

## Project Structure

```
background/service-worker.js  — Message hub, routes all API calls
lib/api.js                    — Multi-provider API layer (furigana, translation, streaming, TTS)
lib/models.js                 — Static model definitions (OpenAI / Anthropic / Google)
content/content.js            — Content script (Alt+Click annotation + play button)
content/content.css           — Content script styles
reader/reader.{html,js,css}   — Reader mode (full-page translation + TTS)
popup/popup.{html,js}         — Popup (extract content → open reader)
options/options.{html,js}     — Options page
manifest.json                 — MV3 manifest
docs/                         — GitHub Pages (intro + privacy policy)
```

## Tech Stack

- Vanilla JavaScript, no frameworks, no build step, no dependencies
- ES Modules for service worker and library code
- Content scripts use plain IIFE (no ES Module support)
- Hand-written CSS, no CSS frameworks

## Privacy

Kana Master does not collect any data. API keys are stored locally in your browser. Text is sent only to the API providers you configure. See the full [Privacy Policy](https://nicekana.github.io/kana-master/privacy.html).

## License

MIT
