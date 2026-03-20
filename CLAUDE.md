# Kana Master

Chrome 扩展（Manifest V3），为网页上的日文添加振假名（furigana）和中文翻译。通过 OpenAI 兼容 API 处理。

## 技术栈

- 纯 vanilla JS，无框架、无构建步骤、无依赖
- ES Modules（service worker 和 lib 使用 `import/export`）
- 内容脚本（content script）是普通 IIFE，不能使用 ES Modules
- 全部手写 CSS，无 CSS 框架

## 目录结构

```
background/service-worker.js  — 消息中枢，所有 API 调用经此路由
lib/api.js                    — OpenAI API 封装（furigana、翻译、流式翻译、TTS）
content/content.js            — 内容脚本（Alt+Click 标注 + 播放按钮）
content/content.css           — 内容脚本样式（ruby、高亮、加载动画、播放按钮）
reader/reader.{html,js,css}   — 阅读器模式（独立标签页，全文翻译 + 全文朗读）
popup/popup.{html,js}         — 弹窗（提取内容 → 打开阅读器）
options/options.{html,js}     — 设置页（API Key、Base URL、Model、翻译引擎、Prompt）
manifest.json                 — MV3 配置
```

## 核心交互

- **Alt+Click（内容脚本）**：按住 Alt 进入标注模式（十字光标），hover 高亮元素，点击触发 furigana + 流式翻译。翻译完成后原文下方出现 ▶ 播放按钮。
- **阅读器模式**：Popup 点击按钮 → 提取页面内容 → `chrome.storage.local` 传递 → 新标签页打开 `reader.html`
  - 段落可编辑（contenteditable）、可选择（click/shift+click）、可删除
  - "翻訳開始"按钮：并发3段，流式翻译 + furigana
  - "朗読"按钮：TTS 朗读，渐进预取3段，高亮当前段落，自动滚动

## 消息通信

- **chrome.runtime.sendMessage**：一次性请求（annotate、bulkAnnotate、tts）
- **chrome.runtime.connect (port)**：
  - `kana-stream`：流式翻译（furigana + translationChunk + allDone）
  - `kana-tts`：TTS 音频请求（ttsRequest → ttsAudio/ttsError）

## API 层 (lib/api.js)

- `callOpenAI()` — 基础聊天补全，带重试（指数退避，最多3次，30s超时）
- `getFurigana()` — JSON mode，返回 `{tokens: [{t, r}]}`
- `getTranslation()` — 普通文本翻译
- `streamTranslation()` — SSE 流式翻译，onChunk 回调
- `getBulkFurigana()` — 多段落用 `===PARA===` 分隔，一次请求
- `fetchTTS()` — 调用 `/v1/audio/speech`，返回 base64 data URL（tts-1 模型，60s超时）

## 设置存储 (chrome.storage.sync)

`apiKey`, `apiBaseUrl`, `model`, `furiganaPrompt`, `translationPrompt`, `bulkFuriganaPrompt`, `translationEngine`（cloud/local）, `ttsVoice`（默认 alloy）

## 翻译引擎

- **Cloud**：通过 OpenAI 兼容 API（默认 gpt-4o-mini），支持流式
- **Local**：Chrome Built-in AI Translator API（`self.ai.translator`），不支持流式

## 样式约定

- 主色调：`#4a90d9`（蓝色），错误色：`#d93025`，TTS 色：`#2d8659`（绿色）
- 阅读器字体：Hiragino Mincho ProN / Noto Serif JP（衬线），20px，行高 2
- 中文翻译字体：PingFang SC / Microsoft YaHei（无衬线），0.8em，灰色 `#aaa`
