# 07 · 开发计划

## 1. 里程碑

按一个人全职（AI 辅助）估算，单位工作日。审核等待与外部办理（Stripe 主体、域名）为异步事项，不占工作日但决定日历时间。

| 里程碑 | 内容 | 工作日 | 日历（从 T0 起） | 前置 |
|---|---|---|---|---|
| **M0 商店上架** | `01` | 4–6 | 第 1–2 周提交，第 2–4 周通过 | 开发者账号、支持邮箱 |
| **M1 客户端就绪** | `02` | 6–9 | 第 2–4 周（与 M0 审核并行） | — |
| **M2 账号 + 免费托管** | `03` `04` `05`§1–5,7 | 18–25 | 第 4–9 周开发，第 9–10 周重审 | 域名、目标市场决策、GCP |
| **M3 收费** | `05`§6,8 | 12–18 | 第 10–13 周 | Stripe 主体（第 1 周就启动办理） |
| **M4 扩张** | 云同步、Edge、年付、团队版、缓存优化 | 持续 | 第 14 周起 | M2/M3 数据 |

到 M3 完成累计 40–58 个工作日，日历上约 3 个月。

## 2. 任务分解

任务 ID 格式 `<里程碑>.<序号>`。"验收"是可检查的结果。

### M0 商店上架

| ID | 任务 | 涉及文件 | 天 | 依赖 | 验收 |
|---|---|---|---|---|---|
| 0.1 | 注册开发者账号、支持邮箱、GCP 项目占位 | — | 0.5 | — | 账号可用 |
| 0.2 | manifest 收窄 host_permissions、加 optional、`minimum_chrome_version`、版本 1.1.0 | `manifest.json` | 0.5 | — | 安装警告只剩内容脚本一条 |
| 0.3 | 自定义 base URL 动态权限申请 / 释放 + api.js 权限检查 | `options/options.js`, `lib/api.js`, `_locales/*` | 1 | 0.2 | 填第三方 URL 保存弹权限框；拒绝后有提示；清空后权限被移除 |
| 0.4 | 固定扩展 ID（`key`）、`.gitignore` | `manifest.json` | 0.5 | — | 换目录加载 ID 不变 |
| 0.5 | 引导页 + `onInstalled` | `onboarding/`, `background/service-worker.js` | 1–1.5 | — | 首次安装自动打开；页内可试用工具栏 |
| 0.6 | 隐私政策 v1 修订、README、docs 落地页、CLAUDE.md | `docs/privacy.html`, `README.md`, `docs/*.html`, `CLAUDE.md` | 0.5–1 | — | `01` §1.5 表逐条清零 |
| 0.7 | 打包脚本 + 扩展 CI | `scripts/package.sh`, `.github/workflows/extension.yml` | 0.5 | — | CI 产出 zip，内含文件清单符合预期 |
| 0.8 | `CHROMEWEBSTORE.md`、文案、截图、宣传图 | `CHROMEWEBSTORE.md`, `store-assets/` | 1–1.5 | 0.5 | 所有必填素材齐全 |
| 0.9 | Unlisted 提交 → 商店版回归 → 内测 → Public | — | 0.5 + 等待 | 0.2–0.8 | 公开可安装 |

### M1 客户端就绪

| ID | 任务 | 涉及文件 | 天 | 依赖 | 验收 |
|---|---|---|---|---|---|
| 1.1 | `lib/errors.js`、线格式、SW 六处 sendResponse 与 port 消息 | `lib/errors.js`, `background/service-worker.js` | 0.5 | — | 所有错误经 `toYomeruError` |
| 1.2 | `KanaShared.describeError` + 20 余处展示点 + 动作按钮 + i18n key | `lib/shared.js`, `reader/reader.js`, `content/content.js`, `popup/popup.js`, `vocabulary/vocabulary.js`, `_locales/en` | 1.5 | 1.1 | 无效 key 显示"去设置"，上游错误显示"重试" |
| 1.3 | 拆分 prompts / providers / furigana / gateway 桩；抽 `lib/japanese.js` | `lib/*` | 1.5 | — | `lib/api.js` < 300 行；现有测试全绿 |
| 1.4 | 公开 API 签名调整、`streamText`、SW 不再持有 prompt、AbortSignal 贯穿、usage 透传 | `lib/api.js`, `background/service-worker.js` | 1.5 | 1.3 | port 断开时在途 fetch 被 abort（测试） |
| 1.5 | `resolveRoute`、`apiMode` 设置、options 三选一、popup 状态行、`clientId` | `lib/api.js`, `lib/storage.js`, `options/*`, `popup/*` | 1 | 1.3 | 12 种组合测试通过 |
| 1.6 | 测试：errors / api-route / providers / furigana / reader 扩展 | `test/*.test.mjs` | 1.5–2 | 1.1–1.5 | 新增 ≥ 40 个断言 |
| 1.7 | CLAUDE.md 更新、发布 1.2.0 | — | 0.5 | 1.6 | 商店更新通过 |

