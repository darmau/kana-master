# Yomeru 产品化方案（交接文档）

这份文档是把 Yomeru 从"自用的 BYO key 扩展"变成"Chrome 商店上架 + 账号 + 付费额度"的完整规划，供后续制定实施计划使用。

代码现状见 `CLAUDE.md`（架构、目录、消息协议、存储键）。本文只写**要新增和要改的部分**，不重复已有架构描述。

---

## 0. 已确定的决策

| 项 | 决策 |
|---|---|
| 后端平台 | 全部 Cloudflare，不引入外部数据库或托管服务 |
| 数据库 | D1（SQLite）。**不用** Postgres / Neon / Supabase |
| 认证 | Google OAuth（自建，不用第三方 auth 服务） |
| 支付 | Stripe（Chrome Web Store Payments 已下线，必须自接） |
| 计费形态 | 免费额度 + 月订阅（含配额）+ 额度加油包。**不做纯 token 计价** |
| BYO key | 保留。用户可继续用自己的 key，不消耗托管额度 |
| 上架节奏 | 先以 BYO key 形态上架，账号与计费分阶段跟进 |

### 仍未决定 / 需要确认

1. **目标市场**。本方案默认海外为主。若主要面向中国大陆，Cloudflare、Stripe 两项都不成立（CF 在国内访问质量不稳定，Stripe 无法收款），整套架构需要重做为国内云 + ICP 备案 + 国内支付。**这个问题会推翻大部分选型，应最先确认。**
2. **免费额度的具体数值与订阅定价**。需要先跑一遍成本模型（见 §4）。
3. **是否做云同步**（词汇本 / 阅读会话）。本方案按"暂不做，但数据模型预留"处理。

---

## 1. 最根本的架构变化

现在：`扩展 → 厂商 API 直连`，用户的 key 存在 `chrome.storage.sync`。

之后：`扩展 → Cloudflare Worker 网关 → 厂商 API`。**你的 API key 只存在于 Worker 的 secret 里，绝不能进扩展包**——扩展是明文分发的，任何人解压即可读取。

好消息是改造面很小：所有 API 调用已经收敛在 `background/service-worker.js` 一个入口，`lib/api.js` 本来就是多厂商路由层。做法是在 `PROVIDERS` 里加第四个分支 `yomeru`（自家网关），接管 `callChat` / `streamChat` / `fetchTTS` 三个出口。内容脚本、reader、popup 的调用方式不变。

### 必须同时做的一件事：prompt 搬到服务端

这是**安全边界，不是重构偏好**。

现在 `streamTranslation(settings, systemPrompt, text, onChunk)` 由 SW 显式传入 system prompt，而 SW 运行在用户机器上。上线后网关就成了一个可被任意驱动的通用 LLM 代理，会被人拿去跑与日语学习无关的任务，成本由你承担。

改造后的协议：客户端只传 `{ mode, text, targetLang, jlptLevel }`，其中 `mode ∈ {annotate, translate, translateAny, grammar, quiz, vocab}`，prompt 完全由 Worker 根据 mode 拼装。`lib/api.js` 里那几百行 prompt 常量原样搬进 Worker，客户端只留一个薄壳。

网关侧还要加：`max_tokens` 上限、输入长度硬上限、furigana 请求校验输入确实含日文（现有的中日文区分逻辑可复用）。

---

## 2. 后端架构（全 Cloudflare）

```
Workers          网关 + 计费逻辑 + prompt + 认证端点
Durable Objects  每用户余额（预扣 / 结算 / 退款）
D1               用户、会话、订阅、账本、日聚合
R2               TTS 音频缓存、（预留）阅读会话云同步
KV               furigana 结果缓存
Queues + Cron    对账、日聚合、清理过期数据
Pages            账号中心 + 落地页（docs/ 直接迁入）
AI Gateway       上游统一入口：缓存 / 限流 / 成本统计 / 重试与 fallback
Analytics Engine 原始用量日志
```

### 核心设计原则：热路径不碰数据库

一次翻译请求的完整路径是：**验签 JWT（纯本地 WebCrypto，零网络）→ DO 扣额度（CF 内网一跳）→ 调厂商 → 流式返回 → DO 结算**。全程不读 D1。

D1 只在这些场合被访问：登录、刷新 token、Stripe webhook、账号页加载、Cron 对账。约占请求总量的 1%。

这条原则是整套方案成立的前提。如果热路径要查库，Workers 的全球边缘部署就失去意义（东京用户的请求要绕回数据库所在区域）。

