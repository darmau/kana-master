# 02 · 阶段 0.5：客户端重构

## 目标

在不改变任何用户可见行为的前提下，让扩展具备接入托管网关所需的全部结构：结构化错误、可路由的 API 层、请求元数据、可取消的流式调用。这一步不依赖后端，可以在商店审核等待期间完成；做完之后接网关只是在 `lib/api.js` 里多一个 provider。

**验收标准**

- 所有现有 Node 测试通过；新增错误码与路由测试。
- UI 所有错误展示点接收 `{code, message}` 而非裸字符串，并按 code 显示不同的动作按钮（重试 / 去设置 / 登录 / 充值）。
- `lib/api.js` 不再包含 prompt 文本和厂商适配器，三者各自独立文件。
- 每个上游请求带 `requestId`，流式与非流式调用都能通过 `AbortSignal` 取消。
- 设置页有"API 模式"开关（自动 / 仅自带 key / 仅托管），托管选项在阶段 1 之前置灰。

## 1. 结构化错误码

### 1.1 现状

全链路错误是 `err.message` 字符串直接扔给 UI。展示点共 20 余处，分布在：

- `reader/reader.js:934`（进度条）、`:1163` 与 `:1236`（块级 `view.error`）、`:1694`（测验面板）
- `content/content.js:162`、`:370`、`:553`、`:587`、`:1020`、`:1186`（`showError()` 与浮窗/工具栏标签）
- `popup/popup.js:124`
- `vocabulary/vocabulary.js:562` 附近（只判断有无 `error`）
- `background/service-worker.js` 六个 `sendResponse({ error: err.message })` 与 port 消息 `{type: "error", message}` / `{type: "ttsError", message}`

### 1.2 错误码定义（`lib/errors.js`，ESM）

```js
export const ErrorCode = {
  // 配置 / 本地
  NOT_CONFIGURED: "NOT_CONFIGURED",             // 既无自带 key 也未登录
  HOST_PERMISSION_MISSING: "HOST_PERMISSION_MISSING",
  INVALID_INPUT: "INVALID_INPUT",
  TEXT_TOO_LONG: "TEXT_TOO_LONG",
  NOT_JAPANESE: "NOT_JAPANESE",
  // 认证 / 账号（阶段 1 起使用）
  UNAUTHENTICATED: "UNAUTHENTICATED",
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  ACCOUNT_SUSPENDED: "ACCOUNT_SUSPENDED",
  // 额度（阶段 1 起）
  QUOTA_EXHAUSTED: "QUOTA_EXHAUSTED",
  RATE_LIMITED: "RATE_LIMITED",
  // 上游 / 网络
  UPSTREAM_ERROR: "UPSTREAM_ERROR",
  UPSTREAM_AUTH: "UPSTREAM_AUTH",                // 自带 key 无效（401/403）
  TIMEOUT: "TIMEOUT",
  NETWORK: "NETWORK",
  CANCELLED: "CANCELLED",
  // 客户端
  CLIENT_TOO_OLD: "CLIENT_TOO_OLD",
  PARSE_ERROR: "PARSE_ERROR",                    // 模型返回无法解析
  UNKNOWN: "UNKNOWN",
};

export class YomeruError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "YomeruError";
    this.code = code;
    this.retryAfter = extra.retryAfter ?? null;   // 秒，RATE_LIMITED 用
    this.retryable = extra.retryable ?? RETRYABLE.has(code);
    this.cause = extra.cause;
  }
  toJSON() { return { code: this.code, message: this.message, retryAfter: this.retryAfter }; }
}

export const RETRYABLE = new Set(["UPSTREAM_ERROR", "TIMEOUT", "NETWORK", "RATE_LIMITED"]);

// 任何 Error → YomeruError；用于 catch 边界
export function toYomeruError(err) { /* AbortError → CANCELLED, TypeError(fetch) → NETWORK, 其余 UNKNOWN */ }
```

### 1.3 线格式

消息通道统一为 `{ error: { code, message, retryAfter } }`。过渡期 UI 同时兼容旧的字符串 `error`（`typeof error === "string"` 时视为 `UNKNOWN`），一个版本后删除兼容。

- `chrome.runtime.sendMessage` 响应：`sendResponse({ error: err.toJSON() })`
- `kana-stream` port：`{ type: "error", index, error: {code, message} }`
- `kana-tts` port：`{ type: "ttsError", reqId, error: {code, message} }`

### 1.4 UI 动作映射

内容脚本无法 import ESM，所以 code → 文案 / 动作的映射放进 `lib/shared.js`（`globalThis.KanaShared.describeError(error)`），reader / popup / vocabulary 也用同一个函数，避免三处各写一份。

