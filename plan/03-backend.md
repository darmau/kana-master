# 03 · 后端架构与技术选型

## 1. 选型与理由

| 项 | 选择 | 理由 | 放弃的替代 |
|---|---|---|---|
| 运行时 | Cloudflare Workers | 95% 的请求时间在等上游吐 SSE，Workers 按 CPU 时间计费，等待不计费；全球边缘；与 D1 / DO / KV / R2 同网 | Fly / Railway 常驻容器（为等待付费、单区域） |
| 语言 | TypeScript | 协议类型（错误码、请求体、DO 状态）需要编译期约束；wrangler 原生支持 | JS（扩展端保留 JS，两端不必一致） |
| 框架 | Hono | Workers 首选路由器，中间件生态（`hono/jwt`、`hono/cors`、`hono/validator`），体积小，可用 `app.request()` 单测 | itty-router（功能少）、无框架（要自己写路由与中间件） |
| 校验 | zod + `@hono/zod-validator` | 每个端点严格限制文本长度与字段形状，这是防滥用第一道闸 | 手写校验 |
| 数据库 | D1 + 手写 SQL + `wrangler d1 migrations` | 8 张表；D1 只承担追加写和幂等 upsert；无交互式事务的限制用 DO 规避 | Drizzle（多一层抽象，收益小） |
| 强一致 | Durable Objects，SQLite 存储，RPC 方法 | 每用户一个实例，预扣/结算天然串行；alarm 处理过期 hold | D1 乐观锁（写不出跨 await 事务） |
| 缓存 | KV（furigana）、R2（TTS 音频） | KV 全球读；R2 零 egress，音频体积大 | Cache API（不跨 PoP） |
| 用量日志 | Analytics Engine | 高频只追加，SQL API 可查，成本近零 | 直接写 D1（行数爆炸） |
| 上游 | Cloudflare AI Gateway（universal endpoint） | 免费拿到请求日志、成本统计、限流、缓存、fallback；厂商 key 可存在 AI Gateway（BYOK）少一份秘密 | 直连厂商（可保留为 AI Gateway 故障时的降级路径） |
| 认证 | 自建 OAuth 授权码 + PKCE，`hono/jwt` HS256 | Worker 本地 WebCrypto 验签零网络；扩展与 web 共用 | Auth0 / Clerk（讨论已排除） |
| 支付 | Stripe（`stripe` npm，`constructEventAsync`） | 讨论已定 | — |
| 静态页面 | Workers Static Assets（同一个 Worker） | 账号页、落地页、隐私政策、OAuth 回调桥、Stripe 回跳页都在一个部署单元 | Pages（多一个项目，Cloudflare 自己也在把 Pages 并入 Workers） |
| 定时 | Cron Triggers | 日聚合、对账、过期清理 | Queues（阶段 2 若 webhook 处理需要削峰再加） |
| 测试 | vitest + `@cloudflare/vitest-pool-workers` | 在真实 workerd 里跑，D1 / DO / KV 都有本地实现 | miniflare 手搓 |
| 邮件告警 | Email Routing `send_email` binding | 给自己发告警免费；不需要第三方邮件服务 | Resend（用户侧邮件通知阶段 3 再说） |

## 2. 仓库布局

扩展与后端放同一仓库（monorepo）。这个决定在 `02` 就已经隐含做出——`server/` 直接 import 根目录的 `lib/prompts.js`——本节把它明确下来并说明取舍。

### 2.1 单仓库，但不上 npm/pnpm workspaces

**结论：一个 git 仓库，两个独立的工具链，不引入 workspace 协议。**

"要不要 monorepo" 其实是两个不同的问题，容易混在一起：

