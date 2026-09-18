<p align="right">
  <img alt="简体中文" src="https://img.shields.io/badge/%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-current-2ea44f?style=flat-square">
  <a href="README_EN.md"><img alt="English" src="https://img.shields.io/badge/English-switch-0366d6?style=flat-square"></a>
</p>

# FeedSieve（自托管精简版）

> 可见优先，拉黑唯一。在 x.com 用黄框标注疑似垃圾账号，经页面自身原生接口拉黑，**永不隐藏内容**。

本仓库包含 FeedSieve 的**两个部分**，可单独使用，也可配合使用：

| 组件 | 文件 | 说明 |
| --- | --- | --- |
| 🐒 **油猴脚本**（前端） | `feedsieve.user.js` | 装进浏览器，在 x.com 上做本地检测、黄框标注、一键拉黑。**自带离线数据，开箱即用。** |
| ☁️ **社区 API**（后端，可选） | `src/` + `wrangler.toml` | 基于 Cloudflare Workers + Hono 的**只读**后端，用来同步社区黑名单与公开关键词词库。 |

它面向「一个人自用」的场景：后端**只保留读接口**，去掉了原版的管理员后台、举报/抢救/贡献统计、D1 数据库和定时快照生成。
名单与词库都是仓库里预审过的**静态产物**，一次性上传到 R2 即可，没有建库、迁移、填 ID、设密钥这些步骤。

