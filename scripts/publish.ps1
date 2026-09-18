# publish.ps1 — Windows PowerShell 版，等价于 scripts/publish.sh
# 把仓库里的名单/词库上传到 R2。
# 前置：Cloudflare 后台已建 bucket feedsieve-data；已在仓库根目录执行 npm install 且 wrangler login 过。
# 用法（在仓库根目录）：powershell -ExecutionPolicy Bypass -File scripts\publish.ps1
#   bucket 名可用环境变量覆盖：$env:R2_BUCKET='my-bucket'; .\scripts\publish.ps1
[CmdletBinding()]
param(
    [string]$Bucket = $(if ($env:R2_BUCKET) { $env:R2_BUCKET } else { 'feedsieve-data' })
)

$ErrorActionPreference = 'Stop'

# 切到仓库根目录（scripts 的上一级），保证相对路径 data/... 可用
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Invoke-Wrangler {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$WranglerArgs)
    & npx --yes wrangler @WranglerArgs
    if ($LASTEXITCODE -ne 0) { throw "wrangler 退出码 $LASTEXITCODE（命令: wrangler $($WranglerArgs -join ' ')）" }
}

# 从 manifest 读取版本号（决定 R2 里的目录名）
$snapVersion = (Get-Content 'data/snapshots/manifest.json' -Raw | ConvertFrom-Json).snapshot_version
$packVersion = (Get-Content 'data/keyword-packs/manifest.json' -Raw | ConvertFrom-Json).pack_version

Write-Host "上传社区名单快照 (version=$snapVersion) ..."
Invoke-Wrangler r2 object put "$Bucket/snapshots/latest.json" --file=data/snapshots/manifest.json --remote
Invoke-Wrangler r2 object put "$Bucket/snapshots/$snapVersion/official.json" --file=data/snapshots/official.json --remote
Invoke-Wrangler r2 object put "$Bucket/snapshots/$snapVersion/blocklist.yaml" --file=data/snapshots/blocklist.yaml --remote

Write-Host "上传关键词词库 (version=$packVersion) ..."
Invoke-Wrangler r2 object put "$Bucket/keyword-packs/latest.json" --file=data/keyword-packs/manifest.json --remote
Invoke-Wrangler r2 object put "$Bucket/keyword-packs/$packVersion/official.json" --file=data/keyword-packs/official.json --remote

Write-Host "完成。快照=$snapVersion  词库=$packVersion"