1. **要不要放同一个仓库？** 要。协议变更（`03` §4）需要同一个 PR 改扩展和后端两侧，分仓库会导致版本对不上、review 割裂。这条已经在 `02`/`03` 的设计里落实——`server/` 是根目录下的子目录，不是子模块。
2. **要不要上 npm/pnpm workspaces（根 `package.json` 的 `workspaces` 字段、包间用 `@scope/pkg` 裸标识符互相 import）？** 不要。理由是这个仓库里事实上只有**一个** Node 包：

   - 扩展是 `CLAUDE.md` 明确写死的"纯 vanilla JS，无框架、无构建步骤、无依赖"——这不只是风格偏好，`06` §5.3 的远程代码禁令天然合规就是靠它。扩展没有、也不该有 `package.json`。
   - 内容脚本和扩展页面是浏览器原生 ES Modules，`import` 只认相对路径或绝对 URL，不认裸标识符（除非引入 import map 或构建步骤，这正是要避免的）。所以就算把 `lib/prompts.js` 抽成一个 `@rubify/shared` workspace 包，扩展这一侧也用不上——它只能继续用 `import "../../lib/prompts.js"` 这种相对路径。
   - 后端只有 `server/` 一个真正的 npm 包（依赖 hono、zod、stripe、wrangler、vitest）。workspaces 的价值在于协调 3 个以上互相依赖的包、去重 `node_modules`、统一 lockfile——只有一个包时这些收益都不存在，只剩下配置的复杂度。

   共享代码（`lib/prompts.js`、`lib/furigana.js`、`lib/japanese.js`）的做法不是"抽成一个包"，而是**两端各自用相对路径 import 同一份源文件**：扩展侧是浏览器 ESM 直接加载，`server/` 侧靠 `tsconfig.json` 的 `allowJs: true` + wrangler 内置的 esbuild 打包进 Worker。一处改动两端生效，不需要任何 workspace 机制。

   代价：目前仓库里完全没有 `package.json`（`test/README.md` 靠 `npm install --no-save jsdom` 临时装依赖，没有锁定版本）。趁这次改造在根目录加一个**只做任务编排、没有 `workspaces` 字段**的 `package.json`：

   ```jsonc
   // package.json（根目录，private，不声明 workspaces）
   {
     "name": "rubify-monorepo",
     "private": true,
     "devDependencies": { "jsdom": "^25.0.0" },
     "scripts": {
       "test:extension": "node --test test/*.test.mjs",
       "test:server": "npm --prefix server test",
       "test": "npm run test:extension && npm run test:server",
       "package:extension": "bash scripts/package.sh",
       "dev:server": "npm --prefix server run dev",
       "deploy:server": "npm --prefix server run deploy"
     }
   }
   ```

   这解决了"CI 和本地只需要一条命令"的真实诉求（这也是很多人想上 workspaces 时真正想要的东西），同时不强迫扩展打包、不给浏览器侧引入裸标识符解析问题。`server/` 保留自己独立的 `package.json` 与 lockfile，`npm --prefix server install` 单独管理。

   如果未来出现第二个真正的 Node 包（例如把 `server/src/llm` 拆成独立的可测试库，或者管理后台是另一个 Worker），再引入 `workspaces` 字段不是破坏性变更——现在不提前上，是因为提前上没有对应的收益。

```
kana-master/
├── package.json                                              ← 新增：根任务编排，无 workspaces 字段
├── manifest.json, lib/, background/, content/, reader/ …   ← 扩展（不变）
├── lib/prompts.js                                           ← 两端共享（server 直接 import，相对路径，非 workspace 包）
├── lib/furigana.js                                          ← 两端共享（repairTokens 等纯函数）
├── scripts/package.sh                                       ← 扩展打包
├── server/
│   ├── wrangler.toml
│   ├── package.json  tsconfig.json  vitest.config.ts
│   ├── src/
│   │   ├── index.ts              Hono app 装配、静态资源回退、scheduled() 入口
│   │   ├── env.d.ts              Bindings 类型
│   │   ├── routes/
│   │   │   ├── auth.ts           /auth/*
│   │   │   ├── api.ts            /v1/chat /v1/stream /v1/tts /v1/me
│   │   │   ├── billing.ts        /billing/*（阶段 2）
│   │   │   ├── account.ts        /account/*（用量、删除）
│   │   │   └── webhooks.ts       /webhooks/stripe
│   │   ├── middleware/
│   │   │   ├── auth.ts           JWT 验签 → c.var.user
│   │   │   ├── version.ts        X-Client-Version ≥ MIN_CLIENT_VERSION
│   │   │   ├── ratelimit.ts      Rate Limiting binding，按 user / ip
│   │   │   └── errors.ts         YomeruError → 统一响应
│   │   ├── do/QuotaAccount.ts    每用户余额 DO
│   │   ├── llm/
│   │   │   ├── modes.ts          mode → prompt builder + schema + 模型 + 上限（import ../../lib/prompts.js）
│   │   │   ├── providers.ts      三家适配器（服务端版本，含 usage 提取）
│   │   │   ├── pricing.ts        模型单价表 + credits 折算
│   │   │   └── sse.ts            上游 SSE → 统一事件流
│   │   ├── db/
│   │   │   ├── migrations/0001_init.sql …
│   │   │   └── queries.ts        typed 查询函数
│   │   ├── cron/
│   │   │   ├── aggregate.ts      Analytics Engine → usage_daily
│   │   │   ├── reconcile.ts      DO 余额快照 vs 账本
│   │   │   └── cleanup.ts        过期 refresh token、软删用户的级联
│   │   └── util/{jwt,hash,ids,japanese}.ts
│   ├── static/                   账号页、落地页、隐私政策、terms、oauth 回调桥、stripe 回跳页
│   └── test/
└── .github/workflows/{extension.yml, server.yml}
```

