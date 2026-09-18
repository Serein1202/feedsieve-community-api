#!/usr/bin/env bash
# 把仓库里的名单/词库上传到 R2。需先：在 Cloudflare 后台建 bucket feedsieve-data，并安装 wrangler。
# 用法：bash scripts/publish.sh   （bucket 名可用环境变量覆盖：R2_BUCKET=my-bucket bash scripts/publish.sh）
set -euo pipefail

BUCKET="${R2_BUCKET:-feedsieve-data}"

# 从 manifest 读取版本号（决定 R2 里的目录名）
SNAP_VERSION=$(node -p "require('./data/snapshots/manifest.json').snapshot_version")
PACK_VERSION=$(node -p "require('./data/keyword-packs/manifest.json').pack_version")

echo "上传社区名单快照 (version=$SNAP_VERSION) ..."
wrangler r2 object put "$BUCKET/snapshots/latest.json" --file=data/snapshots/manifest.json --remote
wrangler r2 object put "$BUCKET/snapshots/$SNAP_VERSION/official.json" --file=data/snapshots/official.json --remote
wrangler r2 object put "$BUCKET/snapshots/$SNAP_VERSION/blocklist.yaml" --file=data/snapshots/blocklist.yaml --remote

echo "上传关键词词库 (version=$PACK_VERSION) ..."
wrangler r2 object put "$BUCKET/keyword-packs/latest.json" --file=data/keyword-packs/manifest.json --remote
wrangler r2 object put "$BUCKET/keyword-packs/$PACK_VERSION/official.json" --file=data/keyword-packs/official.json --remote

echo "完成。快照=$SNAP_VERSION  词库=$PACK_VERSION"