### M2 账号 + 免费托管

| ID | 任务 | 涉及 | 天 | 依赖 | 验收 |
|---|---|---|---|---|---|
| 2.1 | 域名（`rubify.app`）、DNS、根 `package.json`（任务编排，无 workspaces）、`server/` 脚手架（Hono、wrangler 三环境、vitest、CI）、静态资源接管 `docs/` | `package.json`, `server/*`, `.github/workflows/server.yml` | 1.5 | 决策门 1、3 | staging 可访问，`GET /healthz` 200；`npm test` 在根目录跑通扩展与后端两套测试 |
| 2.2 | D1 迁移 0001、`queries.ts`、ulid、错误中间件、版本中间件 | `server/src/db`, `middleware` | 1 | 2.1 | 迁移在三环境应用 |
| 2.3 | `/auth/*`、state/grant KV、JWT、refresh 轮换与重放检测、测试 | `server/src/routes/auth.ts`, `util/jwt.ts` | 2.5 | 2.2 | `04` 验收前三条 |
| 2.4 | `QuotaAccount` DO：reserve/settle/release/grant/snapshot/alarm、每日发放、熔断、测试 | `server/src/do` | 3 | 2.2 | `05` §8 M2 五条 |
| 2.5 | `llm/modes.ts`、providers（AI Gateway）、usage 提取、pricing、SSE 转换 | `server/src/llm` | 2.5 | 2.1 | 三家在 staging 各 mode 走通，usage 非空 |
| 2.6 | `/v1/chat` `/v1/stream` `/v1/tts` `/v1/me`：校验、限流、缓存、预扣结算、取消、AE 记录 | `server/src/routes/api.ts` | 3 | 2.3–2.5 | 端到端：扩展登录后不填 key 完成标注、翻译、朗读 |
| 2.7 | 全局预算 DO、`FEATURE_FLAGS`、告警 Cron、`send_email` | `server/src/cron/alerts.ts` | 1 | 2.4 | 人为超限收到邮件 |
| 2.8 | `lib/auth.js`、`lib/gateway.js` 实现、401 单飞刷新、balance 回写 | `lib/auth.js`, `lib/gateway.js` | 1.5 | 2.3, 2.6 | reader 并发 5 请求 token 过期只刷新一次 |
| 2.9 | popup 登录态 + 余额条、`account/` 页、options 托管解禁、错误动作"登录/查看额度"、i18n 四语 | `popup/*`, `account/*`, `options/*`, `_locales/*` | 2.5 | 2.8 | UI 走查 |
| 2.10 | web 账号页（登录、删除账号）、cookie 会话、terms、privacy v2 | `server/static/*` | 1.5 | 2.3 | 卸载扩展后仍能删账号 |
| 2.11 | 删除账号级联 Cron、日聚合 Cron、对账 Cron、D1 备份 Action | `server/src/cron/*` | 1.5 | 2.4 | 演练通过 |
| 2.12 | manifest `identity` + host、`CHROMEWEBSTORE.md`、披露表、审核员测试账号、提交重审 | `manifest.json`, `CHROMEWEBSTORE.md` | 1 | 2.9 | 审核通过 |
| 2.13 | 上线后两周观察：成本、命中率、熔断触发、注册转化；校准 `DAILY_GRANT` | — | 持续 | 2.12 | 出一页数据报告，输入 M3 定价 |

### M3 收费

| ID | 任务 | 涉及 | 天 | 依赖 | 验收 |
|---|---|---|---|---|---|
| 3.1 | Stripe 账户、产品与价格（test + live）、Tax、Portal 配置 | Stripe Dashboard | 1 | 决策门 2 | test mode 可结账 |
| 3.2 | `/billing/checkout` `/billing/portal`、`subscriptions` 表、Customer 创建 | `server/src/routes/billing.ts` | 1.5 | 3.1, 2.6 | Checkout 链接可用 |
| 3.3 | `/webhooks/stripe`：五类事件、幂等、ledger + DO 联动、退款、测试（含 test clock） | `server/src/routes/webhooks.ts` | 3 | 3.2 | `05` §8 M3 前两条 |
| 3.4 | DO：plan 额度周期发放、加油包分层扣减、负余额处理 | `server/src/do` | 1.5 | 3.3 | 单测覆盖三种余额来源顺序 |
| 3.5 | 对账扩展到订阅发放；漂移修正；管理报表页 | `server/src/cron/reconcile.ts`, `/admin` | 1.5 | 3.3 | 人为漂移检出 |
| 3.6 | 扩展 account 页升级 / 加油包 / 管理订阅；popup 月额度；成功页轮询；额度耗尽 UX（reader 停派发） | `account/*`, `popup/*`, `reader/reader.js` | 2.5 | 3.2 | 端到端购买后 1 分钟内余额更新 |
| 3.7 | 隐私政策 v3、退款政策、terms 更新、披露表、重审 | `server/static/*`, `CHROMEWEBSTORE.md` | 1 | 3.6 | 审核通过 |
| 3.8 | 灰度：先对 10% 用户显示付费入口，观察一周 | — | 0.5 + 等待 | 3.7 | 转化率与退款率数据 |

