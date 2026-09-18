# Yomeru 产品化技术方案

这套文档把 `PRODUCTIZATION.md` 里的讨论结论落成可执行的工程计划：做什么、用什么、按什么顺序做、每一步怎么算完成。`PRODUCTIZATION.md` 记录的是"为什么这样选"，本目录记录的是"具体怎么做"。两者冲突时以本目录为准，并回头修订 `PRODUCTIZATION.md`。

代码现状以 `CLAUDE.md` 为准。本目录只写要新增和要改的部分。

**命名。** 商业化项目正式名称定为 **Rubify**——账号、计费、后端网关这套服务的品牌。Chrome 扩展本身继续沿用 `CLAUDE.md` 里已经定好的多语言名称（日文「読める」、英文 Yomeru），商店 listing 不改名。两者的关系类似"一个叫 Yomeru 的客户端，背后跑着一个叫 Rubify 的账号/计费服务"：用户在扩展里看到的是 Yomeru，在 Google 登录弹窗、账号页、账单、支持邮箱上看到的是 Rubify。下文所有域名示例统一用 `rubify.app`（示意，注册前需核实可用性），产品/价格命名统一用 Rubify 前缀（如 "Rubify Pro"）。

## 文档索引

| 文件 | 内容 | 对应阶段 |
|---|---|---|
| [01-store-launch.md](01-store-launch.md) | 以 BYO key 形态上架 Chrome 商店：权限收窄、合规修正、素材、打包、审核 | 阶段 0 |
| [02-client-refactor.md](02-client-refactor.md) | 客户端重构：结构化错误码、`lib/api.js` 拆分、双路径（自带 key / 托管网关）、请求元数据 | 阶段 0.5 |
| [03-backend.md](03-backend.md) | 后端技术选型、仓库布局、API 协议、数据模型、部署与环境 | 阶段 1 起 |
| [04-auth-accounts.md](04-auth-accounts.md) | Google OAuth 自建认证、JWT 与 refresh token、账号页、删除账号 | 阶段 1 |
| [05-quota-billing.md](05-quota-billing.md) | 额度引擎（Durable Object）、计量、成本模型、Stripe 订阅与加油包、账本对账 | 阶段 1（额度）/ 阶段 2（收费） |
| [06-ops-security-compliance.md](06-ops-security-compliance.md) | 可观测、成本安全、备份、安全基线、隐私政策与商店合规、发布流程 | 贯穿 |
| [07-roadmap.md](07-roadmap.md) | 里程碑、任务分解（WBS）、估时、依赖、风险登记、每阶段完成定义 | 贯穿 |

建议阅读顺序：本页 → 07（看全局排期）→ 01 → 02 → 03 → 04 → 05 → 06。

## 一页纸结论

**分五个里程碑，先上架再建后端，账号与免费托管额度一起上，收费最后接。**

| 里程碑 | 交付物 | 用户看到什么 | 预估工作量（工作日） |
|---|---|---|---|
| M0 商店上架 | BYO key 版本公开可装 | 商店可安装，装完有引导页 | 4–6 天 + 审核等待 |
| M1 客户端就绪 | 错误码、api.js 拆分、网关 provider 壳、请求 ID | 无可见变化（内部重构） | 6–9 天 |
| M2 账号 + 免费托管 | Worker 网关、Google 登录、每日免费额度、账号页、隐私政策 v2 | 不填 key 也能用，每天有免费量 | 18–25 天 |
| M3 收费 | Stripe 订阅 + 加油包、账本对账、额度可见性 | 可以付费买额度 | 12–18 天 |
| M4 打磨与扩张 | 云同步、Edge 商店、团队/教育版、缓存降本 | 视数据决定 | 持续 |

累计到 M3 约 40–58 个工作日。按一个人全职加 AI 辅助算，大约 2.5–3 个月到可收费。详细分解见 `07-roadmap.md`。

### 与 PRODUCTIZATION.md 阶段划分的一处不同

原讨论把"账号"（阶段 1）和"网关 + 额度 + 支付"（阶段 2）分开，阶段 1 的账号没有任何实际收益，只能靠可选的云同步吸引注册。本方案把**网关和每日免费额度提前到 M2 与账号一起上，Stripe 单独作为 M3**。理由有三个：

1. 新用户最大的门槛是"先去 OpenAI 申请一个 API key"。免费托管额度直接消除这个门槛，注册转化率的观察才有意义。
2. 在接 Stripe 之前拿到真实的成本数据（每用户每天烧多少、哪个功能占大头），定价才不是拍脑袋。`05-quota-billing.md` 的成本模型显示 TTS 单位成本远高于文本，定价必须建立在实测上。
3. 把原来最大的一块（网关 + 额度 + 支付）拆成两个里程碑，每个都能独立验收和回滚。

代价是 M2 有一段"只花钱不收钱"的窗口。用每日发放的小额免费额度、单用户熔断和全局日预算上限把敞口封在可控范围内（见 `05` §2 与 `06` §2）。

## 技术选型总表

