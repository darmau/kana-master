# 05 · 额度引擎与计费

额度引擎（§1–§5、§7）属于 M2（与账号一起上，只发免费额度）；Stripe（§6、§8）属于 M3。

## 1. 计量单位与成本模型

### 1.1 内部单位

内部一律用整数 **credits**：`1 credit = 上游成本 US$0.0001`（10,000 credits = $1）。选这个粒度是因为一次 flash 档翻译的成本在 $0.0003 上下，需要能表示到个位。所有折算在服务端完成（`llm/pricing.ts`），客户端只收到 credits 与余额。

对用户展示时换算成人话："今日剩余约 N 段" / "本月还能朗读约 M 分钟"，按该用户近 7 天各功能平均单价折算。UI 永远不显示 token。

### 1.2 单次操作成本估算

以 150 字的日文段落（约 180 tokens）为基准。价格是**示意假设**，实施时用厂商当时价目替换；`lib/models.js` 原有的定价表在提交 `fc9c600` 已删除，新的定价源在 `server/src/llm/pricing.ts` 重建。

| 操作 | 输入 tokens | 输出 tokens | flash 档（假设 $0.10 / $0.40 每 M） | 中档（假设 $3 / $15 每 M） |
|---|---|---|---|---|
| annotate | 700（prompt）+ 180 | ~500（JSON） | $0.00029 | $0.010 |
| translate | 60 + 180 | ~150 | $0.00008 | $0.003 |
| grammar | 250 + 180 | ~400 | $0.00020 | $0.007 |
| quiz（4000 字全文） | 400 + 4000 | ~800 | $0.00076 | $0.024 |
| vocab | 500 + 30 | ~200 | $0.00013 | $0.005 |
| tts（150 字符） | — | — | 按字符：$15 / M 字符 → **$0.00225** | — |

结论：

1. 文本功能用 flash 档时一篇 30 段文章"标注 + 翻译"约 $0.011，非常便宜；换成中档模型贵 30 倍。托管模式默认 flash 档，中档留给付费档位或单独的"高质量"开关。
2. **TTS 是成本大头**：一篇 30 段文章朗读约 $0.07，是同一篇文章文本处理的 6 倍。TTS 必须单独限额、强缓存、并在免费档位收紧。
3. 阶段 M2 上线时前两周的实测数据（每活跃用户每日 credits、TTS 占比、缓存命中率）决定 M3 的定价，本文的数字只用于设定初始敞口。

### 1.3 初始档位（示意，M3 前校准）

| 档位 | 价格 | 额度 | 说明 |
|---|---|---|---|
| Free | $0 | 每日发放 200 credits（$0.02），未用部分累积上限 600 | flash 档约 50 段标注 + 翻译，或约 9 段（约 5 分钟）朗读；靠每日发放而不是注册赠送，脚本批量注册无利可图 |
| Pro | $7.99 / 月 | 每月 50,000 credits（$5 上游成本上限），周期内不累积 | 正常用户月耗远低于上限，毛利来自未用完部分 |
| 加油包 | $4.99 | 30,000 credits，12 个月有效，先扣订阅额度再扣加油包 | 给重度用户与不想订阅的用户 |
| BYO key | $0 | 无限制 | 不经我们服务器 |

单用户日熔断：Free 600 credits（等于累积上限，即一天最多花光累积量），Pro 5,000 credits，超过后当日拒绝并告警。全局日预算 `GLOBAL_DAILY_BUDGET_USD` 初始 $15，超过后所有托管请求返回 `QUOTA_EXHAUSTED`（文案"今日服务繁忙"），BYO 不受影响。

## 2. Durable Object 余额引擎

设计见 `03` §5.2。这里说明生命周期与关键决策。

### 2.1 预扣 → 结算

```
reserve(requestId, estimate)
   估算：annotate = chars×3 + 700 → tokens → credits；translate = chars×1.2 + 60；tts = chars
   估算故意偏高 30%，宁可多 hold 少扣
settle(requestId, actual)
   actual 来自厂商 usage；流中断时 actual = 已发送字节估算（输出 chars / 1.5 + 输入估算）
release(requestId)
   上游 4xx/5xx、客户端 abort 且未收到任何 chunk → 全额释放
```