| code | 文案 key（i18n） | 动作按钮 |
|---|---|---|
| NOT_CONFIGURED | errNotConfigured | 去设置（阶段 1 起：登录 / 填 key 二选一） |
| HOST_PERMISSION_MISSING | errHostPermission | 去设置 |
| UPSTREAM_AUTH | errUpstreamAuth | 去设置 |
| QUOTA_EXHAUSTED | errQuotaExhausted | 查看额度 / 充值 |
| RATE_LIMITED | errRateLimited（含倒计时） | 稍后自动重试 |
| UPSTREAM_ERROR / TIMEOUT / NETWORK | errUpstream | 重试（现有行为） |
| CLIENT_TOO_OLD | errClientTooOld | 打开 chrome://extensions 说明 |
| UNAUTHENTICATED / TOKEN_EXPIRED | errSignIn | 登录 |
| CANCELLED | 不显示 | — |
| 其他 | errGeneric + message | 重试 |

阶段 0.5 只落地前三行加上游三行；账号相关行文案先加进 `_locales/en`，其他语言由 Chrome 自动回落到 `default_locale`，不阻塞。

### 1.5 `lib/api.js` 内部错误分类

`fetchWithRetry` / `streamFetch` / `ttsFetch` 目前抛 `Error("API error 429: ...")`。改为：

- HTTP 401/403 → `UPSTREAM_AUTH`（自带 key 模式）
- 429 → `RATE_LIMITED`，读 `Retry-After`
- 5xx → `UPSTREAM_ERROR`（可重试）
- 超时 → `TIMEOUT`
- `AbortError` 且由调用方 signal 触发 → `CANCELLED`
- JSON 解析失败 → `PARSE_ERROR`

重试策略不变（指数退避最多 3 次），但只对 `retryable` 的错误重试，`UPSTREAM_AUTH` 立即失败，避免无效 key 时白等 7 秒。

## 2. `lib/api.js` 拆分

851 行的 `lib/api.js` 现在混着四类东西：prompt 常量、JSON schema、厂商适配器、业务函数。拆成：

```
lib/prompts.js     — 所有 prompt 与 JSON schema（DEFAULT_FURIGANA_PROMPT、getTranslationPrompt …、FURIGANA_SCHEMA …）
lib/providers.js   — ADAPTERS、fetchWithRetry、streamFetch、readSSE、ttsFetch、三家 TTS；导出 directChat / directStream / directTTS
lib/gateway.js     — 托管网关 provider（阶段 1 实现；阶段 0.5 先放接口与桩）
lib/api.js         — 公开 API 不变：getFurigana / streamTranslation / fetchTTS / generateQuiz / generateVocabEntry* / tokensToHtml；
                     新增 resolveRoute()，按设置决定走 providers 还是 gateway
lib/furigana.js    — repairTokens / cleanFuriganaTokens / patchMissingReadings（纯函数，方便单测；服务端也会复用）
```

`lib/prompts.js` 保留在扩展内是必要的：自带 key 模式仍在客户端拼 prompt。"prompt 搬到服务端"的准确含义是**网关 API 不接受客户端传入的 prompt**，服务端按 `mode` 自己拼。因此这个文件同时被 `server/` 直接 import（见 `03` §2），一处修改两端生效。

### 2.1 公开 API 签名调整

现有签名的问题：`streamTranslation(settings, systemPrompt, text, onChunk)` 由 service worker 传 prompt；`callChat` / `streamChat` 无法取消。新签名：

```js
// 所有函数：settings 里带 route（由 resolveRoute 计算），opts 带 signal 与 requestId
getFurigana(settings, text, opts)                          → { tokens, rawTokens, usage }
streamText(settings, { mode, text, targetLang, jlptLevel }, onChunk, opts)   // mode: translate | translateAny | grammar
generateQuiz(settings, text, jlptLevel, opts)
generateVocabEntry(settings, word, sentence, opts)
generateVocabEntryWithExample(settings, word, jlptLevel, opts)
fetchTTS(settings, text, opts)                              → { audioDataUrl, usage }
```

`streamTranslation(settings, systemPrompt, ...)` 删除，`background/service-worker.js` 的 `processOne()` 改为按 `pMode` 调 `streamText`。system prompt 的选择从 SW 移到 `lib/api.js` 内部（自带 key 模式）或服务端（托管模式），SW 不再接触 prompt。

`opts.signal`：`kana-stream` 的 port 断开时现在只置 `disconnected = true` 停止派发新任务，在途请求仍会跑完并被计费。改为每个 `processOne` 建一个 `AbortController`，port 断开时全部 abort。这对阶段 1 的退款逻辑是硬需求（网关收到中断才能释放预扣）。

### 2.2 路由决策 `resolveRoute(settings, task)`

```js
// 返回 { kind: "direct", provider, model } 或 { kind: "gateway", mode } 或抛 NOT_CONFIGURED
export function resolveRoute(settings, task) {
  const modelId = settings[`${task}Model`] || DEFAULT_CHAT_MODEL;   // task: furigana|translation|grammar|quiz|tts
  const { provider, model } = parseModelId(modelId);
  const hasOwnKey = !!settings[PROVIDER_KEYS[provider]];
  const mode = settings.apiMode || "auto";   // auto | byo | hosted
  if (mode !== "hosted" && hasOwnKey) return { kind: "direct", provider, model };
  if (mode !== "byo" && settings.hostedAvailable) return { kind: "gateway" };
  throw new YomeruError("NOT_CONFIGURED", ...);
}
```

