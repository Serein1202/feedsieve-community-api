# FeedSieve 社区 API（自托管精简版）

给「一个人用」的场景用的 FeedSieve 后端。**只保留读接口**（社区名单快照 + 公开关键词词库），
去掉了原版的管理员后台、举报/抢救/贡献统计、D1 数据库和定时快照生成。

名单与词库都是仓库里预审过的静态产物，由 `scripts/publish.sh` 一次性上传到 R2 即可。
部署只需要 **一个 R2 bucket + 一次点击**，没有建库、迁移、填 ID、设密钥这些步骤。

油猴脚本面板里填这个地址即可：`https://<你的worker>.workers.dev`

## 提供的端点

| 端点 | 说明 |
| --- | --- |
| `GET /healthz` | 存活检查 |
| `GET /v1/snapshots/latest` | 名单 manifest（含 sha256） |
| `GET /v1/snapshots/:version/official.json` | 机器可读名单 |
| `GET /v1/snapshots/:version/blocklist.yaml` | 人类可读黑名单 |
| `GET /v1/keyword-packs/latest` | 词库 manifest |
| `GET /v1/keyword-packs/:version/official.json` | 词库正文（8 包 / 778 条） |

## 部署步骤

### 前置
- 一个 GitHub 仓库（把本文件夹推上去）
- 一个 Cloudflare 账号（免费版即可）
- 本地有 Node（仅当用 `publish.sh` 上传数据时需要；用 R2 面板拖拽则不需要）

### 1. 推到 GitHub
```sh
cd feedsieve-community-api
git init
git add -A
git commit -m "feedsieve community api (self-hosted)"
git remote add origin https://github.com/你的用户名/feedsieve-community-api.git
git push -u origin main
```

### 2. 在 Cloudflare 建一个 R2 bucket
Dashboard → **R2** → **Create bucket** → 名称填 **`feedsieve-data`**（名字必须一致，代码按名字引用）。
免费额度足够。

### 3. 一键部署 Worker
点下面的按钮（或 Dashboard 里手动导入 Git 仓库）：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?repository-url=https://github.com/你的用户名/feedsieve-community-api)

> 按钮会克隆仓库并用仓库里的 `wrangler.toml` 部署。因为 wrangler.toml 按**名字**引用 R2 bucket，
> 只要第 2 步的 bucket 叫 `feedsieve-data`，部署时无需填任何 database_id。
>
> 国内 `*.workers.dev` 访问不稳定，建议部署后在 Worker → **Settings → Triggers → Custom Domains**
> 绑一个自己的域名（几块钱一年的 `.top`/`.cn` 即可）。油猴里就填自定义域名。

### 4. 上传名单与词库到 R2
两种任选其一：

**方式 A：脚本（推荐，一条命令）**
```sh
npm install        # 装 wrangler
bash scripts/publish.sh
```

**方式 B：R2 面板拖拽**
打开 bucket `feedsieve-data`，按以下路径上传 `data/` 里对应的文件：

| R2 里的路径 | 上传的文件 |
| --- | --- |
| `snapshots/latest.json` | `data/snapshots/manifest.json` |
| `snapshots/2026.09.02.1/official.json` | `data/snapshots/official.json` |
| `snapshots/2026.09.02.1/blocklist.yaml` | `data/snapshots/blocklist.yaml` |
| `keyword-packs/latest.json` | `data/keyword-packs/manifest.json` |
| `keyword-packs/2026.09.02.5/official.json` | `data/keyword-packs/official.json` |

> 版本号来自 `data/*/manifest.json` 里的 `snapshot_version` / `pack_version`，换数据时以文件为准。

### 5. 油猴填地址
油猴面板「API 地址」里填：`https://<你的worker>.workers.dev`（或自定义域名），然后点「同步名单」。

## 验证
```sh
curl https://<你的worker>.workers.dev/healthz
# => {"ok":true,...}

curl https://<你的worker>.workers.dev/v1/snapshots/latest
# => {"snapshot_version":"2026.09.02.1","files":[...]}

curl https://<你的worker>.workers.dev/v1/keyword-packs/latest
# => {"pack_version":"2026.09.02.5",...}
```

## 更新名单/词库
改 `data/` 下文件后重新跑 `bash scripts/publish.sh`（或重新拖拽上传）即可。无需重新部署 Worker。

## 本地开发
```sh
npm install
wrangler dev                     # 本地 workerd，需本地也有 feedsieve-data bucket
```

## 文件结构
```
src/index.ts          只读 API（Hono）
src/snapshot.ts       从 R2 取名单快照
src/env.d.ts          绑定声明（仅 DATA: R2Bucket）
wrangler.toml         部署配置（R2 绑定，无 D1/cron）
data/snapshots/       名单静态产物（manifest/official.json/blocklist.yaml）
data/keyword-packs/   词库静态产物（manifest/official.json）
scripts/publish.sh     上传 data/ 到 R2
```