| 领域 | 选择 | 一句话理由 |
|---|---|---|
| 扩展本体 | 保持 vanilla JS、零构建、零依赖 | 远程代码禁令天然合规，审核友好；现有 4 个 jsdom 测试套件继续可用 |
| 后端运行时 | Cloudflare Workers（TypeScript） | 流式转发几乎不耗 CPU，Workers 只按 CPU 时间计费；全球边缘 |
| Web 框架 | Hono | Workers 原生、轻、内置 JWT / CORS 中间件、可测 |
| 输入校验 | zod | 网关每个端点都要做长度与形状校验 |
| 数据库 | D1 + 手写 SQL + wrangler migrations | 8 张表不值得上 ORM；D1 只做追加写和幂等 upsert |
| 强一致状态 | Durable Objects（SQLite 存储，RPC 调用） | 余额预扣、结算、并发争用需要串行事务，D1 做不到 |
| 缓存 | KV（furigana 结果）、R2（TTS 音频） | KV 读快、R2 零出流量费 |
| 用量日志 | Analytics Engine，Cron 日聚合回 D1 | 高频只追加，不进 D1 |
| 上游调用 | 经 Cloudflare AI Gateway | 免费拿到日志、缓存、限流、fallback |
| 认证 | Google OAuth 授权码 + PKCE，自签 HS256 JWT，refresh token 轮换 | 扩展与 web 共用；不依赖 Chrome profile 账号 |
| 支付 | Stripe Checkout + Customer Portal + Webhook + Stripe Tax | Chrome Web Store Payments 已下线 |
| Web 页面 | 与网关同一个 Worker，走 Workers Static Assets | 一个项目、一个域名、一套部署；`docs/` 迁入 |
| 测试 | 扩展：Node + jsdom（现有）；后端：vitest + `@cloudflare/vitest-pool-workers` | 后端测试跑在真实 workerd 里 |
| CI/CD | GitHub Actions：测试 → 打包 zip → `wrangler deploy` | 打 tag 发布 |
| 密钥管理 | `wrangler secret` | 厂商 key 永不进仓库、永不进扩展包 |
| 仓库结构 | 单仓库（扩展 + `server/`），不上 npm/pnpm workspaces | 只有一个真正的 Node 包；扩展零构建、浏览器 ESM 用不上裸标识符；共享代码走相对路径 import，见 `03` §2.1 |

不选的东西及原因：Supabase / Neon（讨论已定，全 Cloudflare）；Pages（新项目统一用 Workers Static Assets，少一个部署对象）；Drizzle（表少，迁移用 wrangler 自带即可）；Google Analytics（多披露一堆数据且影响审核，用 Analytics Engine 记功能计数）。

## 开工前必须回答的问题（决策门）

这些问题会推翻选型，应在 M1 开始前定下来。M0 不受影响，可以先做。

1. **目标市场是海外还是中国大陆？** 本方案按海外为主。若主要面向大陆用户，Cloudflare 访问质量不稳、Stripe 无法收款，后端全部重选。我的建议是海外优先：日语学习者遍布全球，大陆用户可继续用 BYO key，付费通道后续再补。
2. **收款主体。** Stripe 账户需要一个 Stripe 支持地区的法律实体（个人或公司）。若本人在大陆，需要 Stripe Atlas 或港/新/美实体，这件事周期长（数周），应最早启动。
3. **域名。** 网关、OAuth 回调、Stripe 回跳、隐私政策都要挂在自己的域名下，本方案按 `rubify.app` 示意（需核实可注册）。现在 `docs/` 挂在 `nicekana.github.io/kana-master`，上架阶段可以继续用，M2 之前必须换。
4. **免费额度数值与订阅价格。** `05` 给了成本模型和示意数字，最终值等 M2 跑出实测成本后再定。
5. **云同步（词汇本、阅读会话）做不做。** 本方案按"M4 再看"处理，数据模型预留（`03` §5）。

## 预算（不含人力）

| 项 | 费用 |
|---|---|
| Chrome Web Store 开发者注册 | $5 一次性 |
| 域名 | 约 $10–30 / 年 |
| Cloudflare Workers Paid | $5 / 月（DO、Queues、Cron 需要付费计划） |
| Google Cloud（OAuth） | $0 |
| Stripe | 无月费，按交易 2.9% + $0.30（跨境另加） |
| 上游模型费用 | 见 `05` 成本模型；M2 阶段建议设全局日预算上限 $10–20 |

## 仓库策略：单仓库，不上 workspace 协议

扩展与后端放同一个 git 仓库（`server/` 子目录），协议变更在一个 PR 里同时改两端——这就是本方案的 monorepo 决定，理由和取舍见 `03` §2.1。**不**引入 npm/pnpm workspaces：仓库里事实上只有 `server/` 一个真正的 Node 包，扩展按 `CLAUDE.md` 的既定原则保持零依赖零构建，浏览器 ES Modules 也用不上 workspace 的裸标识符 import。共享代码（`lib/prompts.js`、`lib/furigana.js`、`lib/japanese.js`）靠两端各自相对路径 import 同一份源文件解决，不需要抽成 workspace 包。根目录会新增一个不声明 `workspaces` 字段的 `package.json`，只做任务编排（`npm test` 同时跑扩展和后端测试）并把现在临时装的 jsdom 依赖锁定下来。

## 工作方式约定

- 每个阶段结束更新 `CLAUDE.md`，保持它是代码现状的唯一描述。
- 商店相关的所有材料（描述、权限理由、数据披露、版本历史）维护在 `CHROMEWEBSTORE.md`，打包时排除。
- 版本号：扩展用语义化版本，网关用 `MIN_CLIENT_VERSION` 拒绝过旧客户端。