### 为什么 Workers 适合这个负载

后端 95% 的工作是把 SSE 从厂商转发给扩展——请求生命周期里绝大部分时间在等上游吐字节，几乎不消耗 CPU。Workers 按 CPU 时间计费，等待 subrequest 不计入配额，所以一个跑 25 秒的流式翻译成本接近于零。换成常驻容器方案（Railway/Fly + Go）则要为"等待"付费，且只有单区域。

### D1 的三条使用约束

D1 够用，但以下三类数据不能塞进去：

1. **大对象走 R2。** 阅读会话（正文 + tokens + 译文 + 语法）单个几百 KB，按现有 LRU 30 计算，一千用户就能顶到 D1 的 10GB 上限。做法是一个会话一个 R2 对象（key: `user/{uid}/session/{id}`），D1 只存索引（id、标题、更新时间、块数）。这正是 `lib/reader-store.js` 现有的"索引 + 每会话一键"结构，原样搬到云端即可。
2. **高频用量日志不进 D1。** 每次调用的 token 数、模型、耗时写 Analytics Engine，Cron 每日聚合一次写回 D1 的 `usage_daily`。这样 D1 一年只新增几十万行。
3. **需要交互式事务的逻辑放 DO。** D1 只有 `batch()`（一组语句原子执行），**没有跨 await 的交互式事务**，写不出"BEGIN → 读余额 → 判断 → 扣减 → COMMIT"。所以强一致的部分（预扣、结算、退款、并发争用）全部放在 Durable Object 里——DO 存储是串行且事务性的，那段逻辑写成普通顺序代码即可。留给 D1 的是追加写和幂等 upsert（账本插一行、webhook 用 event id 去重、日聚合覆盖写），一条语句就够。

**职责切分：DO 管强一致，D1 管持久追加。** D1 的短板恰好落在不需要的地方。

### 账本与用量日志必须分开

- **账本（ledger）**：财务真相。充值、月度配额发放、订阅扣款、退款、余额快照。低频（每用户每月几行）、必须可审计、放 D1。
- **用量日志（usage）**：每次调用的 token 数与成本。高频、只追加、只用于分析和对账、放 Analytics Engine，日聚合后落 D1。

合在一张表里写，一年后必然要做一次痛苦的迁移。

### DO 与 D1 的对账

DO 存储是持久的，但它是余额的唯一真相来源，必须有 Cron 定期把 DO 余额快照写回 D1，并做双向核对（D1 的账本累加 vs DO 的当前余额），发现漂移告警。

---

## 3. 认证（Google OAuth，自建）

### 关键决策：用 `launchWebAuthFlow`，不用 `getAuthToken`

`chrome.identity.getAuthToken` 看起来更简单，但它绑定用户的 Chrome profile 账号、不返回 refresh token、且在 Edge/Brave 等 Chromium 分支上不可用。而你还需要 web 端账号中心用同一套登录逻辑。

用 `chrome.identity.launchWebAuthFlow` 走标准 OAuth 2.0 授权码流程 + PKCE，扩展和 web 端共用一套。

### 必须注意的坑

**扩展 ID 必须提前固定。** `launchWebAuthFlow` 的 redirect URI 是 `https://<extension-id>.chromiumapp.org/`，而扩展 ID 在"加载已解压"和商店发布时是不同的。现在就要在 `manifest.json` 加 `"key"` 字段把开发期 ID 固定住，并在 Google Cloud Console 同时注册开发与生产两个 redirect URI。更稳妥的做法是让 OAuth 回调打到你自己的域名，由 Worker 处理后再重定向回扩展——这样换 ID 不影响 Google 侧配置，web 端也能复用同一个回调。

**Google 的 token 不是你的会话凭证。** Google 只用于验证一次身份（拿到 `sub` 和 email），之后立刻换成你自己签发的 JWT。绝不要把 Google 的 access token 当作后续 API 的凭证——它无法被你撤销，也无法承载你的余额和套餐信息。

**token 存 `chrome.storage.local`，不存 `sync`。** sync 会同步到 Google 服务器，多设备共享同一个 refresh token 会让轮换逻辑无法正确实现，还要额外做隐私披露。

### 自建认证要做对的边界条件

- 授权码流程带 PKCE（`code_challenge` / `code_verifier`）
- `state` 参数校验，防 CSRF
- access token 短期（15 分钟），JWT，Worker 用 WebCrypto 本地验签
- refresh token 长期、存 D1、**每次刷新轮换**，并检测重放（旧 token 被再次使用 → 判定泄露，撤销该用户全部会话）
- 登出要真正撤销服务端 refresh token，不只是清本地
- 账号删除要级联清理：D1 各表、R2 对象、DO 实例、Stripe customer