> **关于默认 API 地址**：油猴脚本默认指向原作者的官方社区 API `https://feedsieve-api.chendahuang.com`（原项目仓库已 404，该 API 已停服）。
> 该官方 API 目前**已停止服务**。不过**这不影响脚本使用** —— 脚本内置了完整的离线数据兜底（详见
> [离线兜底与数据来源](#离线兜底与数据来源)）。若你想独立同步最新名单/词库，请按
> [自托管后端](#自托管后端详细步骤) 自建，再按 [让脚本用你的 API](#让脚本用你的-api) 接入。

---

## 致谢

本项目是 FeedSieve 的「自托管精简版」，基于 [chendahuang/feedsieve](https://github.com/realchendahuang/feedsieve)（原仓库已 404）的原始项目改造而来：移除 D1 / 管理后台 / 举报贡献 / 密钥等仅多人协作才需要的部分，将整个后端改造为只读、单一 R2 的轻量形态。

感谢原作者 **chendahuang** 设计的原始架构与社区方案。

---

## 目录

- [它是怎么工作的](#它是怎么工作的)
- [功能特性](#功能特性)
- [快速开始：安装油猴脚本](#快速开始安装油猴脚本)
- [离线兜底与数据来源](#离线兜底与数据来源)
- [隐私说明](#隐私说明)
- [自托管后端（详细步骤）](#自托管后端详细步骤)
- [让脚本用你的 API](#让脚本用你的-api)
- [API 端点](#api-端点)
- [数据格式与更新](#数据格式与更新)
- [本地开发](#本地开发)
- [项目结构](#项目结构)
- [常见问题](#常见问题)
- [许可证](#许可证)

---

## 它是怎么工作的

```
┌──────────────────────────── x.com 页面 ────────────────────────────┐
│  油猴脚本 feedsieve.user.js                                        │
│   ├─ 本地检测（内置启发式 + 内置/同步来的关键词词库）              │
│   ├─ 黄框标注（outline，不占布局、不隐藏任何内容）                 │
│   └─ 用户点击「拉黑」→ 调用 x.com 页面自身的原生拉黑接口           │
└───────────────────────────────┬────────────────────────────────────┘
                                │ 仅 GET 只读同步（可选）
                                ▼
┌──────────────── Cloudflare Worker（可选自托管）────────────────────┐
│  GET /v1/snapshots/...      社区黑名单快照                         │
│  GET /v1/keyword-packs/...  公开关键词词库                         │
│  数据来自 R2 bucket「feedsieve-data」（静态文件）                  │
└────────────────────────────────────────────────────────────────────┘
```

要点：

1. **检测在本地做**。脚本拿账号的昵称 / handle / 正文 / 简介，匹配内置启发式与关键词词库。
2. **标注 ≠ 隐藏**。命中只画一圈黄色 `outline`，内容照常显示，用户永远掌握最终决定权。
3. **拉黑由用户触发**，走 x.com 页面自身的原生接口（脚本里唯一的 POST，目标是 x.com，不是社区 API）。
4. **社区 API 只是可选的「增量数据源」**。连不上时，脚本回退到内置数据，功能不中断。

---

## 功能特性

### 油猴脚本

- **黄框标注，永不隐藏**：用 `outline` 圈出疑似垃圾账号，不挤压 X 布局、不遮蔽任何推文。
- **三种标注强度**：
  - `清爽`（refresh）
  - `标准`（standard，默认）
  - `大扫除`（deep_clean，额外启用指纹 / 域名等更激进的检测）
- **内置启发式规则**：
  - `default-name-digits`：默认名 + 长数字尾巴，疑似批量注册
  - `spam-link-hint`：正文含可疑外链
  - `templated-text`：模板化刷屏文案
  - `porn-bait-zh`：中文色情引流话术
- **关键词词库**：8 大类、778 条规则，可在面板逐类订阅，也支持**自定义关键词**（上限 80 条，纯本地）。
- **分类标签**：机器人 / 重复刷屏 / 广告号 / 色情引流 / 诈骗 / 互动钓鱼 / 其他……
- **一键拉黑本页**：把当前页面所有黄框账号批量拉黑。
- **误标纠正**：对某个账号点「误标？」加入个人白名单，之后不再标注。
- **控制面板**：显示快照版本、上次同步时间、本页黄框数、白名单数、已拉黑记账；带可拖动悬浮入口（FAB）。
- **菜单命令**（Tampermonkey 菜单）：
  - FeedSieve：打开面板
  - FeedSieve：立即同步名单与词库
  - FeedSieve：一键拉黑本页黄框

### 社区 API（后端）

- **只读**：全部为 `GET`，无任何写接口。
- **单一 R2 bucket**：`snapshots/`（黑名单）与 `keyword-packs/`（词库）共用一个 bucket。
- **无需数据库 / 密钥 / 定时任务**。
- **CORS 全开**，便于任意前端消费。
- **缓存友好**：manifest 短缓存（300s），版本化文件按不可变缓存（1 年）。
- **公开政策**：`/v1/policy` 暴露阈值，不藏黑箱。

---

## 快速开始：安装油猴脚本

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)（或 Violentmonkey）。
2. 打开 `feedsieve.user.js`，Tampermonkey 会弹出安装页，点击安装。
3. 打开 [x.com](https://x.com/)，右下角会出现 FeedSieve 悬浮入口，点击展开面板。
4. 默认即可工作（用内置数据）。如要同步你自己的后端，见 [让脚本用你的 API](#让脚本用你的-api)。

> 脚本 `@match` 覆盖 `https://x.com/*` 与 `https://twitter.com/*`，`@run-at document-start`。

---

## 离线兜底与数据来源

**这是本项目的关键设计：脚本即使完全连不上任何 API，也能正常工作。**

脚本内置了两份完整的离线数据：

| 数据 | 脚本内嵌常量 | 内容 |
| --- | --- | --- |
| 社区黑名单 | `BUNDLED_SNAPSHOT` | 快照 `2026.09.02.1`，6 条条目 |
| 关键词词库 | `BUNDLED_KEYWORD_PACK_CATALOG` | 词库 `2026.09.02.5`，8 包 / 778 条规则 |

回退逻辑（源码要点）：

- 黑名单：`getCommunitySnapshot()` → `getStoredCommunitySnapshot() ?? BUNDLED_SNAPSHOT`
- 词库：`getKeywordPackCatalog()` → 无本地缓存时 `return BUNDLED_KEYWORD_PACK_CATALOG`
- 同步函数全程 `try/catch`，失败只返回 `{status:"error"}`，不抛异常；启动流程外层还有 `.catch(()=>{})` 兜底

因此，当官方 API 不可用时：**检测、标注、拉黑全部照常**，只是无法同步「更新的」名单/词库。
面板里可能出现「同步失败」提示，属于预期现象，**不影响核心功能**。

> ⚠️ **注意默认订阅范围**：脚本默认只订阅 `adult_gray_traffic`（黄推 / 成人引流，629 条）一个词库包。
> 其余 7 包（共 149 条）默认**不生效**，需要你在面板里手动勾选订阅（勾选是纯本地操作，不依赖 API）。

---

## 隐私说明

- **自定义关键词只存本地**：保存在 Tampermonkey 的 `GM_setValue` 或浏览器 `localStorage`（key 前缀 `feedsieve:`），
  **不会上传到任何服务器**。别人的关键词你既看不到，你的关键词也不会外泄。
- **对社区 API 只有只读请求**：脚本对社区 API 只发 `GET`（名单 manifest / 快照、词库 manifest / 正文）。
- **无上报 / 无贡献**：本精简版脚本不会向任何后端上传数据；后端本身也没有任何写接口。
- **拉黑动作**发生在 x.com 页面内，通过页面原生接口完成，与社区 API 无关。

> 换言之：使用他人提供的社区 API，只会消耗该 API 的**读取请求配额**，不会写入或污染其数据。

---

## 自托管后端（详细步骤）

### 前置条件

- 一个 **GitHub 仓库**（把本文件夹推上去，供一键部署使用）
- 一个 **Cloudflare 账号**（免费版足够）
- 本地有 **Node.js**（仅当用脚本上传数据时需要；用 R2 面板拖拽则不需要）

### 1. 推到 GitHub

```sh
cd feedsieve-community-api
git init
git add -A
git commit -m "feedsieve community api (self-hosted)"
git remote add origin https://github.com/<你的用户名>/feedsieve-community-api.git
git push -u origin main
```

### 2. 在 Cloudflare 建一个 R2 bucket

Dashboard → **R2** → **Create bucket** → 名称填 **`feedsieve-data`**。

> ⚠️ **名字必须完全一致**：`wrangler.toml` 里按 **名字** 引用 bucket（`bucket_name = "feedsieve-data"`），
> 名字对了，部署时无需填任何 `database_id`。免费额度足够个人使用。

### 3. 部署 Worker

**方式 A：一键部署按钮**（或 Dashboard 手动导入 Git 仓库）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?repository-url=https://github.com/YOUR_USERNAME/feedsieve-community-api)

**方式 B：本地 wrangler**

```sh
npm install
npx wrangler login
npx wrangler deploy
```

部署成功后你会得到一个地址：`https://<你的worker>.workers.dev`。

> 💡 **国内 `*.workers.dev` 访问可能不稳定**。建议在 Worker → **Settings → Triggers → Custom Domains**
> 绑一个自己的域名（几块钱一年的 `.top` / `.cn` 即可），脚本里填自定义域名更稳。

### 4. 上传名单与词库到 R2

数据源在 `data/` 目录。两种方式任选其一：

**方式 A：脚本（推荐，一条命令）**

macOS / Linux（或已装 WSL 的 Windows）：

```sh
npm install        # 安装 wrangler
bash scripts/publish.sh
```

Windows（未装 WSL，用 PowerShell）：

```powershell
npm install
powershell -ExecutionPolicy Bypass -File scripts\publish.ps1
```

> ⚠️ **必须带 `--remote`**：wrangler 4.x 的 `r2 object put` 默认只写**本地模拟 R2**
> （终端会输出 `Resource location: local`，看起来「成功了」但线上没有数据）。
> 本仓库的两个脚本都已加好 `--remote`，直接用即可。

**方式 B：R2 面板手动拖拽**

打开 bucket `feedsieve-data`，按以下路径上传 `data/` 里对应的文件：

| R2 里的路径 | 上传的文件 |
| --- | --- |
| `snapshots/latest.json` | `data/snapshots/manifest.json` |
| `snapshots/2026.09.02.1/official.json` | `data/snapshots/official.json` |
| `snapshots/2026.09.02.1/blocklist.yaml` | `data/snapshots/blocklist.yaml` |
| `keyword-packs/latest.json` | `data/keyword-packs/manifest.json` |
| `keyword-packs/2026.09.02.5/official.json` | `data/keyword-packs/official.json` |

> 目录里的版本号来自 `data/*/manifest.json` 的 `snapshot_version` / `pack_version`，换数据时以文件为准。

### 5. 验证

```sh
curl https://<你的worker>.workers.dev/healthz
# => {"ok":true,"service":"feedsieve-community-api","time":"..."}

curl https://<你的worker>.workers.dev/v1/snapshots/latest
# => {"snapshot_version":"2026.09.02.1","files":[...]}

curl https://<你的worker>.workers.dev/v1/keyword-packs/latest
# => {"pack_version":"2026.09.02.5",...}
```

---

## 让脚本用你的 API

脚本默认指向官方 API（已停服）。要让它用你部署的后端，二选一：

**方式一：面板填地址（推荐，不改脚本）**

在 x.com 页面打开 FeedSieve 面板 →「API 地址」填 `https://<你的worker>.workers.dev`
（或自定义域名）→ 点「同步名单」。**留空则回退到官方默认地址。**

**方式二：改脚本默认值后重新分发**

若要把脚本分享给别人、且希望对方**装上就用你的后端**，把 `feedsieve.user.js` 里
全部 `https://feedsieve-api.chendahuang.com` 替换成你的地址，共 **4 处**：

| 位置 | 作用 |
| --- | --- |
| 头部注释 | 说明文字 |
| `DEFAULT_COMMUNITY_API_BASE` | 名单同步默认地址 |
| `DEFAULT_KEYWORD_PACK_API_BASE` | 词库同步默认地址 |
| 设置面板 `placeholder` | UI 提示 |

> 改完后，别人安装脚本、打开 x.com 即会自动同步你的名单，无需手动配置。
> ⚠️ 但请注意：这样会把你的接口暴露给所有使用者，**会分摊你的 Workers 请求配额**（免费版约 10 万请求/天）。
> 若只是自用，建议用方式一。

---

## API 端点

所有端点均为 `GET`，且已开启 CORS。

| 端点 | 说明 | 缓存 |
| --- | --- | --- |
| `GET /healthz` | 存活检查 | - |
| `GET /v1/policy` | 公开政策（拉黑阈值等） | - |
| `GET /v1/snapshots/latest` | 黑名单 manifest（含 sha256） | 300s |
| `GET /v1/snapshots/:version/official.json` | 机器可读黑名单 | 1 年（不可变） |
| `GET /v1/snapshots/:version/blocklist.yaml` | 人类可读黑名单（YAML） | 1 年（不可变） |
| `GET /v1/blocklist/latest.yaml` | 最新黑名单（YAML 快捷入口） | 300s |
| `GET /v1/blocklist/latest.json` | 最新黑名单（JSON 快捷入口） | 300s |
| `GET /v1/keyword-packs/latest` | 词库 manifest | 300s |
| `GET /v1/keyword-packs/:version/official.json` | 词库正文 | 1 年（不可变） |

`version` 必须匹配 `^\d{4}\.\d{2}\.\d{2}\.\d{1,4}$`（如 `2026.09.02.1`）。

---

## 数据格式与更新

`data/` 下的静态产物：

```
data/
├── snapshots/
│   ├── manifest.json     # schema_version 2，含 snapshot_version 与各文件 sha256/entries
│   ├── official.json     # 机器可读名单（entries 数组）
│   └── blocklist.yaml    # 人类可读名单
└── keyword-packs/
    ├── manifest.json     # schema_version 1，含 pack_version 与 sha256/packs/rules
    └── official.json     # 8 个 pack，共 778 条规则
```

当前数据版本：

- **黑名单快照** `snapshot_version = 2026.09.02.1`（6 条）
- **关键词词库** `pack_version = 2026.09.02.5`（8 包 / 778 条）

### 更新流程

1. 修改 `data/` 下对应文件（并同步更新 manifest 里的 `sha256` 等）。
2. 重新跑发布脚本（或重新拖拽上传）。
3. **无需重新部署 Worker**。

### ⚠️ 硬约束：文件必须保持 LF 换行

产物通过 **sha256** 校验。`.gitattributes` 已强制 `* text eol=lf`，确保任何平台检出都是 LF。
若你把 `official.json` / `blocklist.yaml` 等换成 CRLF，**油猴端哈希校验会失败，从而拒绝整份名单**。

---

## 本地开发

```sh
npm install

npm run dev        # wrangler dev，本地 workerd（需本地也有 feedsieve-data bucket）
npm run typecheck  # tsc --noEmit
npm run deploy     # wrangler deploy
npm run publish    # bash scripts/publish.sh（上传 data/ 到 R2）
```

---

## 项目结构

```
feedsieve.user.js          🐒 油猴脚本（本地检测 + 黄框标注 + 一键拉黑，自带离线数据）
src/
  index.ts                 只读 API（Hono，所有端点均为 GET）
  snapshot.ts              从 R2 读取名单快照与词库
  env.d.ts                 绑定声明（仅 DATA: R2Bucket）
wrangler.toml              部署配置（单一 R2 绑定，无 D1 / cron / 密钥）
data/
  snapshots/               黑名单静态产物（manifest / official.json / blocklist.yaml）
  keyword-packs/           词库静态产物（manifest / official.json）
scripts/
  publish.sh               上传 data/ 到 R2（macOS/Linux/bash）
  publish.ps1              上传 data/ 到 R2（Windows PowerShell）
package.json               依赖与脚本（hono / wrangler / typescript）
.gitattributes             强制 LF（保障 sha256 校验）
```

---

## 常见问题

**Q：官方 API 关了，脚本还能用吗？**
能。脚本内置完整离线数据（6 条名单 + 778 条词库），检测、标注、拉黑均不依赖 API。详见 [离线兜底与数据来源](#离线兜底与数据来源)。

**Q：别人加自定义关键词，会污染我的服务器数据吗？**
不会。自定义关键词**纯本地存储**，且后端**没有任何写接口**，架构上只读。唯一影响是分摊读取请求配额。

**Q：为什么面板提示「同步失败」，但黄框还在？**
因为同步失败不影响本地检测——黄框用的是内置词库。填上可用 API 地址后提示即消失。

**Q：默认为什么只启用了「成人引流」一个词库包？**
这是脚本的默认订阅设置（`DEFAULT_SUBSCRIBED_CATEGORY_IDS`）。要启用全部 778 条，请在面板手动勾选其余词库包。

**Q：为什么 r2 上传脚本一定要 `--remote`？**
wrangler 4.x 的 `r2 object put` 默认写本地模拟 R2。不加 `--remote` 会「假成功」——终端显示完成，线上却是空的。

**Q：`*.workers.dev` 国内访问慢 / 不通怎么办？**
绑定自定义域名（Worker → Settings → Triggers → Custom Domains），脚本里填该域名。

---

## 相关链接

- 🐒 [油猴脚本](https://github.com/Serein1202/feedsieve-community-api)（本仓库 `feedsieve.user.js`）：MIT
- ☁️ [可选自托管后端](https://github.com/Serein1202/feedsieve-community-api)（本仓库 `src/`）：MIT
- 📦 上游原始项目：[realchendahuang/feedsieve](https://github.com/realchendahuang/feedsieve)（仓库已 404）

---

## 许可证

[MIT](LICENSE)
