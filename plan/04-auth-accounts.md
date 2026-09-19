# 04 · 阶段 1（M2）：认证与账号

## 目标

用户不填 API key 也能用 Yomeru：Google 登录 → 拿到每日免费额度 → 请求走托管网关。本文只讲认证、账号页与删除账号；额度引擎见 `05`，网关与协议见 `03`。

**验收标准**

- 扩展弹窗一键 Google 登录，全流程不离开浏览器；Edge / Brave 等 Chromium 分支同样可用。
- access token 15 分钟过期后静默刷新，用户无感；refresh token 被重放时该用户全部会话被撤销。
- 登出后旧 refresh token 立即失效；删除账号后 D1 / R2 / DO / Stripe 数据在 24 小时内级联清理。
- 未登录且未配 key 时，所有功能入口给出"登录或填 key"二选一提示，而不是报错。
- 隐私政策 v2 与数据披露表更新，商店重新审核通过；审核员备注含测试账号。

## 1. 流程

### 1.1 扩展端登录（授权码 + PKCE，回调经自有域名）

```
popup 点击「Google 登录」
  │ 1. 生成 code_verifier / code_challenge(S256)，存 chrome.storage.session
  │ 2. POST /auth/start {codeChallenge, redirect:"extension", extId}
  │    ← {authUrl, state}          (Worker 把 state→{challenge, redirect, extId, exp} 存 KV 5 分钟)
  │ 3. chrome.identity.launchWebAuthFlow({url: authUrl, interactive: true})
  ▼
Google 同意页 ──302──▶ https://rubify.app/auth/callback?code=…&state=…
  │ 4. Worker 校验 state，用 code + client_secret 换 Google id_token（服务端到服务端）
  │ 5. 校验 id_token（iss/aud/exp/email_verified），upsert users(google_sub)
  │ 6. 生成一次性 grant（随机 32 字节，KV 60 秒，绑定 code_challenge）
  ▼
302 ──▶ https://<extId>.chromiumapp.org/#grant=…
  │ 7. launchWebAuthFlow resolve，扩展拿到 grant
  │ 8. POST /auth/token {grant, codeVerifier}
  │    Worker 验 S256(codeVerifier) == challenge → 签发 access JWT + refresh token
  ▼
存 chrome.storage.local { auth: {accessToken, accessExp, refreshToken, user} }
```

用 `launchWebAuthFlow` 而不是 `getAuthToken`：后者绑定 Chrome profile 账号、无 refresh token、Chromium 分支不可用。回调打到自有域名而不是直接 `chromiumapp.org`：Google 侧只需登记一个 redirect URI，扩展 ID 变化（开发 / 商店）只影响 Worker 的白名单；web 端复用同一个回调。

Google 的 access token 与 id_token 用完即弃，不存储、不下发给扩展。会话凭证只有自签 JWT。

**`launchWebAuthFlow` 不能在 popup 里直接调用。** 授权窗口一弹出，popup 就因失焦被关闭，popup 的 JS 上下文随之销毁，`launchWebAuthFlow` 的 promise 永远不会 resolve，用户看到的是"登录窗口关了但什么都没发生"。正确做法：popup 只发一条 `{type: "signIn"}` 消息，由 service worker 调用 `launchWebAuthFlow`（SW 不需要用户手势，挂起的扩展 API 调用会让 SW 保持存活），SW 拿到 grant 换 token 后写 `chrome.storage.local`，popup 若还开着靠 `storage.onChanged` 更新，关了下次打开也是登录态。PKCE 的 `code_verifier` 因此也由 SW 生成并放 `chrome.storage.session`。`account.html` 是扩展页，不会因失焦关闭，可以直接调用。

**只有 Google 一种登录方式是市场决策，不只是技术决策。** 中国大陆完全访问不到 Google，意味着大陆用户一个都登录不了（不只是"慢"）；也有一部分用户不愿意把 Google 账号关联给一个小工具。若决策门 1 的答案包含大陆，或 M2 数据显示登录页放弃率高，第二种方式是**邮件魔法链接**（Cloudflare Email Sending 发信，D1 存一次性 token，15 分钟有效），只增加一个 `/auth/email` 端点与一张表，其余 token 体系不变。⚠ 见 `README.md` 决策门 10。

### 1.2 Web 端登录

账号页（`server/static/account.html`）同一流程，`redirect: "web"`，回调后 302 到 `/account`，token 放 httpOnly + Secure + SameSite=Lax cookie（`access` 15 分钟，`refresh` 30 天，path 限制 `/auth/token`）。web 端只在两种场景需要登录：Stripe 回跳后展示状态、卸载扩展后删除账号。

### 1.3 Google Cloud 配置