需要 `manifest.json` 增加 `identity` 权限。

---

## 4. 计费与额度

### 定价形态

**不做纯 token 计价。** 用户无法预估"翻译一篇文章多少钱"，每次点击都要心算，体验极差。

采用**免费额度 + 月订阅（含每月配额）+ 额度加油包**。内部按 token 计量，但**对用户暴露的单位必须是人话**——"本月还可阅读约 40 篇文章"，而非"剩余 82,400 tokens"。

### 免费额度的发放方式

**用"每天发放少量"，不用"注册赠送一次性大额"。** 注册送额度会在上线一周内被脚本注册薅干；改成每日发放后，薅一个号只能拿到一天的量，收益低到不值得，而正常用户的留存反而更好。

### 计量与折算

- 厂商返回的 `usage` 按 prompt / completion 分别计价，TTS 按字符数
- `lib/models.js` 已有定价表，把它变成 Worker 侧的定价源，加上 markup
- **流式请求的 usage 通常在最后一个 chunk**，中途断开就拿不到账单数据，需要按已发送字节估算兜底

### 六个必须做对的工程点

1. **预扣 + 结算**。请求开始时按文本长度预估并 hold 一笔额度，结束后按实际用量多退少补。否则余额 1 块钱的用户可以并发发起 20 个请求把你打穿。
2. **幂等性**。客户端生成 request id 随请求发送，网关按 id 去重。现有重试逻辑是指数退避最多 3 次，没有幂等键会导致重复扣费。
3. **原子扣减**。reader 的翻译并发是 3，TTS 抓取并发是 2，同一用户瞬时 5 个请求争抢同一余额。这是 Durable Object 存在的理由。
4. **失败退款**。上游 500、超时、用户取消（TTS 已实现 `ttsCancel` + AbortController）都要退回预扣额度。**取消这条尤其重要**——reader 的 seek 会取消远处在途请求，属于高频路径。
5. **服务端缓存是最大的降本杠杆**。furigana 对同一段文本几乎是确定性输出，跨用户命中率高（大家在读同样的新闻和小说）。做 `hash(text + model) → tokens` 缓存放 KV，命中不扣费或半价扣费。TTS 音频同理，放 R2（零 egress 费用），键为 `hash(text + model + voice)`。翻译因 targetLang 分叉多，缓存价值较低，但热门内容仍值得缓。
6. **单用户成本熔断**。单账号单日烧超过阈值自动降级并告警，避免一个 bug 或一个恶意用户吃掉整月收入。

### Stripe 集成注意点

- Checkout（充值/订阅）+ Customer Portal（管理订阅、发票）+ Webhook（对账）
- **Workers 上验签必须用 `constructEventAsync`**（边缘运行时的 crypto 是异步的），且需要 raw body
- Webhook 处理必须幂等：用 Stripe 的 event id 做 `INSERT ... ON CONFLICT DO NOTHING`
- 面向欧盟销售涉及 VAT/OSS，用 Stripe Tax 处理

### 额度耗尽的降级体验

这是最容易被忽略的一环。设想：reader 正在流式翻译，到第 20 段时余额耗尽。正确行为是**已完成的段落全部保留，剩余段落进入 error 状态并显示"额度不足 + 充值入口"**。你现有的 per-block 状态机（`data-state` = idle/loading/done/error/stale）正好能承载这个，不需要新机制。

---

## 5. 防滥用与成本安全

- 邮箱验证（Google OAuth 天然满足）
- 注册频率限制（按 IP / 设备指纹）
- 单请求文本长度硬上限、每用户每日请求上限
- 服务端强制持有 prompt（见 §1）
- furigana 请求校验输入含日文，拒绝把网关当通用翻译/对话代理
- 异常用量实时告警 + 单用户熔断
- Cloudflare Rate Limiting binding / WAF 做第一道防线

---

## 6. 扩展侧的改造点

### 新增

| 文件 | 作用 |
|---|---|
| `lib/gateway.js` | 自家网关的 provider 实现，接管 chat / stream / tts 三个出口 |
| `lib/auth.js` | 登录态、token 刷新、401 统一处理 |
| `lib/errors.js` | 结构化错误码 |
| `lib/quota.js` | 余额本地缓存 + 变更广播（`storage.onChanged`） |
| `account/` | 账号页（余额、用量、订阅入口、登出、删除账号） |