`lib/prompts.js` 与 `lib/furigana.js` 是 ESM JS，`server/tsconfig.json` 开 `allowJs`，wrangler 的 esbuild 直接打包。`isJapanese` 之类文本判断现在在 `lib/shared.js`（经典脚本，挂 `globalThis`），需要把纯函数抽到 `lib/japanese.js`（ESM）并让 `shared.js` 引用同一份实现，服务端复用。

## 3. 请求热路径

一次流式翻译的完整路径，全程不读 D1：

```
扩展 SW ──POST /v1/stream (JWT, X-Request-Id, X-Client-Version)──▶ Worker
  1. version 中间件：比较版本（纯内存）
  2. auth 中间件：hono/jwt HS256 验签（WebCrypto，零网络）→ userId, plan
  3. zod 校验：mode ∈ 白名单，text ≤ MODE_LIMITS[mode].maxChars，annotate 要求含日文
  4. ratelimit：按 userId 每分钟 N 次（Rate Limiting binding，PoP 内）
  5. 缓存查询（仅 annotate / tts）：KV / R2 命中 → 直接返回，记 usage，扣半价或免费
  6. DO.reserve(requestId, estimate)：预扣。余额不足 → 402 QUOTA_EXHAUSTED
  7. 调 AI Gateway → 厂商，SSE 转发给扩展（TransformStream，逐 chunk 改写为统一格式）
  8. 流结束：从最后 chunk 提取 usage → 算 credits → DO.settle(requestId, actual)
     流中断（客户端 abort / 上游错误）：DO.settle 按已发送字节估算，或 release
  9. Analytics Engine writeDataPoint（不阻塞响应，用 ctx.waitUntil）
```

D1 只在：登录、刷新 token、Stripe webhook、账号页、Cron 时被访问。

**第 8 步的取消检测要在 staging 实测。** 方案依赖"客户端断开 → Worker 的 `request.signal` 触发"，这在 Workers 运行时是较新的行为，且不同断开方式（`AbortController.abort()`、关闭标签页、网络中断）表现可能不同。兜底：向响应流 `writer.write()` 时捕获拒绝（客户端已走则写入失败），在 catch 里中止上游并结算。两条路径都要有 vitest 覆盖，`05` §4 的退款正确性建立在这上面。

**全局日预算不能放在热路径上。** `06` §2 的"单例 DO 累计当日成本，`reserve` 前置检查"会让全世界所有请求都串行经过一个 DO 实例（单地域、单线程），既是延迟瓶颈也是单点。改为：每用户 DO 在 `settle` 时用 `waitUntil` 异步向全局 DO 上报增量；全局 DO 超限时把 `tripped_until` 写入 KV；网关在每个 isolate 内存里缓存该 KV 值（TTL 30 秒）作为前置检查。代价是超限后最多 30 秒的滞后，可接受。

## 4. API 协议

基础 URL：`https://api.rubify.app`（同一个 Worker 用 Route 挂到这个子域名；`https://rubify.app` 走静态资源，见 §8）。所有响应 JSON；错误统一：

```json
{ "error": { "code": "QUOTA_EXHAUSTED", "message": "…", "retryAfter": null, "requestId": "…" } }
```

| code | HTTP |
|---|---|
| INVALID_INPUT / NOT_JAPANESE | 400 |
| UNAUTHENTICATED / TOKEN_EXPIRED | 401 |
| QUOTA_EXHAUSTED | 402 |
| ACCOUNT_SUSPENDED | 403 |
| TEXT_TOO_LONG | 413 |
| CLIENT_TOO_OLD | 426 |
| RATE_LIMITED（带 `Retry-After`） | 429 |
| UPSTREAM_ERROR | 502 |
| TIMEOUT | 504 |