hold 只是余额的"预留"不是扣减，`available = balance − Σholds`。同一用户并发 5 个请求（reader 翻译 3 + TTS 2）时每个都要过 `available ≥ estimate`，余额 1 块钱的账号无法并发打穿。

### 2.2 每日发放的惰性实现

不用 Cron 给每个用户发额度（用户量大后 Cron 会扫全表）。`reserve()` 开头：

```ts
const today = utcDay();
if (state.last_grant_day !== today) {
  const days = Math.min(daysBetween(state.last_grant_day, today), 3);   // 最多补发 3 天
  balance = Math.min(balance + DAILY_GRANT * days, DAILY_CAP + planCredits);
  state.last_grant_day = today;
  // 发放写 D1 ledger 由 waitUntil 异步追加（kind=daily_grant, ref=day），失败不阻塞请求，Cron 对账兜底
}
```

### 2.3 hold 过期

客户端崩溃、SW 被回收、网络断开都可能让 `settle` 永远不来。`alarm()` 每 5 分钟把超过 10 分钟的 hold 按估算值结算（不是释放：请求大概率已经打到上游产生了成本）。10 分钟远大于最长请求（TTS 60s 超时）。

### 2.4 熔断状态

`daily.spent` 超过 `USER_DAILY_BREAKER` → `state.breaker_tripped_at = now`，之后 `reserve` 直接拒绝（`QUOTA_EXHAUSTED`，附 `reason: "daily_limit"`），次日自动复位。触发时 `waitUntil` 发一封告警邮件（`06` §1）。

## 3. 计量细节

| 来源 | 提取方式 | 兜底 |
|---|---|---|
| OpenAI 非流式 | `usage.prompt_tokens / completion_tokens` | — |
| OpenAI 流式 | `stream_options.include_usage`，最后一个 chunk `usage` | 按输出字符估算 |
| Anthropic | `message_start` 的 `input_tokens`，`message_delta` 的 `output_tokens` | 同上 |
| Google | 最后一个 chunk 的 `usageMetadata.promptTokenCount / candidatesTokenCount` | 同上 |
| OpenAI TTS | 请求字符数（厂商按字符计价） | — |
| Google TTS | 同上 | — |
| 缓存命中 | credits = 0，`cached = 1` 记入 usage | — |

`pricing.ts` 单价表以模型 ID 为键，含 `inputPerM`、`outputPerM`、`ttsPerMChars`、`markup`（默认 1.0，credits 反映真实成本，利润体现在档位定价而非单价加成，这样成本数据干净）。

## 4. 幂等、重试、取消

- `X-Request-Id` 是幂等键。DO `reserve` 对同一 ID 只建一个 hold；非流式响应在 KV `idem:` 存 24 小时，重试直接返回。客户端 `fetchWithRetry` 重试 3 次沿用同一 ID，不会重复扣费。
- 取消：客户端 abort → Worker 侧 `request.signal` 触发 → 中止上游 fetch → `settle` 按已发送量或 `release`。reader 的 seek 取消远处 TTS 是高频路径，这条必须有测试覆盖（vitest 里用 `AbortController` 模拟）。
- 流中途余额耗尽不会发生（预扣已覆盖整段），只在下一段 `reserve` 失败。reader 收到某块 `QUOTA_EXHAUSTED` 后应停止派发后续块（现有 `worker()` 循环加判断），已完成的块保留，剩余块进 error 态显示"额度不足 + 查看额度"。

## 5. 额度可见性

- popup 常驻：今日剩余（Free）或本月剩余（Pro）进度条 + "约 N 段"。数据来自 `chrome.storage.local.balance`，每次网关响应更新，popup 打开时再 `fetchMe()` 校正。
- 每次消费在 reader 状态栏短暂显示"−9"（可关）。付费用户对"钱花哪了"敏感，透明度是留存因素。
- account 页：近 30 天按功能的堆叠柱状图 + 本周期消费 + 缓存为你省下的 credits（正向反馈）。

## 6. Stripe（M3）

### 6.1 对象