### M4 候选（按数据排序，不预先承诺）

- 云同步词汇本与阅读会话（`reader_sessions` 索引 + R2 正文；`lib/reader-store.js` 结构原样上云）。
- Edge Add-ons 上架（同一 zip）。
- 年付与教育/团队版（Stripe 多席位）。
- "高质量"开关（中档模型，按倍率扣 credits）。
- 商店 API 自动发布。
- 更多引导与学习功能（间隔重复复习词汇本）。

## 3. 关键路径与并行

```
T0 ─ 0.1 开发者账号 ─┐
   ─ Stripe 主体办理 ──────────────────────────────────────────────▶ 3.1
   ─ 域名 + 决策门 1 ──────────────▶ 2.1
0.2 → 0.3 → 0.8 → 0.9(提交) ─────── 审核等待 ───── 公开
              └─ 与 M1 并行：1.1 → 1.2 ；1.3 → 1.4 → 1.5 → 1.6 → 1.7
2.1 → 2.2 → ┬ 2.3 ─────────┐
            ├ 2.4 ─┐        ├ 2.6 → 2.8 → 2.9 → 2.12(重审)
            └ 2.5 ─┘        │
              2.7, 2.10, 2.11 可在 2.6 之后穿插
2.13 观察两周 → 3.1 → 3.2 → 3.3 → 3.4 → 3.5/3.6 → 3.7 → 3.8
```

关键路径是 M2 的 2.1 → 2.2 → 2.4/2.5 → 2.6 → 2.8 → 2.9 → 2.12。M1 完全可以塞进 M0 审核等待期。Stripe 主体办理若在大陆可能耗时数周，必须 T0 启动。

## 4. 风险登记

| 风险 | 影响 | 概率 | 对策 | 责任阶段 |
|---|---|---|---|---|
| 目标市场决策晚定或改为大陆 | 后端全部重选 | 中 | 决策门 1 在 M1 前定；M0/M1 不受影响 | 开工前 |
| 商店审核因 `<all_urls>` 内容脚本反复被拒 | 上线延迟数周 | 中 | 权限理由具体；预备"仅在点击图标后注入"的降级方案（改用 `activeTab` + `scripting.executeScript`，牺牲 hover 手柄的即时性） | M0 |
| 免费额度被薅 | 成本失控 | 中 | 每日小额发放、单用户熔断、全局预算、厂商侧硬预算 | M2 |
| TTS 成本远超预期 | 亏损 | 中 | 单独限额；免费档更低；R2 缓存；必要时 `FEATURE_FLAGS` 关闭 | M2 |
| 厂商改 API / 涨价 | 功能中断或成本变化 | 中 | AI Gateway fallback；模型 ID 走环境变量不发版 | M2 起 |
| DO 与 ledger 漂移 | 用户额度错误 | 低 | 对账 Cron；以 DO 为准修正 | M2 |
| refresh 轮换误杀（多设备 / 并发） | 用户被登出 | 中 | 单飞刷新 + session 锁；旧 token 24 小时宽限期内重放只撤销当前而非 family（可作为放宽选项） | M2 |
| Stripe 主体办不下来 | 无法收费 | 低–中 | T0 启动；备选 Paddle / Lemon Squeezy（Merchant of Record，但费率高、与本方案 webhook 差异大） | M3 |
| 单人项目 bus factor | 停摆 | — | 所有流程文档化；secrets 与账号在密码管理器 | 全程 |
| 多语言 UI 新增字符串 ×18 | 拖慢每个功能 | 高 | 账号 / 计费 UI 先做 en / zh-CN / zh-TW / ja，其余回落英文 | M2 起 |

## 5. 每阶段完成定义（Definition of Done）

- 代码合并 main，CI 绿。
- 本阶段文档里的验收标准逐条勾选。
- `CLAUDE.md` 更新到当前架构；`CHROMEWEBSTORE.md` 与商店后台一致。
- 隐私政策与披露表与代码行为一致。
- 有一条"如何回滚"的记录（扩展：切 `apiMode`；服务端：`wrangler rollback`）。

## 6. 接下来两周（T0 = 本周）

**本周**

1. 注册 Chrome 开发者账号、准备支持邮箱；若在大陆，启动 Stripe 主体办理；买域名。
2. 回答决策门 1（目标市场）与 3（域名）。
3. 做 0.2、0.3、0.4、0.7（manifest、动态权限、固定 ID、打包脚本）。
4. 做 0.6（隐私政策、README、落地页修正）。

**下周**

5. 做 0.5（引导页）和 0.8（素材、`CHROMEWEBSTORE.md`）。
6. Unlisted 提交（0.9），进入审核等待。
7. 开始 M1：1.1 → 1.2（错误码），1.3（api.js 拆分）。