请求头：`Authorization: Bearer <access JWT>`、`X-Request-Id: <uuid>`、`X-Client-Version: 1.2.0`、`X-Client-Id: <install uuid>`。

### 4.1 端点

| 方法 路径 | 用途 | 请求体 | 响应 |
|---|---|---|---|
| `POST /v1/chat` | 非流式 JSON 任务 | `{mode: annotate\|quiz\|vocab\|vocabExample, text?, word?, sentence?, targetLang, jlptLevel}` | `{result, usage: {inputTokens, outputTokens, credits, cached}, balance}` |
| `POST /v1/stream` | 流式文本任务 | `{mode: translate\|translateAny\|grammar, text, targetLang}` | SSE，见 §4.2 |
| `POST /v1/tts` | 朗读 | `{text, voice?}` | `audio/mpeg` 二进制；头 `X-Usage-Credits`、`X-Cache: HIT/MISS` |
| `GET /v1/me` | 登录态 + 余额 | — | `{user: {id, email, name, avatar}, plan, balance: {credits, dailyGrant, periodEnd}, limits}` |
| `POST /auth/start` | 发起登录 | `{codeChallenge, redirect: "extension"\|"web"}` | `{authUrl, state}` |
| `GET /auth/callback` | Google 回调 | query `code, state` | 302 到扩展 `chromiumapp.org` 或 web 账号页，带一次性 `grant` |
| `POST /auth/token` | 换 token | `{grant, codeVerifier}` 或 `{refreshToken}` | `{accessToken, refreshToken, expiresIn}` |
| `POST /auth/logout` | 撤销 | `{refreshToken}` | 204 |
| `DELETE /account` | 删除账号 | — | 202（异步级联） |
| `GET /account/usage?days=30` | 用量 | — | `usage_daily` 行 |
| `POST /billing/checkout` | 订阅 / 加油包 | `{price}` | `{url}` |
| `POST /billing/portal` | Stripe Portal | — | `{url}` |
| `POST /webhooks/stripe` | Stripe | raw body | 200 |

模式与厂商的映射（`llm/modes.ts`）：

| mode | prompt | 输出 | 默认模型档 | maxChars | 缓存 |
|---|---|---|---|---|---|
| annotate | DEFAULT_FURIGANA_PROMPT + FURIGANA_SCHEMA | JSON tokens（服务端跑 repairTokens / cleanFuriganaTokens / patchMissingReadings） | flash 档 | 2000 | KV 30 天 |
| translate | getTranslationPrompt | 流 | flash 档 | 4000 | 否 |
| translateAny | getPageTranslationPrompt | 流 | flash 档 | 4000 | 否 |
| grammar | getGrammarAnalysisPrompt | 流 | 中档 | 2000 | 否 |
| quiz | getQuizPrompt + QUIZ_SCHEMA | JSON | 中档 | 4000 | 否 |
| vocab / vocabExample | getVocabEntry*Prompt + schema | JSON | flash 档 | 200 + 1000 | KV（vocab 按 word+lang） |
| tts | — | 音频 | 默认 TTS 模型 | 1000 | R2 90 天 |

"档"到具体模型 ID 的映射放环境变量（`MODEL_FLASH`、`MODEL_MID`、`MODEL_TTS`），换模型不发版。

### 4.2 SSE 格式

```
event: chunk
data: {"text":"…"}

event: done
data: {"usage":{"inputTokens":312,"outputTokens":180,"credits":9},"balance":{"credits":4980}}

event: error
data: {"code":"UPSTREAM_ERROR","message":"…"}
```

客户端 `lib/gateway.js` 复用现有 `readSSE`，`extractDelta` 解析 `chunk`，遇到 `error` 事件抛 `YomeruError`。

### 4.3 CORS

允许的 Origin：`chrome-extension://<商店 ID>`、`chrome-extension://<开发 ID>`（仅 staging）、`https://rubify.app`。扩展页面发起的 fetch 带 `Origin: chrome-extension://…`；service worker 同样。凭据方式：扩展用 Bearer 头，web 用 httpOnly cookie（`04` §6），两者不混用。

## 5. 数据模型

### 5.1 D1