规则用一句话向用户说明："配了自己的 key 就走自己的 key，否则走 Yomeru 账号额度"。`hostedAvailable` 阶段 0.5 恒为 `false`（由 `lib/auth.js` 在阶段 1 根据登录态设置）。

托管模式下**服务端决定模型**，客户端的 `furiganaModel` 等设置不生效，设置页要在托管模式时把模型下拉置灰并注明。原因是成本控制：不能让客户端指定 Opus 级模型烧免费额度。

### 2.3 `settings` 新增键（`lib/storage.js`）

| 键 | 存储 | 值 |
|---|---|---|
| `apiMode` | sync | `auto`（默认）/ `byo` / `hosted` |
| `clientId` | local | 安装时生成的 UUID，请求头 `X-Client-Id`，用于滥用分析（不进 sync） |

## 3. 请求元数据与幂等

- 每个逻辑请求生成 `requestId = crypto.randomUUID()`，在 `lib/api.js` 入口生成，重试沿用同一个 ID。托管模式作为 `X-Request-Id` 头发送，网关按它去重（`05` §4）。
- 每个请求带 `X-Client-Version: <manifest version>`（`chrome.runtime.getManifest().version`）。
- `usage` 字段：直连模式从厂商响应里提取 `{inputTokens, outputTokens}`（OpenAI `usage`，Anthropic `usage`，Google `usageMetadata`；流式需 OpenAI `stream_options: {include_usage: true}`），先只透传给调用方并在 `debugMode` 下打印，为阶段 1 的额度显示与成本校验做准备。

## 4. 网关 provider 的客户端契约（桩）

`lib/gateway.js` 阶段 0.5 只定义接口，全部抛 `NOT_CONFIGURED`：

```js
export async function gatewayChat({ mode, text, targetLang, jlptLevel, word, sentence }, opts)   // 非流式 JSON
export async function gatewayStream({ mode, text, targetLang }, onChunk, opts)                    // SSE
export async function gatewayTTS({ text, voice }, opts)                                            // 二进制音频 → data URL
```

三个函数对应网关的 `/v1/chat`、`/v1/stream`、`/v1/tts`（协议见 `03` §4）。阶段 1 填实现时，`lib/api.js` 一行不用改。

## 5. 设置页与弹窗改动

- `options/options.html`：顶部加"API 模式"三选一；"托管"选项文案为"使用 Yomeru 账号额度（即将推出）"并禁用。
- `popup/popup.html` 设置面板：当前走哪条路径的一行状态（"当前：自带 OpenAI key" / "当前：Yomeru 额度"），为阶段 1 的余额显示预留位置。

## 6. 测试

现有测试 `test/reader.test.mjs` 通过假 port 注入消息序列，扩展它：

- `test/errors.test.mjs`：`toYomeruError` 分类、`describeError` 映射、旧字符串 `error` 兼容。
- `test/api-route.test.mjs`：`resolveRoute` 在 apiMode × 有无 key × hostedAvailable 的 12 种组合下的结果。
- `test/providers.test.mjs`：用 `globalThis.fetch` 假实现测 `fetchWithRetry` 的错误分类与"UPSTREAM_AUTH 不重试"；`readSSE` 对三家格式的解析（把现有 `readSSE` 从 api.js 抽出后才可单测）。
- `test/reader.test.mjs` 增加：port 断开后 SW 收到 abort（通过假 port 检查 `AbortController` 被触发）；块级错误按 code 显示不同按钮。
- `test/furigana.test.mjs`：`repairTokens` / `cleanFuriganaTokens` 的既有行为固化（这两个函数服务端要复用，需要先有回归测试）。

## 7. 灰度与回滚

托管路径上线后，任何异常都可以让用户在设置页把 `apiMode` 切到 `byo` 立刻恢复直连，不依赖发版。服务端侧的开关是 `MIN_CLIENT_VERSION`（拒绝旧版）与按 mode 的功能开关（`03` §8），两端各有一把闸。

## 8. 排期

| 任务 | 天 |
|---|---|
| `lib/errors.js` + 线格式 + 20 余处展示点改造 + i18n key | 2 |
| `lib/api.js` 拆分（prompts / providers / furigana / gateway 桩） | 1.5 |
| 签名调整 + SW 改造 + AbortSignal 贯穿 | 1.5 |
| `resolveRoute` + 设置页 API 模式 + popup 状态行 | 1 |
| 测试 5 个文件 | 1.5–2 |
| CLAUDE.md 更新 | 0.5 |

合计 6–9 个工作日。
