# 01 · 阶段 0：以 BYO key 形态上架 Chrome 商店

## 目标

把现在的扩展原样（用户自带 API key）提交到 Chrome Web Store 并通过审核。不引入账号、后端、收费。这一步把"能不能过审"和"能不能做成 SaaS"两个风险解耦，并开始积累真实用户与反馈。

**验收标准**

- 商店页面公开可访问，任何人可安装。
- 安装后打开引导页，三步内完成首次标注。
- 隐私政策、README、落地页描述与代码行为一致。
- 权限警告只剩"读取和更改您访问的网站上的所有数据"（内容脚本 `<all_urls>` 不可避免），不再出现自定义 base URL 之外的广域网络权限。
- 有可重复执行的打包脚本，产物不含开发文件。

## 1. 代码改动清单

### 1.1 `manifest.json`

```jsonc
{
  "manifest_version": 3,
  "key": "<固定开发期 ID 的公钥，见 §1.2>",
  "version": "1.1.0",
  "minimum_chrome_version": "116",
  "permissions": ["storage", "unlimitedStorage", "activeTab"],
  "host_permissions": [
    "https://api.openai.com/*",
    "https://api.anthropic.com/*",
    "https://generativelanguage.googleapis.com/*",
    "https://api.elevenlabs.io/*"
  ],
  "optional_host_permissions": ["https://*/*", "http://*/*"]
}
```

改动要点：

- 去掉常驻的 `https://*/*` 和 `http://*/*`，挪进 `optional_host_permissions`，只在用户填写自定义 base URL 时动态申请。四家厂商域名显式列出（当前 manifest 只列了 OpenAI，Anthropic / Google / ElevenLabs 靠广域权限兜底，这正是审核红旗）。
- `minimum_chrome_version` 设 116：`chrome.permissions.request` 与 `chrome.identity` 的 Promise 形式从这个版本起稳定，后面阶段要用。
- `description` 用 `__MSG_extensionDescription__`，需检查每个 locale 的该字段不超过 132 字符。
- `version` 从 1.0.0 升到 1.1.0，商店拒绝小于等于已发布版本的上传，之后每次提交都要升。

### 1.2 固定扩展 ID（`key` 字段）

`chrome.identity.launchWebAuthFlow` 的回调地址包含扩展 ID，OAuth 客户端也绑定扩展 ID。现在就固定，避免阶段 1 时 ID 变化。

步骤：`chrome://extensions` → 打包扩展 → 生成 `.pem` 与 `.crx` → 从 `.crx` 里的 manifest 取 `key` 字段写进开发期 `manifest.json`。`.pem` 私钥加入 `.gitignore`，另行保管。

商店会忽略 manifest 里的 `key` 并自行分配 ID。要让商店 ID 与开发期 ID 一致，官方做法是**首次上传的 zip 根目录放入 `key.pem`**（之后的上传不再需要）。这样只有一个 ID，阶段 1 的 OAuth 与 CORS 白名单都只登记一个。打包脚本默认排除 `*.pem`，首次上传时手动加入。实施前核对当时的 manifest `key` 文档，这条规则近年有过变化。

### 1.3 自定义 base URL 的动态权限（`options/options.js`）

用户在设置页填写 `openaiBaseUrl` 并点保存时，在保存按钮的 click 处理器里**第一件事**调用 `chrome.permissions.request`，任何 `await` 之前，否则用户手势失效会抛错。

```js
// options/options.js — saveBtn click handler 开头
const baseUrl = document.getElementById("openaiBaseUrl").value.trim();
const origin = baseUrl ? new URL(baseUrl).origin + "/*" : null;
const needsGrant = origin && !origin.startsWith("https://api.openai.com");
const granted = needsGrant
  ? await chrome.permissions.request({ origins: [origin] })   // 必须是第一个 await
  : true;
if (!granted) { showStatus(t("baseUrlPermissionDenied")); return; }
// ...之后再做 storage 写入
```

配套改动：

- 清空 base URL 时调用 `chrome.permissions.remove` 释放权限。
- `lib/api.js` 的 `getBaseUrl()` 之后加一道 `chrome.permissions.contains` 检查，缺权限时抛出带说明的错误（阶段 0.5 之后变成错误码 `HOST_PERMISSION_MISSING`），提示用户回设置页重新保存。
- 设置页在 base URL 输入框下加一行说明："填写第三方地址会请求访问该域名的权限"。
- 新增 i18n key：`baseUrlPermissionDenied`、`baseUrlPermissionHint`。

### 1.4 首次使用引导（`onboarding/`）

现有交互（选中出工具栏、hover 段落出手柄）没有任何提示，新用户装完会不知所措。最小实现：