### 修改

- `lib/api.js` — prompt 搬走，只保留客户端薄壳
- `background/service-worker.js` — 注入 auth header、生成 request id、处理 401/402、token 刷新重试
- `options/options.js` — BYO key 与托管模式的切换与优先级说明
- `popup/popup.js` — 登录态、余额常驻显示
- `manifest.json` — 加 `identity` 权限、加 `key` 字段、收窄 host_permissions
- `docs/privacy.html` — 重写（见 §7）

### 必须先做：结构化错误码

现在全链路的错误是 `err.message` 字符串直接扔给 UI 显示。引入账号后 UI 必须能区分：

```
UNAUTHENTICATED   → 引导登录
TOKEN_EXPIRED     → 静默刷新后重试
QUOTA_EXHAUSTED   → 显示充值入口
RATE_LIMITED      → 显示稍后重试 + 倒计时
UPSTREAM_ERROR    → 显示重试按钮（现有行为）
CLIENT_TOO_OLD    → 提示升级扩展
```

这个改动会散落到 reader、content、popup 每一个错误展示点。**建议在动网关之前先把错误码体系做掉**，否则后面要到处补。

### BYO key 与托管模式的优先级

建议：**用户配了自己的 key 就默认走自己的 key**（省你的成本），并在 UI 明示当前走哪条路径；托管额度只在未配置 key 时使用。也可以给一个显式开关让用户自己选。

保留 BYO key 有三重收益：省推理成本、给重度用户一个不受额度限制的出口、以及在商店审核和隐私叙事上多一张牌（"你可以选择完全不经过我们的服务器"）。

### 客户端版本协商

扩展的自动更新不是即时的，你会长期面对多版本客户端同时在线。请求头带 `X-Client-Version`，网关能返回 `CLIENT_TOO_OLD` 引导升级。

### 灰度与回滚

网关上线初期让客户端同时保留两条路径，出问题能一键切回 BYO key 直连。

---

## 7. Chrome 商店合规

### 现在就存在的问题（无论走不走后端都要修）

1. **`host_permissions` 过宽**。当前是 `["https://api.openai.com/*", "https://*/*", "http://*/*"]`。`https://*/*` + `http://*/*` 是审核团队的红旗。真正的需求是"用户自定义 base URL 时访问任意主机"——正确做法是把广域权限移到 `optional_host_permissions`，只在用户真的填了自定义 base URL 时用 `chrome.permissions.request()` 动态申请。默认安装只保留网关域名 + 三家厂商域名。内容脚本的 `<all_urls>` 保留（这是产品本质），说明清楚即可。

   注意：`chrome.permissions.request()` 在 service worker 的 `onMessage` 监听器里必须**在任何 `await` 之前**调用，否则用户手势已丢失，会抛 "must be called during a user gesture"。

2. **隐私政策与代码不一致**（两处）：
   - ElevenLabs 是代码里真实存在的第四个 TTS 提供商（`lib/models.js`、`options/options.html` 都有），但 `docs/privacy.html` 的"发送给第三方"一节只列了 OpenAI / Anthropic / Google。
   - 隐私政策和 README 都写了 "Chrome Built-in AI / 本地翻译引擎"，但代码里已经没有这个功能了。**声称一个不存在的隐私保护特性，比漏写更严重。**

3. **`manifest.json` 缺 `key` 字段**（见 §3）。

### 引入账号后必须做的

**隐私政策整体重写。** 现在写的是"我们不收集任何数据、我们不运营任何服务器"，引入账号和网关后这句话直接变成虚假陈述。**数据披露表与实际行为不符是最常见的下架原因。**

重写后要勾选：个人身份信息（邮箱）、用户活动（用量记录）、网站内容（经过网关的文本）。

关于文本保留策略，建议**明确承诺不落盘、只记 token 计数**。这既是最省事的合规姿态，也是对日语学习者（经常在读私人邮件和社交内容）实打实的卖点。前提是缓存层要脱敏——key 用 hash，且只缓存 furigana 这类无隐私增量的结果。

**必须给审核员提供测试账号。** 引入登录后，如果审核员登录不进去就无法测试核心功能，会直接被拒。在 Developer Dashboard 的"审核员备注"里提供一组可用的测试凭证和使用步骤。这一条很多人栽跟头。

### 上架素材与流程