- 一个 GCP 项目，OAuth 同意屏幕 External，scope 只要 `openid email profile`（非敏感 scope，不需要 Google 安全评估；品牌验证可选，不做时同意页显示项目名而非 logo）。
- Web application 类型的 OAuth client（不是 Chrome Extension 类型，因为回调在自有域名），redirect URI：`https://rubify.app/auth/callback`、`https://staging.rubify.app/auth/callback`、dev 用 `http://localhost:8787/auth/callback`。
- OAuth 同意屏幕的应用名填 **Rubify**（不是 Yomeru）——用户登录时看到的是背后的账号与计费服务品牌，这与扩展在商店里的名称「読める Yomeru」是两个东西，类似"用 Google 登录"弹窗里显示的是服务商而非某个具体客户端皮肤。隐私政策与服务条款链接同样挂在 `rubify.app`。
- 同意屏幕的隐私政策与服务条款链接指向新域名。

## 2. Token 设计

| | access token | refresh token |
|---|---|---|
| 形式 | JWT HS256 | 随机 256 位，base64url |
| 有效期 | 15 分钟 | 30 天，每次使用轮换 |
| 存储 | 扩展：`chrome.storage.local`；web：cookie | D1 `refresh_tokens`（只存 sha256） |
| 验证 | Worker 本地验签 | 查 D1（低频） |
| claims | `sub`（userId）、`plan`、`iat`、`exp`、`cv`（client: ext/web） | — |

**轮换与重放检测**：`/auth/token` 收到 refresh token → 查 `token_hash`。若 `used_at` 非空（已被用过一次），判定泄露，`UPDATE refresh_tokens SET revoked_at=now WHERE family_id=?` 撤销整个 family，返回 401。否则标记 `used_at`，插入新 token（同 family），返回新对。旧 token 保留 24 小时供审计后由 Cron 删除。

**为什么不存 `chrome.storage.sync`**：sync 会把 token 复制到用户的其他设备，轮换后其他设备拿到的旧 token 触发重放检测，整个 family 被误杀。`local` 每设备一份，各自轮换。

**JWT 里放 `plan` 的代价**：升级订阅后最长 15 分钟才反映到 JWT。热路径不查 D1 换来的延迟，可接受；Stripe webhook 处理时同时更新 DO 的 plan，额度判断以 DO 为准，JWT 的 plan 只用于展示与限流档位。

## 3. 扩展侧实现

### 3.1 `lib/auth.js`（ESM，SW / popup / options / reader / account 共用）

```js
export async function signIn()                 // 上述流程；只能在 SW 或扩展页（account.html）里执行，popup 通过消息触发 SW，见 §1.1
export async function signOut()                // POST /auth/logout + 清 local
export async function getAccessToken()         // 有效则直接返回；过期则刷新（单飞：并发调用共享同一个 refresh promise）
export async function getUser()                // local 缓存的用户信息
export function onAuthChange(cb)               // storage.onChanged 包装
export async function fetchMe()                // GET /v1/me，写入 local.balance
```

刷新单飞很重要：reader 并发 3 个翻译 + 2 个 TTS 同时发现 token 过期，只能有一次刷新，否则第二次刷新会因轮换触发重放检测。实现：模块级 `let refreshing = null`；SW 被回收后模块状态丢失也无妨，因为 refresh token 只在 `/auth/token` 成功后才被标记 used，失败的并发刷新只是多一次 401。更稳的做法是在 `chrome.storage.session` 存一个 `refreshLock` 时间戳，两者都做。

### 3.2 `lib/gateway.js` 的请求包装

```js
async function gatewayFetch(path, init, opts) {
  const token = await getAccessToken();
  const res = await fetch(BASE + path, { ...init, headers: {
    ...init.headers, Authorization: `Bearer ${token}`,
    "X-Request-Id": opts.requestId, "X-Client-Version": VERSION, "X-Client-Id": await clientId(),
  }, signal: opts.signal });
  if (res.status === 401) {                     // 一次强制刷新后重试一次
    if (opts._retried) throw new YomeruError("UNAUTHENTICATED", ...);
    await forceRefresh();
    return gatewayFetch(path, init, { ...opts, _retried: true });
  }
  if (!res.ok) throw await errorFromResponse(res);   // 解析 {error:{code,…}}
  return res;
}
```

`/v1/stream` 与 `/v1/tts` 的响应带 `balance`，写入 `chrome.storage.local.balance`，popup 通过 `storage.onChanged` 实时刷新余额显示，不需要额外请求。

### 3.3 `manifest.json`

- `permissions` 加 `identity`。
- `host_permissions` 加 `https://api.rubify.app/*`。
- 商店提交时重新填写 `identity` 的权限理由："Signs you in with your Google account so you can use Yomeru without your own API key."

### 3.4 UI

