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
lib/reader-store.js             — 阅读会话持久化（chrome.storage.local，索引 + 每会话一键，LRU 30）
lib/models.js                   — 静态模型定义与定价（OpenAI / Anthropic / Google）
lib/i18n.js                     — 国际化工具（t() 翻译函数 + applyI18n() DOM 绑定）
lib/shared.js                   — 内容脚本与扩展页面共用的 DOM helper（globalThis.KanaShared，经典脚本）
content/content.js              — 内容脚本（Alt+操作栏：标注/翻译/语法/TTS + 单词收集）
content/content.css             — 内容脚本样式（ruby、高亮、加载动画、操作栏）
reader/reader.{html,js,css}     — 阅读器模式（独立标签页，全文翻译 + 全文朗读）
popup/popup.{html,js}           — 弹窗（提取内容 → 打开阅读器 + 设置面板）
options/options.{html,js}       — 设置页（API Key、Base URL、连接测试、网站黑名单）
vocabulary/vocabulary.{html,js,css} — 词汇本（收集的单词列表、搜索、上下文例句）
history/history.{html,js,css}   — 测验历史（答题记录 + 进度图表）
_locales/{18 langs}/messages.json — Chrome i18n 消息文件（UI 多语言）
docs/                           — 公开文档站（着陆页、隐私政策，非扩展本体）
test/                           — Node 测试（jsdom 驱动真实 reader.html，见 test/README.md）
manifest.json                   — MV3 配置
```

## 核心交互

- **选区工具栏 + 结果卡片（内容脚本）**：选中任意文本出现浮动工具栏（标注/语法仅日文显示；翻译/TTS 任何语言可用）：
  - 标注（bookmark）— 对选区原地加 furigana
  - 翻译 / 语法 — 结果流式显示在选区旁的**浮动卡片**（一次只有一张，重复查询自动替换，不污染页面）；卡片可"📌 插入到段落下方"固定到页面
  - TTS（speaker）— 朗读选区
- **段落手柄（内容脚本）**：hover 段落时左侧 gutter 淡入小圆钮（読），点击展开整段操作（标注/翻译/语法/朗读），结果插入段落下方；mouseleave 有 300ms 宽容延迟，手柄自身算 hover 区域
  - 点击已标注块中的单词 → 词汇弹窗 → 收集到词汇本（含上下文例句）
- **阅读器模式**：Popup 点击按钮 → 提取页面内容 → 创建**会话**（`lib/reader-store.js`）→ 新标签页打开 `reader.html?id=<sessionId>`
  - **会话持久化**：正文、furigana tokens、译文全部存 `chrome.storage.local`，刷新/重开不丢失，已生成的结果不重复付费；裸 `reader.html` 显示"最近阅读"列表（LRU 上限 30）+ 粘贴入口，粘贴后懒创建会话
  - **无全局锁**，任何时候都能编辑/删除/重跑
  - **每块状态机**：`data-state` = idle / loading / done / error / stale（编辑已标注文本 → 剥离 ruby 并标 stale，保留旧结果供重新生成）
  - **gutter 手柄**：hover 段落时左侧 gutter 淡入 → 勾选框（选择）+ 読 按钮（菜单：标注/翻译/语法/朗读）。**选择与编辑分离**：点正文只放光标，勾选框才选中；Shift+勾选选范围
  - 选区决定**批量范围**（标注/翻译/Quiz/朗读），按钮标签显示 ` (N)`
  - **语法分析**：结果为 `.reader-grammar`（Markdown 渲染），持久化原始 Markdown；非日文段落菜单只有 翻译 + 朗读，翻译时按段落发 `modes: translateAny`
  - **编辑模型**：Enter 在光标处分段（li/pre 保留标签，其余为 p）、块首 Backspace / 块末 Delete 合并相邻块、粘贴一律纯文本且多行拆块、"+ 新增段落"按钮；光标偏移按无 ruby 的纯文本计算；IME 组字期间不分段；Shift+Enter 故意无操作（`<br>` 无法经 record/`tokensToHtml` 往返）
  - 程序化的分段/合并/粘贴会打断浏览器原生 undo 栈（普通输入不受影响）
  - **学习开关**（工具栏右侧，存 `chrome.storage.sync`）：隐藏振假名（rt 透明，hover ruby 显示）、隐藏译文（译文/语法模糊，点击单个揭示）
  - 工具栏标注/翻译按钮：有选区则只处理选区，否则处理所有缺少该类结果的段落（标注要求日文，翻译不限）；可**取消**；按钮可重复使用，不再变"完成"
  - 出错的段落就地显示错误 + **重试**按钮；service worker 被回收（port 断开）或某块未被 run 报告时进入 error 而非永久卡住
  - Escape 逐层退出：关菜单 → 关词汇弹窗 → 退出编辑 → 清除选择
  - "朗読"按钮：TTS 朗读，高亮当前段落，自动滚动（一次性请求全部段落，队列化待 P3 重构）
- **一键全文翻译**：Popup"全文翻译"按钮 → 内容脚本收集正文段落（不限语言）→ 流式逐段插入译文；日文段落额外加 furigana，其他语言仅翻译；右上角进度浮窗（可取消）；已在目标语言的段落译文自动丢弃
- **词汇本**：收集的单词列表，支持搜索、多上下文例句、导出
- **测验**：基于阅读内容生成 5 道选择题，难度根据 JLPT 等级调整；历史记录含进度图表

## 消息通信

- **chrome.runtime.sendMessage**：一次性请求（annotate、bulkAnnotate、tts、generateQuiz、generateVocabEntry）
- **chrome.runtime.connect (port)**：
  - `kana-stream`：流式处理（支持 5 种 mode：both/annotate/translate/translateAny/grammar，可选 `modes` 数组按段落覆盖；消息类型：furigana、translationChunk、grammarChunk、progress、allDone）
  - `kana-tts`：TTS 音频请求（ttsRequest → ttsAudio/ttsError）

## API 层 (lib/api.js)

- 多厂商路由：模型 ID 格式 `provider/model`（如 `openai/gpt-5.6-luna`、`anthropic/claude-sonnet-5`、`google/gemini-3.6-flash`）
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
- 每个功能独立指定模型：`furiganaModel`, `translationModel`, `grammarModel`, `quizModel`（格式：`provider/model`）
- `ttsModel`（格式：`provider/model`，支持 OpenAI + Google）
- `ttsVoice`（默认 alloy）, `targetLang`（默认 zh-CN，支持 18 种语言）
- `jlptLevel`（N1–N5，默认 N3，影响测验难度）
- `debugMode`（显示原始 token JSON）
- `blacklist`（网站黑名单，域名数组，自动匹配子域名；命中站点上内容脚本完全不生效，Popup 有单站开关，Options 可批量编辑，改动即时生效无需刷新）
- `readerHideFurigana`, `readerHideTranslation`（阅读器学习开关，布尔，多标签页经 `storage.onChanged` 同步）

### chrome.storage.local（本地数据，manifest 已声明 `unlimitedStorage`）

- `readerSessionIndex` — 阅读会话摘要数组（`{id, title, url, updatedAt, blockCount, annotatedCount, translatedCount, preview}`，按 updatedAt 降序，上限 30）
- `readerSession:<id>` — 单个会话正文：`{v, id, title, url, createdAt, updatedAt, blocks}`，block 为 `{id, tag, text, tokens, rawTokens, translation, translationLang, grammar, stale}`（未生成的结果为 `null`）
  - 索引与正文分键存放：防抖保存只重写一个会话 + 小索引；`lib/reader-store.js` 保持索引缓存常热，`saveSession` 因此能在第一个 `await` 之前同步到达 `storage.local.set`，`pagehide` 刷写才可靠
  - 同一会话在两个标签页打开时后写胜出（不做合并）
  - `readerData`（旧的一次性传递键）已废弃，`loadContent()` 保留一次性迁移，一个版本后可删
- `vocabulary` — 词汇本条目数组（含多上下文例句）
- `quizHistory` — 测验历史记录数组
- `popupSettingsOpen` — Popup 设置面板展开状态

## 多语言译文

翻译 prompt 根据 `targetLang` 动态生成。译文 DOM 元素设置对应的 `lang` 属性。阿拉伯语额外设置 `dir="rtl"` 和 `text-align: right`。

## 样式约定

- 主色调：`#4a90d9`（蓝色），错误色：`#d93025`，TTS 色：`#2d8659`（绿色）
- 阅读器字体：Hiragino Mincho ProN / Noto Serif JP（衬线），20px，行高 2
- 中文翻译字体：PingFang SC / Microsoft YaHei（无衬线），0.8em，灰色 `#aaa`