- 单一用途声明要收敛成一句话，把振假名 / 翻译 / 语法 / TTS / 测验 / 词汇本统一叙述为"帮助日语学习者读懂日文网页"。**功能罗列成大杂烩会被判定 single purpose 违规。**
- 每一条权限和 host_permission 都要有具体的、大白话的理由。"扩展运行所需"会被拒。
- 商店描述里禁止出现实现细节（service worker、chrome.storage 之类），只写用户收益。
- 至少 1 张 1280×800 或 640×400 截图；128×128 商店图标；440×280 宣传图块（推荐）
- 有人看管的支持邮箱（Google 的下架和政策通知发到这里）
- $5 开发者注册费，新账号需要身份验证
- 打包脚本要排除 `.git/`、`test/`、`docs/`、`CLAUDE.md`、`PRODUCTIZATION.md`、`README.md`、`.claude/`、`.agents/`、`skills-lock.json`
- 建议先用 unlisted 或 trusted tester 内测一轮再公开

**远程代码禁令天然合规**——零依赖零构建是纯手写 vanilla JS 的额外红利。但注意：不能从服务端下发 prompt 以外的可执行代码。

---

## 8. 运维与可观测性

- 关键指标：错误率、p50/p95 延迟（按 mode 分）、每模型成本、缓存命中率、DO 与 D1 的余额漂移
- 上游厂商故障时的降级策略（AI Gateway 的 fallback 可以承担一部分）
- 告警：成本异常、错误率突增、webhook 处理失败堆积
- 状态页
- D1 有 30 天时间旅行回滚——对存账本的库来说这条比什么都实在，但仍应定期导出备份

---

## 9. 产品化的非技术部分

**首次使用引导必须有。** 现在的核心交互（选中文本出工具栏、hover 段落出 gutter 手柄）没有任何提示。你自己知道所以感觉不到，新用户装完会一脸茫然然后卸载。这是留存的第一道坎。

**额度可见性是付费产品的刚需。** popup 里常驻显示剩余额度和本月消耗。付费用户对"我的钱花到哪了"极度敏感。

**用量分析要做但别塞 Google Analytics**（要多披露一堆东西还影响审核）。用 Analytics Engine 自建最小埋点，只记功能调用计数，不记内容。

**法务与运营**：服务条款、退款政策、发票、客服入口、账号删除自助入口（Google OAuth 的用户数据删除要求和商店政策都需要）。

---

## 10. 分阶段路线

**阶段 0 — 以 BYO key 形态上架（不含账号和收费）。**
只需要收窄权限、加 `key` 字段、修隐私政策的两处不一致、准备素材和打包脚本。一到两天的工作量。

这一步把"能不能过商店审核"和"能不能做成 SaaS"两个风险彻底解耦。先拿到真实用户、评价和使用数据，再决定值不值得为它建一整套后端。反过来做的话，可能花两个月建好计费系统却卡在审核上，或者上架后发现没人愿意付费。

**阶段 0.5 — 结构化错误码 + prompt 收敛准备。**
纯客户端重构，不依赖后端，但决定后面所有 UI 改动的成本。

**阶段 1 — 账号，不收钱。**
Google 登录 + 账号中心 + （可选）云同步词汇本与阅读会话。观察注册转化率，验证用户是否愿意为这个产品建立账号关系。

**阶段 2 — 网关 + 额度 + 支付。**
Worker 网关、DO 余额、D1 账本、Stripe、缓存层、防滥用。这是工作量最大的一块。

**阶段 3 — 订阅精细化、团队/教育版、更多语言市场。**

---

## 附：最容易做错的地方

按踩坑概率排序，实施时重点关注：

1. **把 Google 的 access token 直接当会话凭证用**。必须换成自己签发的 JWT。
2. **扩展 ID 没提前固定**，导致上架当天所有 OAuth 回调失效。
3. **prompt 留在客户端**，网关沦为通用 LLM 代理被白嫖。
4. **没有幂等键**，重试导致重复扣费。
5. **取消/失败不退款**，reader 的 seek 是高频取消路径，漏掉会持续扣错用户的钱。
6. **账本和用量日志写在同一张表**，一年后被迫迁移。
7. **隐私政策没跟着改**，数据披露表与实际行为不符导致下架。
8. **没给审核员测试账号**，直接被拒。
9. **热路径查 D1**，让 Workers 的全球部署失去意义。
10. **在 `chrome.storage.sync` 里存会话 token**。

---

*本文档基于 2026-09 的产品与平台现状（Cloudflare D1/DO/Workers 的限制、Neon 与 Supabase 的对比、Chrome Web Store 政策）。这些都在快速迭代，实施前请复核当时的官方文档。*