- **popup**：顶部一行账号状态。未登录：`[Google 登录]` + "或在设置里填自己的 API key"。已登录：头像 + 邮箱 + 今日剩余额度条 + "账号"链接。
- **`account/account.html`**（扩展页）：余额与本次周期用量、近 30 天按功能的用量柱状图（`GET /account/usage`）、当前 API 模式、登出、删除账号（二次确认，输入邮箱）；阶段 2 加"升级 / 管理订阅"按钮。
- **options**：API 模式三选一中的"托管"解除禁用；托管模式时模型下拉置灰并注明"由 Yomeru 选择"。
- **reader / content 的错误块**：`UNAUTHENTICATED` → "登录"按钮（打开 popup 做不到，改为打开 `account.html` 并在那里提供登录按钮，`launchWebAuthFlow` 在扩展页同样可用）。

## 4. 账号删除级联

`DELETE /account` → 立即：`users.deleted_at = now`，撤销全部 refresh token，返回 202。Cron（每小时）处理 `deleted_at` 非空且 `< now - 1h` 的用户：

1. Stripe：`customers.del`（先取消订阅）。
2. R2：`list` + `delete` `sessions/<userId>/`（阶段 4 才有数据）。
3. DO：调 `QuotaAccount.purge()` 删除存储（`storage.deleteAll()`）。
4. D1：删 `refresh_tokens`、`subscriptions`、`usage_daily`；`ledger` 保留但 `user_id` 替换为 `deleted:<hash>`（财务记录保留 7 年是常见要求，且账本不含个人信息）；最后删 `users` 行。
5. Analytics Engine 不可删（只保留 90 天且以 userId 索引，隐私政策写明）。更稳妥的做法是**加密粉碎**：AE 的 `indexes` 不直接放 userId，而放 `sha256(userId + per_user_salt)`，salt 存在 `users` 表；删除账号时删掉 salt，AE 里的历史数据即刻无法再与任何人关联。Cron 聚合时用同一 salt 反查即可。成本是一次 hash，收益是隐私政策里可以写"删除账号后所有用量记录立即去标识"。

给用户的确认页显示"数据将在 24 小时内删除"，符合 Google OAuth 用户数据政策与商店政策对自助删除的要求。

## 5. 隐私政策 v2 与商店重审

引入账号后现有政策的"我们不收集任何数据、不运营服务器"变成虚假陈述，必须整体重写。要点：

| 章节 | 内容 |
|---|---|
| 收集什么 | Google 账号的 email、名字、头像、`sub`；用量记录（功能、token 数、时间，不含文本）；安装 ID |
| 文本如何处理 | 托管模式：文本经我们的服务器转发给 AI 厂商，**不落盘**；匿名缓存的标注结果与音频（以文本 hash 为键）保留最多 30 / 90 天。自带 key 模式：文本不经过我们 |
| 第三方 / 子处理者 | OpenAI / Anthropic / Google / ElevenLabs（各自政策链接）、Cloudflare（基础设施）、支付方（阶段 2）。写成一张可查的子处理者表（名称、用途、地区），GDPR 与企业客户都会要 |
| 不用于训练 | 明确写"我们向 AI 厂商发送的文本不会被用于模型训练"，前提是三家都用付费 API 账户（Gemini 免费层会训练，见 `03` §6） |
| 卸载问卷 | 卸载时打开匿名问卷页，只记选项计数（`01` §1.4） |
| 保留 | 账号存在期间；删除后 24 小时内清理；账本保留 7 年（去标识） |
| 用户权利 | 导出用量、删除账号（扩展内与网页两个入口） |
| 分析 | 自建功能计数，无 Google Analytics、无广告 |

披露表勾选：Personally identifiable information（email、name）、Authentication information（我们自己的会话 token，Google token 不存）、User activity（用量记录）、Website content（转发的文本）。三项认证仍全部为"是"。

审核员备注（Developer Dashboard "Notes for reviewer"）：提供一个测试 Google 账号的邮箱与密码（专用账号，预充足够额度，关闭两步验证），以及 5 步操作说明：安装 → 打开 NHK Easy → 选中一段 → 点工具栏"訳" → 看到译文。这一条缺失会直接被拒。

## 6. 排期（认证与账号部分）

| 任务 | 天 |
|---|---|
| GCP 配置、域名、DNS、wrangler 环境 | 0.5 |
| `/auth/*` 四个端点 + state/grant KV + JWT + refresh 轮换 + 测试 | 2.5 |
| `lib/auth.js` + `gatewayFetch` + 401 处理 + 单飞刷新 | 1.5 |
| popup 登录态 + `account/` 页 + options 联动 + i18n（en/zh-CN/zh-TW/ja） | 2.5 |
| web 账号页（静态，登录 / 删除账号）+ cookie 会话 | 1 |
| 删除账号级联 + Cron + 测试 | 1 |
| 隐私政策 v2 + 披露表 + 审核员备注 + 重新提交 | 1 |

合计约 10 天，与 `05` 的额度引擎和 `03` 的网关并行推进，M2 整体 18–25 天。