- `chrome.runtime.onInstalled` 且 `reason === "install"` 时打开 `onboarding/welcome.html`。
- 页面三段：① 填 API key（内嵌与设置页相同的输入，或一个"去设置"按钮）；② 一段可交互的日文示例，让用户就在这个页面里选中文字试工具栏；③ 阅读器入口说明。
- 页面本身是扩展页，可以直接加载 `content/content.css` 和 `lib/shared.js` 复用工具栏样式，但内容脚本只注入普通网页，引导页需要显式 `<script src="../content/content.js">` 引入（它是 IIFE，检查它对扩展页 URL 不会因黑名单逻辑退出）。
- 已有的 `docs/` 落地页已经有各语言的功能介绍，引导页文案可直接复用 `_locales` 的现有 key，新增 key 控制在 10 个以内。

`onInstalled` 处理放在 `background/service-worker.js` 顶层注册（SW 会被回收，监听器必须在顶层同步注册）。

### 1.5 文档与代码不一致处（必须修）

| 位置 | 问题 | 修法 |
|---|---|---|
| `docs/privacy.html` "Data Sent to Third Parties" | 缺 ElevenLabs（`lib/models.js` 与 `options/options.html` 都有） | 加一条 `api.elevenlabs.io` 用于 TTS |
| `docs/privacy.html` "Chrome Built-in AI" 一节 | 功能已不存在，声称一个不存在的隐私特性比漏写更严重 | 整节删除 |
| `docs/privacy.html` "Reader Content" | 写的是"一次性传递给阅读器标签页"，实际是持久化会话（LRU 30） | 改为"阅读会话本地持久保存，可在阅读器里删除" |
| `docs/privacy.html` "Permissions" | host permissions 描述笼统 | 按 §1.1 逐条列出，并说明自定义 base URL 走动态申请 |
| `docs/privacy.html` 自定义 base URL | 未说明数据会发往用户填写的第三方主机 | 加一句 |
| `docs/privacy.html` `chrome.storage.sync` | 只说了"加密"，未说明数据经 Google 服务器同步 | 明确写出 |
| `README.md` "Local translation" 功能条 与 Providers 表的 "Chrome Built-in AI" 行 | 功能已删除 | 删除 |
| `README.md` Usage "Alt+Click" | 交互已改为选区工具栏 + 段落手柄 | 按 `CLAUDE.md` "核心交互" 重写 |
| `README.md` Configuration "Translation engine — Cloud or Local" | 同上 | 删除 |
| `docs/index.html` 及各语言页 Features "Alt+Click" | 同上 | 重写文案（18 个语言页，机械替换即可） |
| `CLAUDE.md` "lib/models.js — 静态模型定义与定价" | 定价表在提交 `fc9c600` 已删除 | 去掉"与定价"三字；阶段 1 定价源在服务端重建 |

隐私政策改完更新 "Last updated" 日期。

### 1.6 `.gitignore`

追加 `*.pem`、`*.zip`、`dist/`。

## 2. 商店素材

全部素材、理由与披露内容写入根目录 `CHROMEWEBSTORE.md`（打包时排除），作为每次提交的唯一来源。

### 2.1 单一用途声明

一句话，功能不罗列：

> Yomeru helps Japanese learners read Japanese web pages by adding furigana, translations, grammar notes, and read-aloud to the text they select.

振假名、翻译、语法、朗读、测验、词汇本都是"读懂日文网页"这一件事的组成部分。描述里不要把它们写成六个并列产品。

### 2.2 权限理由（逐条，大白话）

| 权限 | 理由文案（英文提交） |
|---|---|
| `storage` | Saves your API keys, language preference, model choices, collected vocabulary, and reading sessions in your browser. |
| `unlimitedStorage` | Reading sessions keep the full text, readings and translations of articles you open so you do not pay to regenerate them; long articles exceed the default 10 MB quota. |
| `activeTab` | When you click the toolbar icon, the popup reads the current page to extract the article for Reader Mode or full-page translation. |
| `host_permissions` 四家厂商 | Sends the text you select to the AI provider you configured with your own API key, and nowhere else. |
| `optional_host_permissions` 广域 | Requested only if you enter a custom OpenAI-compatible base URL (for example a self-hosted or third-party endpoint); the permission is limited to that host. |
| 内容脚本 `<all_urls>` | The extension must run on any page containing Japanese text so the selection toolbar and paragraph handles are available wherever you read. It does nothing until you select text or hover a paragraph. |

### 2.3 数据使用披露表（Developer Dashboard 的勾选项）

阶段 0 的正确勾选：

- 收集的数据类型：**Website content**（用户选中/提取的文本，发送给用户自己配置的 AI 厂商）。其余（个人身份、认证信息、位置、活动等）**不勾**。
- 三项认证：不出售数据；不用于与核心功能无关的用途；不用于信用评估或放贷。全部勾选"是"。
- 不使用远程代码。

注意 `chrome.storage.sync` 会把 API key 同步到 Google 服务器，隐私政策里要写，但披露表里这不算开发者收集数据。

### 2.4 商店文案