```sql
-- 0001_init.sql
CREATE TABLE users (
  id            TEXT PRIMARY KEY,            -- ulid
  google_sub    TEXT UNIQUE NOT NULL,
  email         TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  name          TEXT, avatar_url TEXT,
  plan          TEXT NOT NULL DEFAULT 'free', -- free | pro
  plan_status   TEXT,                        -- active | past_due | canceled
  plan_period_end INTEGER,                   -- unix seconds
  stripe_customer_id TEXT UNIQUE,
  suspended_at  INTEGER, deleted_at INTEGER,
  created_at    INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE refresh_tokens (
  id          TEXT PRIMARY KEY,              -- 随机 id
  user_id     TEXT NOT NULL REFERENCES users(id),
  family_id   TEXT NOT NULL,                 -- 一次登录 = 一个 family，轮换时沿用
  token_hash  TEXT NOT NULL UNIQUE,          -- sha256(token)
  client      TEXT NOT NULL,                 -- extension | web
  created_at  INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  used_at     INTEGER, replaced_by TEXT, revoked_at INTEGER
);
CREATE INDEX idx_rt_user ON refresh_tokens(user_id);
CREATE INDEX idx_rt_family ON refresh_tokens(family_id);

CREATE TABLE ledger (                        -- 财务真相，低频，可审计
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,                 -- daily_grant | plan_grant | topup | refund | adjust | snapshot
  credits     INTEGER NOT NULL,              -- 正为入账，负为出账；snapshot 时为当时余额
  ref         TEXT,                          -- stripe event id / invoice id / 管理员备注
  created_at  INTEGER NOT NULL,
  UNIQUE(user_id, kind, ref)                 -- 幂等：同一 ref 只记一次
);
CREATE INDEX idx_ledger_user ON ledger(user_id, created_at);

CREATE TABLE usage_daily (                   -- Cron 从 Analytics Engine 聚合
  user_id TEXT NOT NULL, day TEXT NOT NULL, mode TEXT NOT NULL,
  requests INTEGER NOT NULL, cached INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, tts_chars INTEGER NOT NULL,
  cost_micro_usd INTEGER NOT NULL, credits INTEGER NOT NULL,
  PRIMARY KEY (user_id, day, mode)
);

CREATE TABLE subscriptions (                 -- 阶段 2
  id TEXT PRIMARY KEY,                       -- stripe subscription id
  user_id TEXT NOT NULL, price_id TEXT NOT NULL, status TEXT NOT NULL,
  current_period_start INTEGER, current_period_end INTEGER, cancel_at_period_end INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE stripe_events (                 -- webhook 幂等
  id TEXT PRIMARY KEY, type TEXT NOT NULL, received_at INTEGER NOT NULL, processed_at INTEGER
);

CREATE TABLE reader_sessions (               -- 阶段 4 云同步预留：只存索引，正文在 R2
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT, url TEXT,
  block_count INTEGER, updated_at INTEGER NOT NULL, r2_key TEXT NOT NULL
);
```

### 5.2 Durable Object `QuotaAccount`（每用户一个，`idFromName(userId)`）

SQLite 存储，三张表：

```sql
CREATE TABLE state (k TEXT PRIMARY KEY, v TEXT);        -- balance, plan, last_grant_day, breaker_tripped_at
CREATE TABLE holds (request_id TEXT PRIMARY KEY, credits INTEGER, mode TEXT, created_at INTEGER);
CREATE TABLE daily (day TEXT PRIMARY KEY, spent INTEGER, requests INTEGER);   -- 熔断用，保留 7 天
```

RPC 方法（`extends DurableObject`）：

| 方法 | 语义 |
|---|---|
| `reserve(requestId, estimate, mode)` | 先做当日发放（`last_grant_day < today` 则加 `DAILY_GRANT`，封顶 `DAILY_CAP`）；检查熔断；`balance - sumHolds ≥ estimate` 则写 hold；同 `requestId` 已存在直接返回成功（幂等） |
| `settle(requestId, actual)` | 删 hold，`balance -= actual`，`daily.spent += actual`；hold 不存在（已过期释放）则仍扣 actual 但记日志 |
| `release(requestId)` | 删 hold，不扣 |
| `grant(credits, kind, ref)` | 入账；调用方先在 D1 ledger 插入成功（UNIQUE 去重）再调 DO，DO 侧也按 ref 去重 |
| `snapshot()` | 返回 `{balance, holds, daily}` 给 `/v1/me` 与对账 |
| `setPlan(plan, periodEnd)` | Stripe webhook 更新 |
| `alarm()` | 只在存在 hold 时调度（`reserve` 时若无 alarm 则 `setAlarm(now + 10min)`），到点把超过 10 分钟的 hold **按估算值结算**而不是释放——请求大概率已经打到上游产生了成本（与 `05` §2.3 一致）；仍有 hold 则再排下一次。不要给每个用户 DO 固定 5 分钟轮询，空转 alarm 会随用户数线性收费 |

