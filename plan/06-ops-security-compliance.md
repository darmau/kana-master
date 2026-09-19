# 06 · 运维、安全与合规

贯穿所有阶段。每条注明从哪个里程碑起生效。

## 1. 可观测性（M2 起）

### 1.1 三层数据

| 层 | 工具 | 内容 | 保留 |
|---|---|---|---|
| 日志 | Workers Logs（Observability 开启） | 结构化 JSON：requestId、userId、mode、model、status、latency、errorCode；**不记文本** | 7 天 |
| 指标 | Analytics Engine `USAGE` 数据集 | 每次调用一条（`03` §5.4） | 90 天 |
| 上游 | AI Gateway 日志 | 每个上游请求的 token、成本、耗时、缓存状态 | 按 AI Gateway 设置 |

### 1.2 必看指标（做成一张 Cloudflare Dashboard 或简单的 `/admin/metrics` 页）

- 错误率按 code（`UPSTREAM_ERROR`、`TIMEOUT` 突增 = 厂商故障；`QUOTA_EXHAUSTED` 突增 = 额度设得太低或被薅）
- p50 / p95 延迟按 mode（annotate 首字节、stream 首 chunk）
- 每日上游成本按模型、按 mode；TTS 占比
- 缓存命中率（furigana、TTS）
- DAU、日新增登录、Free → Pro 转化（M3）
- DO 对账漂移条数

### 1.3 告警

Cron 每 15 分钟跑 `alerts.ts`，查 Analytics Engine，满足条件用 `send_email` binding 发到自己的邮箱：

| 条件 | 阈值 |
|---|---|
| 5xx 错误率 | 15 分钟内 > 5% 且样本 > 20 |
| 全局成本 | 当日累计 > `GLOBAL_DAILY_BUDGET_USD` 的 80% |
| 单用户熔断 | 任一触发即时（DO 内 `waitUntil` 直接发） |
| Stripe webhook 失败 | `stripe_events.processed_at` 为空且超过 10 分钟 |
| 对账漂移 | 任一 |
| 上游全挂 | 连续 5 分钟 annotate 成功数为 0 且请求数 > 0 |

Cloudflare 自带的 Notifications 再加一条 Workers 错误率告警作为兜底。

### 1.4 状态页

M3 前不做独立状态页；`https://rubify.app/status` 一个静态页，故障时手动更新一行文字即可。

## 2. 成本安全（M2 起）

三道闸，任一触发都不影响自带 key 用户：

1. **请求级**：mode 白名单、文本长度上限、`max_tokens` 上限、annotate 必须含日文。让网关无法被当作通用 LLM 代理。
2. **用户级**：DO 内的每日熔断（`05` §2.4）；Rate Limiting binding 的每分钟频率上限；注册按 IP 限频（Google OAuth 已挡掉大部分脚本注册）。
3. **全局级**：`GLOBAL_DAILY_BUDGET_USD`，由一个单例 DO（`idFromName("global")`）累计当日成本。**它不能出现在请求热路径上**（全球请求串行过一个实例）：用户 DO 在 `settle` 后 `waitUntil` 异步上报增量，全局 DO 超限时写 KV `budget:tripped_until`，网关每个 isolate 内存缓存该值 30 秒作为 `reserve` 前置检查（`03` §3）。`FEATURE_FLAGS` 可单独关掉 TTS 这类高成本 mode。

厂商侧同时设硬预算（OpenAI / Anthropic / Google 控制台的月度上限），作为代码之外的最后一道保险。

上游故障降级：AI Gateway fallback 到另一家 flash 模型；全部不可用时返回 `UPSTREAM_ERROR`，客户端显示重试并在错误文案里提示"可在设置中切换到自带 key"。

## 3. 备份与恢复（M2 起）

| 数据 | 机制 |
|---|---|
| D1 | 内置 30 天 Time Travel；另加 GitHub Actions 每日 `wrangler d1 export` 到私有 R2 bucket，保留 90 天 |
| DO 余额 | 每日 `snapshot` 写入 ledger（`05` §7）；DO 存储本身持久且有副本 |
| R2 缓存 | 可丢，不备份 |
| R2 会话（M4） | 版本控制开启即可 |
| Secrets | 记录在密码管理器；`wrangler secret` 不可读回 |
| 扩展私钥 `.pem` | 只影响开发期 ID，丢了重新固定；商店 ID 由 Google 持有 |

恢复演练：M3 上线前做一次"从 D1 导出 + DO 快照重建余额"的演练并记录步骤。

## 4. 安全清单

### 扩展侧（M0 起）

- [ ] 仓库与打包产物无任何厂商 key（CI grep `sk-|AIza|xi-`）。
- [ ] 内容脚本注入的 DOM 全部走 `escapeHtml` / `textContent`（现有 `tokensToHtml` 已转义，Markdown 渲染的语法结果需确认渲染器不执行 HTML）。
- [ ] 扩展页 CSP 保持默认（MV3 禁内联脚本），`prefs-boot.js` 模式延续。
- [ ] 会话 token 只在 `chrome.storage.local`，登出清空；`debugMode` 日志不打印 token。
- [ ] 消息监听器校验 `sender.id === chrome.runtime.id`，拒绝其他扩展的消息。
- [ ] **仓库是公开的**（`github.com/darmau/kana-master`）。若 `server/` 留在同一公开仓库（决策门 8），所有阈值（每日发放、熔断、全局预算、限流数值）只能放环境变量与 secret，不能写死在代码里；对账与告警逻辑公开无妨，但 prompt 里若有针对性的防注入措辞也会公开，按公开设计。

### 服务端（M2 起）