- 名称：`読める Yomeru`（与 manifest `name` 完全一致，各 locale 的 `extensionName` 已定义）。
- 短描述 ≤ 132 字符。
- 详细描述：写用户收益，禁止出现 service worker、chrome.storage、Manifest V3 之类实现词。结构建议：一句定位 → 三个使用场景（网页上选中一段、阅读器读全文、朗读与测验）→ "使用你自己的 API key，文本只发给你选择的厂商" → 支持的语言列表。
- 商店支持 18 个语言的 listing，本地化描述可以从 `docs/*.html` 的功能介绍抽取，首版先做 en / zh-CN / zh-TW / ja，其他语言用英文。

### 2.5 图片

| 素材 | 规格 | 内容 |
|---|---|---|
| 商店图标 | 128×128 PNG | 现有 `icons/icon128.png`，检查边距（商店建议 96×96 可视区加 16px 留白） |
| 截图 ×4–5 | 1280×800 | ① 网页上选中一段出现工具栏与结果卡片；② 段落手柄展开菜单；③ 阅读器全文标注 + 译文；④ 阅读器朗读播放条；⑤ 词汇本或测验 |
| 小宣传图 | 440×280 | 品牌字「読める」+ 一行 ruby 示例 |
| 宣传大图（可选） | 1400×560 | 同上横版 |

截图用真实页面（例如 NHK News Web Easy 或青空文库），不要用手机样机，不要加与功能无关的营销文字。

### 2.6 其他登记项

- 支持邮箱：一个有人看的地址，Google 的政策通知与下架通知发到这里。
- 隐私政策 URL：`https://nicekana.github.io/kana-master/privacy.html`（M2 换域名后同步更新商店登记）。
- 开发者账号 $5 注册费，新账号需要身份验证，提前几天办。
- 类别：Education 或 Productivity，选 Education。

## 3. 打包与发布

### 3.1 打包脚本 `scripts/package.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./manifest.json').version")
OUT="dist/yomeru-v${VERSION}.zip"
mkdir -p dist && rm -f "$OUT"
zip -r "$OUT" . \
  -x ".git/*" ".github/*" ".claude/*" ".agents/*" "node_modules/*" \
     "test/*" "docs/*" "plan/*" "scripts/*" "dist/*" "server/*" \
     "CLAUDE.md" "PRODUCTIZATION.md" "README.md" "CHROMEWEBSTORE.md" \
     "skills-lock.json" ".gitignore" "*.pem" ".DS_Store" "*/.DS_Store"
echo "packaged $OUT ($(du -h "$OUT" | cut -f1))"
unzip -l "$OUT" | grep -E "manifest.json|service-worker.js|content.js" >/dev/null
```

脚本末尾解压校验关键文件存在。打包前跑一遍 `node test/*.test.mjs`。

### 3.2 `CHROMEWEBSTORE.md` 结构

按 `.claude/skills/chrome-extensions/references/webstore/chromewebstore-template.md` 生成，包含：listing 文案（各语言）、单一用途、权限理由、数据披露答案、隐私政策 URL、截图清单、版本历史、审核员备注。之后每次动 manifest 权限或数据行为都要同步更新。

### 3.3 发布顺序

1. 先以 **Unlisted** 可见性提交，通过审核后自己安装商店版本回归一遍（商店版 ID 与开发版不同，检查 `chrome.runtime.getURL` 相关逻辑无硬编码）。
2. 邀请 5–10 个日语学习者做一周内测（Unlisted 链接可直接分享），收集引导页与首次使用的反馈。
3. 切 **Public**。

审核周期通常 1–3 个工作日，含 `<all_urls>` 内容脚本可能拉长到一周以上，排期时按异步等待处理，期间开始阶段 0.5。

## 4. 审核风险与预案

| 风险 | 可能性 | 预案 |
|---|---|---|
| 因内容脚本 `<all_urls>` 被要求说明 | 高 | 权限理由已写明"只在用户选中或 hover 时动作"；必要时在审核回复里附上截图说明触发方式 |
| "自定义 base URL" 被视为把扩展当通用代理 | 中 | 理由里强调仅限 OpenAI 兼容端点、用户自愿、动态申请；若仍被拒，退一步改为只允许 https 且提示风险 |
| 数据披露与隐私政策不一致 | 中 | §1.5 修完后逐条对照披露表复核 |
| 单一用途被判功能大杂烩 | 低 | 描述按 §2.1 收敛，不用"all-in-one" 之类词 |
| 截图含第三方站点内容版权 | 低 | 用 NHK Easy 或青空文库公有领域文本 |

## 5. 排期

| 任务 | 天 |
|---|---|
| manifest 收窄 + 动态权限 + 权限检查 | 1 |
| 固定 key、`.gitignore`、打包脚本、CI 打包 | 0.5 |
| 引导页 | 1–1.5 |
| 隐私政策 / README / 落地页 / CLAUDE.md 修正 | 0.5–1 |
| CHROMEWEBSTORE.md + 文案 + 截图 + 宣传图 | 1–1.5 |
| 提交、回归商店版本、内测 | 0.5 + 等待 |

合计 4–6 个工作日，不含审核等待。