DO 是余额的唯一真相；D1 `ledger` 是它的审计副本。两者由 Cron 对账（`05` §7）。

### 5.3 KV / R2 键

| 存储 | 键 | 值 | TTL |
|---|---|---|---|
| KV `CACHE` | `fg:v1:<sha256(model + "\n" + text)>` | `{tokens, rawTokens}` | 30 天 |
| KV `CACHE` | `vocab:v1:<sha256(lang + word)>` | 词条 JSON | 30 天 |
| KV `CACHE` | `idem:<userId>:<requestId>` | 非流式响应体 | 24 小时 |
| R2 `AUDIO` | `tts/v1/<sha256(model + voice + text)>.mp3` | 音频 | 生命周期规则 90 天 |
| R2 `AUDIO` | `sessions/<userId>/<sessionId>.json` | 阅读会话正文（阶段 4） | 随账号 |

缓存键只含 hash，不含用户 ID；值是派生结果。furigana 结果里 `t` 字段就是原文，所以缓存实际保存了用户文本的片段，隐私政策要如实写"匿名缓存的标注结果最多保留 30 天"。

### 5.4 Analytics Engine 数据点

```ts
env.USAGE.writeDataPoint({
  indexes: [userId],
  blobs: [mode, model, cacheStatus, clientVersion, errorCode ?? ""],
  doubles: [inputTokens, outputTokens, ttsChars, costMicroUsd, credits, latencyMs],
});
```

每日 Cron 用 SQL API 按 `userId, day, mode` 聚合写 `usage_daily`。

Analytics Engine 在高写入量下会**自适应采样**，查询必须用 `SUM(_sample_interval * credits)` 这类加权聚合而不是裸 `SUM`；数据点也是尽力写入，不保证不丢。所以 `usage_daily` 只能是"分析真相"，永远不能从它计费或反推余额，`05` §7 对账留 50 credits 容差的原因也在这里。

## 6. 上游调用

- 三家适配器从 `lib/providers.js` 的思路移植为 TS，但地址改成 AI Gateway universal endpoint（`https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/<provider>/…`），厂商 key 通过 AI Gateway BYOK 存放或作为 Worker secret 注入。
- 必须提取 usage：OpenAI 请求体加 `stream_options: {include_usage: true}`，最后一个 chunk 带 `usage`；Anthropic `message_start.message.usage.input_tokens` + `message_delta.usage.output_tokens`；Google 每个 chunk 的 `usageMetadata` 取最后一个。
- `max_tokens` 按 mode 设上限（annotate 4096、translate 2048、grammar 1500、quiz 2048），防止模型失控输出。
- 上游超时 30s 首字节、30s 空闲（与客户端一致）；重试只对 429/5xx 且非流式，最多 2 次；流式失败直接报错让客户端决定。
- AI Gateway 配置 fallback：flash 档主模型失败 → 另一家 flash 模型。furigana 的 prompt 是模型无关的，可换；translate 同理。
- **Gemini 必须走付费层。** Google 的 Gemini API 免费层条款允许其使用请求内容改进模型，付费层不允许（实施时核对当时条款）。托管模式的隐私政策要写"不用于训练"，前提是三家全部用付费账户。OpenAI 与 Anthropic 的 API 默认不训练，但也要在账户里确认没有开启数据共享。
- **提前把厂商账户升到够用的速率档位。** 三家的新账户都有较低的每分钟请求 / token 上限，按累计消费或预付金额升档，有的档位要等 7–14 天。M2 上线前按"峰值 200 并发用户 × reader 并发 3"估一次 RPM / TPM 需求，预充值到对应档位，否则上线当天就是一片 `RATE_LIMITED`。
- **模型质量回归集。** 托管模式把标注默认切到 flash 档（比多数 BYO 用户现在用的默认模型便宜也弱），fallback 又会跨厂商切换，而振假名准确率是整个产品的立身之本。建一个 300–500 句的黄金集（多音字、送假名、人名地名、数字量词、口语缩约，每句人工核对读音），写成 `server/test/eval/`：对指定模型跑 annotate，输出 token 级准确率与 JSON 合规率。**换 `MODEL_FLASH`、改 prompt、加 fallback 目标之前必须跑**，准确率低于基线 1 个百分点即不上线。翻译与语法用小规模人工抽检即可。

