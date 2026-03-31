# 読める (Yomeru)

Chrome 扩展（Manifest V3），为网页上的日文添加振假名（furigana）和中文翻译。支持 OpenAI、Anthropic、Google 三家 API。产品名称：日文「読める」，英文 Yomeru，简中「可读」，繁中「可讀」，其他语言使用英文名 Yomeru。

## 技术栈

- 纯 vanilla JS，无框架、无构建步骤、无依赖
- ES Modules（service worker 和 lib 使用 `import/export`）
- 内容脚本（content script）是普通 IIFE，不能使用 ES Modules
- 全部手写 CSS，无 CSS 框架

## 目录结构

```
background/service-worker.js    — 消息中枢，所有 API 调用经此路由
lib/api.js                      — 多厂商 API 封装（furigana、翻译、流式翻译、TTS、Quiz、词汇）
lib/models.js                   — 静态模型定义与定价（OpenAI / Anthropic / Google）
lib/i18n.js                     — 国际化工具（t() 翻译函数 + applyI18n() DOM 绑定）
content/content.js              — 内容脚本（Alt+操作栏：标注/翻译/语法/TTS + 单词收集）
content/content.css             — 内容脚本样式（ruby、高亮、加载动画、操作栏）
reader/reader.{html,js,css}     — 阅读器模式（独立标签页，全文翻译 + 全文朗读）
popup/popup.{html,js}           — 弹窗（提取内容 → 打开阅读器 + 设置面板）
options/options.{html,js}       — 设置页（API Key、Base URL、Model、费用计算器）
vocabulary/vocabulary.{html,js,css} — 词汇本（收集的单词列表、搜索、上下文例句）
history/history.{html,js,css}   — 测验历史（答题记录 + 进度图表）
_locales/{18 langs}/messages.json — Chrome i18n 消息文件（UI 多语言）
docs/                           — 公开文档站（着陆页、隐私政策，非扩展本体）
manifest.json                   — MV3 配置
```

## 核心交互

- **Alt+操作栏（内容脚本）**：按住 Alt 进入标注模式（十字光标），hover 高亮元素，显示操作栏（4 个按钮）：
  - 标注（bookmark）— furigana + 流式翻译
  - 翻译（translate）— 仅流式翻译
  - 语法（grammar）— 流式语法分析（Markdown 渲染）
  - TTS（speaker）— 朗读
  - 点击译文中的单词 → 自动收集到词汇本（含上下文例句）
- **阅读器模式**：Popup 点击按钮 → 提取页面内容 → `chrome.storage.local` 传递 → 新标签页打开 `reader.html`
  - 段落可编辑（contenteditable）、可选择（click/shift+click）、可删除
  - "翻訳開始"按钮：并发3段，流式翻译 + furigana；完成后显示 ↻ 重新标注按钮
  - "朗読"按钮：TTS 朗读，渐进预取3段，高亮当前段落，自动滚动
- **词汇本**：收集的单词列表，支持搜索、多上下文例句、导出
- **测验**：基于阅读内容生成 5 道选择题，难度根据 JLPT 等级调整；历史记录含进度图表

## 消息通信

- **chrome.runtime.sendMessage**：一次性请求（annotate、bulkAnnotate、tts、generateQuiz、generateVocabEntry）
- **chrome.runtime.connect (port)**：
  - `kana-stream`：流式处理（支持 4 种 mode：both/annotate/translate/grammar；消息类型：furigana、translationChunk、grammarChunk、progress、allDone）
  - `kana-tts`：TTS 音频请求（ttsRequest → ttsAudio/ttsError）

## API 层 (lib/api.js)

- 多厂商路由：模型 ID 格式 `provider/model`（如 `openai/gpt-5.4-mini`、`anthropic/claude-sonnet-4-6`、`google/gemini-3-flash-preview`）
- `callChat()` — 统一聊天补全，自动路由到对应厂商，带重试（指数退避，最多3次，30s超时）
- `streamChat()` — 统一 SSE 流式，支持三家不同的 SSE 格式
- `getFurigana()` — JSON mode，返回 `{tokens: [{t, r}]}`，含 token 修复（`repairTokens`）和清洗（`cleanFuriganaTokens`）
- `getTranslation()` — 普通文本翻译
- `streamTranslation(settings, systemPrompt, text, onChunk)` — 流式翻译，需显式传入 system prompt
- `getBulkFurigana()` — 多段落用 `===PARA===` 分隔，一次请求
- `generateQuiz(settings, text, jlptLevel)` — 生成 5 道阅读理解选择题，返回 JSON
- `generateVocabEntry(settings, word, sentence)` — 生成词汇条目（词形变化、释义），返回 JSON
- `fetchTTS()` — 支持 OpenAI 和 Google TTS，返回 base64 data URL（60s超时）

## 设置存储

### chrome.storage.sync（跨浏览器同步）

- API Keys：`openaiKey`, `anthropicKey`, `googleKey`
- `openaiBaseUrl`（可选，用于兼容 OpenAI 的第三方服务）
- 每个功能独立指定模型：`furiganaModel`, `translationModel`, `grammarModel`（格式：`provider/model`）
- `ttsModel`（格式：`provider/model`，支持 OpenAI + Google）
- `ttsVoice`（默认 alloy）, `targetLang`（默认 zh-CN，支持 18 种语言）
- `jlptLevel`（N1–N5，默认 N3，影响测验难度）
- `debugMode`（显示原始 token JSON）

### chrome.storage.local（本地临时数据）

- `readerData` — Popup 提取的页面内容，传递给 reader.html
- `vocabulary` — 词汇本条目数组（含多上下文例句）
- `quizHistory` — 测验历史记录数组
- `popupSettingsOpen` — Popup 设置面板展开状态

## 多语言译文

翻译 prompt 根据 `targetLang` 动态生成。译文 DOM 元素设置对应的 `lang` 属性。阿拉伯语额外设置 `dir="rtl"` 和 `text-align: right`。

## 样式约定

- 主色调：`#4a90d9`（蓝色），错误色：`#d93025`，TTS 色：`#2d8659`（绿色）
- 阅读器字体：Hiragino Mincho ProN / Noto Serif JP（衬线），20px，行高 2
- 中文翻译字体：PingFang SC / Microsoft YaHei（无衬线），0.8em，灰色 `#aaa`