- [ ] 所有端点 zod 校验；错误响应不回显输入。
- [ ] JWT secret 轮换流程：支持两个 secret 并存（`JWT_SECRET`、`JWT_SECRET_PREV`）验签，签发只用新的，15 分钟后旧的可删。
- [ ] refresh token 只存 hash；重放检测撤销 family。
- [ ] CORS 白名单精确到扩展 ID；web cookie `SameSite=Lax` + 对状态改变的请求校验 `Origin`。
- [ ] Stripe webhook 验签 + 幂等；Stripe secret 只在 production 环境是 live key。
- [ ] 静态页 CSP `default-src 'self'; connect-src 'self'`。
- [ ] 依赖锁定（`package-lock.json`），Dependabot 开启。
- [ ] 管理端点（`/admin/*`）用单独的长随机 token + IP 白名单，M3 前只有对账报表一个页面。

## 5. 合规

### 5.1 隐私政策版本

| 版本 | 生效 | 关键陈述 |
|---|---|---|
| v1（现有修订） | M0 | 不收集、不运营服务器；列出四家厂商与自定义 base URL；说明 sync 经 Google 同步 |
| v2 | M2 | 收集账号信息与用量；托管模式文本经服务器转发不落盘；匿名缓存 30 / 90 天；Cloudflare 作为处理方；删除账号流程 |
| v3 | M3 | 加 Stripe（支付信息由 Stripe 处理，我们只存 customer id）；账本保留期 |

每次改动同步更新：`docs/privacy.html`（M2 起迁到 `server/static/privacy.html`）、商店披露表、`CHROMEWEBSTORE.md`、GCP 同意屏幕链接。

隐私政策之外还要维护一张**子处理者清单**（OpenAI、Anthropic、Google、ElevenLabs、Cloudflare、支付方；用途与地区），并在 v2 起写明"发送给 AI 厂商的文本不用于训练"（前提见 `03` §6）。GDPR 第 27 条欧盟代表、日本 APPI 的适用性评估见 `08` §7.3。

### 5.1.1 商店 trader 声明（欧盟 DSA）

商店后台的 trader / 非 trader 声明：M0、M2 可为非 trader；**M3 收费前必须切为 trader 并通过 Google 对地址、邮箱、电话的验证，这些信息会公开显示在 listing 上**。个人开发者提前准备可公开的地址。若走 MoR，向 MoR 与商店确认填写方式。见 `08` §7.2。

### 5.2 需要的法律文本（M2）

- 服务条款：使用限制（不得用于批量翻译/对话代理等与日语学习无关用途）、账号终止、免责、适用法。
- 退款政策（M3）：`05` §6.3。
- Cookie 说明：web 端只有会话 cookie，一句话即可。
- 联系方式：支持邮箱 + 处理时限承诺（例如 3 个工作日）。

### 5.3 Chrome 商店每次重审的检查表

- manifest 权限变化 → 权限理由更新。
- 数据行为变化 → 披露表 + 隐私政策同时改。
- 引入登录 → 审核员备注含测试账号与步骤。
- 截图仍反映当前 UI。
- 版本号已升。

### 5.4 Google OAuth 政策

- 非敏感 scope，不需要安全评估；`Limited Use` 声明加到隐私政策。
- 用户数据删除入口在扩展内与网页都可达（`04` §4）。
- 同意屏幕的应用名、logo、域名与商店 listing 一致。

## 6. 支持与反馈（M0 起）

- 支持邮箱在商店 listing、隐私政策、扩展 account 页三处一致。
- 扩展 options 页底部"反馈"链接 → GitHub Issues（M0）→ 后续可换成表单。
- 常见问题页（`docs/faq.html`）：怎么拿 API key、为什么某些站不工作（黑名单 / iframe / Shadow DOM）、额度怎么算（M2）。
- 每周看一次商店评论并回复。

## 7. 发布流程

### 扩展

1. 分支合并 main 后 CI 跑测试并产 zip。
2. 升版本号（manifest + `CHROMEWEBSTORE.md` 版本历史）。
3. 上传商店，如权限或数据行为变化则更新理由与披露。
4. 用户数大于阈值后启用商店的分阶段发布（percentage rollout），先 10% 观察 48 小时错误率再放全量。
5. 网关的 `MIN_CLIENT_VERSION` 只在协议不兼容时才升，且至少给旧版本 30 天缓冲。

### 服务端

1. PR → staging 自动部署 → 用开发版扩展指向 staging 回归（`apiBase` 在 `debugMode` 下可改）。
2. 打 tag → production。D1 迁移先跑、代码后发；迁移必须向后兼容前一个版本（先加列不删列）。
3. 回滚：`wrangler rollback` 到上一版本；D1 迁移不可自动回滚，所以迁移只做加法。

## 8. 用量分析（产品侧，M2 起）

只记功能调用计数，不记内容，不接 Google Analytics：

- 扩展侧本地计数（工具栏各按钮、手柄菜单、reader 各按钮、引导页完成率）每日汇总一次随 `/v1/me` 上报（已登录用户），字段进 Analytics Engine 另一数据集 `EVENTS`。
- 未登录用户不上报。隐私政策 v2 写明"匿名功能使用统计"。
- 首要看的漏斗：安装 → 引导页完成 → 首次标注 → 第 7 天仍活跃 → 登录 → 付费。
- **M0 没有任何遥测**（隐私政策承诺），可用数据只有：商店后台的安装 / 卸载 / 周活 / 评分、卸载问卷（`01` §1.4）、GitHub Issues 与商店评论。这些足够回答"要不要建后端"，每个里程碑的量化放行标准见 `08` §6。