## 7. 缓存策略

| 内容 | 命中率预期 | 收费 | 说明 |
|---|---|---|---|
| furigana | 高（热门新闻、教材、小说大家读同样的段落） | 命中免费 | 确定性输出，跨用户共享安全 |
| TTS | 中 | 命中免费 | 音频体积大，R2 egress 免费才划算 |
| vocab | 高（词是有限集合） | 命中免费 | 按 targetLang 分键 |
| translate / grammar | 低 | 不缓存 | 按 targetLang 分叉，且有一定随机性 |

命中不扣费是产品卖点也是成本杠杆，但要防"用缓存探测别人读过什么"：缓存键含完整文本 hash，无法枚举，风险可接受。

## 8. 环境、配置与部署

三个环境，`wrangler.toml` 的 `[env.staging]` / `[env.production]`：

D1 是单主区域数据库，创建时用 `--location` 给出位置提示；主要用户在东亚与东南亚，选 `apac`，否则每次登录 / 刷新 token 都要绕到美国。DO 会在首次请求的地域附近创建，不用管。

| | dev（本地 `wrangler dev`） | staging | production |
|---|---|---|---|
| 域名 | localhost:8787 | `staging-api.rubify.app` | `api.rubify.app` |
| D1 / KV / R2 / DO | 本地模拟 | 独立实例 | 独立实例 |
| Google OAuth client | dev | staging | prod |
| Stripe | test mode | test mode | live |
| CORS 允许的扩展 ID | 开发 ID | 开发 ID + 商店 ID | 商店 ID |

Secrets（`wrangler secret put`，绝不进仓库）：`JWT_SECRET`、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`、`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GOOGLE_AI_API_KEY`、`STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`、`CF_AIG_TOKEN`。

Vars（明文配置）：`MIN_CLIENT_VERSION`、`MODEL_FLASH`、`MODEL_MID`、`MODEL_TTS`、`DAILY_GRANT`、`DAILY_CAP`、`USER_DAILY_BREAKER`、`GLOBAL_DAILY_BUDGET_USD`、`FEATURE_FLAGS`（逗号分隔的 mode 开关，如 `tts=off` 可临时关掉最贵的功能）。

CI（`.github/workflows/server.yml`）：PR 跑 `vitest`；合并 main 部署 staging；打 `server-v*` tag 部署 production；部署前 `wrangler d1 migrations apply`。扩展 CI（`extension.yml`）：跑 Node 测试、`scripts/package.sh` 产 zip 存 artifact；打 `ext-v*` tag 时附到 GitHub Release，手动上传商店（商店 API 自动发布留到阶段 3）。

## 9. 安全基线

- 厂商 key 只在 Worker secret / AI Gateway；扩展包与仓库里 `grep -r "sk-"` 应为空，CI 加检查。
- JWT：HS256，`JWT_SECRET` ≥ 32 字节随机；claims `{sub, plan, iat, exp(15min), ver}`；`ver` 与 D1 `users.token_version` 比对可实现全局强制登出（可选，阶段 2）。
- 所有输入 zod 校验；文本长度上限按 mode；`annotate` 校验含日文（复用 `lib/japanese.js`）；拒绝控制字符与超长单行。
- Rate Limiting binding：`/auth/*` 按 IP 每分钟 10 次；`/v1/*` 按 userId 每分钟 60 次、`/v1/tts` 每分钟 20 次；未登录请求按 IP。
- Stripe webhook：`constructEventAsync` 验签 + `stripe_events` 去重。
- 静态页 CSP：`default-src 'self'`；账号页无内联脚本。
- 日志不记文本内容，只记长度、mode、模型、耗时、token 数、错误码。
- 依赖最少化：`hono`、`zod`、`stripe`、`ulid`；每次升级看 changelog。