| Stripe 对象 | 配置 |
|---|---|
| Product "Rubify Pro" | recurring Price 月付（先只做月付，年付 M4） |
| Product "Rubify Credit Pack" | one-time Price |
| Customer | `users.stripe_customer_id`，首次结账时创建，`metadata.userId` |
| Checkout Session | mode = subscription / payment；`client_reference_id = userId`；`success_url = https://rubify.app/billing/success?session_id={CHECKOUT_SESSION_ID}`；`automatic_tax.enabled = true` |
| Customer Portal | 取消 / 换卡 / 发票；扩展 account 页"管理订阅"按钮 → `POST /billing/portal` → 打开新标签页 |
| Webhook | 端点 `/webhooks/stripe`，事件见下 |

### 6.2 Webhook 处理

```
checkout.session.completed        → 加油包：ledger(topup, ref=session.id) + DO.grant；订阅：记 customer id
customer.subscription.created/updated → upsert subscriptions；users.plan/plan_status/period_end；DO.setPlan
invoice.paid                      → ledger(plan_grant, ref=invoice.id) + DO.grant(周期额度)；周期额度先清零再发（不累积）
invoice.payment_failed            → plan_status=past_due；DO 保留余额但停止 plan_grant；邮件提醒（M4）
customer.subscription.deleted     → plan=free；DO.setPlan(free)
```

每个 handler 开头 `INSERT INTO stripe_events(id) ON CONFLICT DO NOTHING`，受影响行数为 0 则直接 200 返回。验签用 `stripe.webhooks.constructEventAsync(rawBody, sig, secret)`，Hono 里用 `c.req.text()` 取 raw body。所有 ledger 写入以 Stripe 对象 ID 为 `ref`，`UNIQUE(user_id, kind, ref)` 保证重放安全。

### 6.3 税务与退款

- Stripe Tax 自动处理 VAT / 销售税，Checkout 收集账单地址。
- 退款政策：订阅 7 天内未使用超过 10% 额度可全额退；加油包未使用可退。退款通过 Stripe Dashboard 操作，`charge.refunded` webhook → ledger(refund) + DO 扣回（可为负，负余额禁止托管请求直至清零）。
- 发票由 Stripe 自动发送。

### 6.4 扩展侧

`account/` 页加"升级到 Pro"与"购买加油包"按钮 → `POST /billing/checkout` → `chrome.tabs.create(url)`。Checkout 完成后 Stripe 回跳 web 成功页，页面提示"回到扩展即可"；扩展通过 `/v1/me` 轮询（成功页打开期间每 3 秒，最多 1 分钟）或下次请求的 balance 回写拿到新额度。

## 7. 账本与对账

- **ledger（D1）** 是财务真相：发放、充值、退款、快照。每用户每月几行到几十行。
- **usage（Analytics Engine → usage_daily）** 是分析真相：每次调用的 token 与成本。
- **DO** 是运行时真相：当前可用余额。

每日 Cron `reconcile.ts`：对过去 24 小时有活动的用户（Analytics Engine 查得），`expected = Σ ledger.credits − Σ usage_daily.credits`，与 `DO.snapshot().balance` 比较，差异超过 50 credits 记入 `reconcile_drift` 表并告警；每周对全量用户跑一次。发现漂移**以 DO 为准修正 ledger**（插入 `adjust` 行），因为 DO 的每次变更都是事务性的，漂移几乎总来自 ledger 异步追加失败。

每日同时把 DO 余额写一行 `snapshot` 到 ledger，作为 D1 时间旅行之外的第二份快照。

## 8. 验收标准

M2（额度引擎）：

- 并发 10 个请求、余额只够 3 个时，恰好 3 个成功，其余 402，无超扣（vitest 测试）。
- 取消在途 TTS 后 hold 被释放；客户端不结算时 10 分钟内被 alarm 结算。
- 同一 `X-Request-Id` 重放 3 次只扣一次。
- 每日发放跨日生效，累积不超上限。
- 单用户熔断与全局日预算触发后请求被拒且收到告警邮件。

M3（Stripe）：

- test mode 下走通订阅、续费（用 Stripe test clock 推进周期）、取消、加油包、退款五条路径，ledger 与 DO 一致。
- webhook 重放 3 次不重复入账。
- 对账 Cron 在人为制造漂移后能检出并修正。
