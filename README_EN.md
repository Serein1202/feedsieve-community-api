<p align="right">
  <a href="README.md"><img alt="简体中文" src="https://img.shields.io/badge/%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-switch-2ea44f?style=flat-square"></a>
  <img alt="English" src="https://img.shields.io/badge/English-current-0366d6?style=flat-square">
</p>

# FeedSieve Community API (Self-hosted Lite)

A FeedSieve backend for a single-user setup. **Read-only endpoints only** (community blocklist snapshot + public keyword packs). The upstream admin panel, report/rescue/contribution stats, D1 database and scheduled snapshot generation have all been removed.

Both the blocklist and the keyword packs are pre-reviewed static artifacts committed to the repo. Upload them to R2 once with `scripts/publish.sh`.
Deployment needs just **one R2 bucket + one click** — no database, no migrations, no IDs to fill in, no secrets.

> **About the default API address**: The userscript (`feedsieve.user.js`) defaults to the official community API
> `https://feedsieve-api.chendahuang.com`. The official API is provided by the maintainer; the more people share it,
> the heavier the load. If you want to run independently, follow the **Deployment** steps below to self-host,
> then see **Point the userscript at your API**.

## Endpoints

| Endpoint | Description |
| --- | --- |
| `GET /healthz` | Liveness check |
| `GET /v1/snapshots/latest` | Blocklist manifest (with sha256) |
| `GET /v1/snapshots/:version/official.json` | Machine-readable blocklist |
| `GET /v1/snapshots/:version/blocklist.yaml` | Human-readable blocklist |
| `GET /v1/keyword-packs/latest` | Keyword-pack manifest |
| `GET /v1/keyword-packs/:version/official.json` | Keyword-pack body (8 packs / 778 rules) |

## Deployment

### Prerequisites
- A GitHub repository (push this folder to it)
- A Cloudflare account (the free plan is enough)
- Node installed locally (only needed for uploading data with `publish.sh`; not needed if you drag-and-drop via the R2 dashboard)

### 1. Push to GitHub
```sh
cd feedsieve-community-api
git init
git add -A
git commit -m "feedsieve community api (self-hosted)"
git remote add origin https://github.com/YOUR_USERNAME/feedsieve-community-api.git
git push -u origin main
```

### 2. Create an R2 bucket on Cloudflare
Dashboard → **R2** → **Create bucket** → name it **`feedsieve-data`** (the name must match exactly; the code references it by name).
The free quota is plenty.

### 3. One-click deploy the Worker
Click the button below (or import the Git repository manually in the Dashboard):

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?repository-url=https://github.com/YOUR_USERNAME/feedsieve-community-api)

> The button clones the repo and deploys using the bundled `wrangler.toml`. Because `wrangler.toml` references the R2
> bucket by **name**, as long as the bucket from step 2 is called `feedsieve-data`, you don't need to fill in any
> `database_id` when deploying.
>
> `*.workers.dev` can be unstable in some regions. After deploying, consider binding your own domain under
> Worker → **Settings → Triggers → Custom Domains** (a cheap `.top`/`.cn` domain works). Then use that domain in the userscript.

### 4. Upload the blocklist and keyword packs to R2
Pick either method:

**Method A: script (recommended, one command)**

macOS / Linux (or Windows with WSL):
```sh
npm install        # installs wrangler
bash scripts/publish.sh
```

Windows (no WSL, PowerShell):
```powershell
npm install
powershell -ExecutionPolicy Bypass -File scripts\publish.ps1
```

> ⚠️ In wrangler 4.x, `r2 object put` **writes only to the local simulated R2 by default** (it prints `Resource location: local`).
> You must pass `--remote` to actually upload to the live bucket. Both scripts in this repo already include `--remote` — just run them.

**Method B: R2 dashboard drag-and-drop**
Open the `feedsieve-data` bucket and upload the corresponding files from `data/` to these paths:

| Path in R2 | File to upload |
| --- | --- |
| `snapshots/latest.json` | `data/snapshots/manifest.json` |
| `snapshots/2026.09.02.1/official.json` | `data/snapshots/official.json` |
| `snapshots/2026.09.02.1/blocklist.yaml` | `data/snapshots/blocklist.yaml` |
| `keyword-packs/latest.json` | `data/keyword-packs/manifest.json` |
| `keyword-packs/2026.09.02.5/official.json` | `data/keyword-packs/official.json` |

> The version numbers come from `snapshot_version` / `pack_version` in `data/*/manifest.json`. When you swap the data, follow the files.

### 5. Point the userscript at your API

The userscript points to the official API by default. To make it use your own backend, pick one:

**Option 1: fill in the address in the panel (recommended, no script edits)**
Open the FeedSieve panel on x.com → set **API address** to `https://<your-worker>.workers.dev`
(or your custom domain) → click **Sync list**. Leaving it blank falls back to the official default.

**Option 2: change the script default and redistribute**
If you want to share the script with others and have it use your backend out of the box, replace every occurrence of
`https://feedsieve-api.chendahuang.com` in `feedsieve.user.js` with your address — 4 places in total:
- the header comment (description text)
- `DEFAULT_COMMUNITY_API_BASE` (default base for blocklist sync)
- `DEFAULT_KEYWORD_PACK_API_BASE` (default base for keyword-pack sync)
- the settings panel `placeholder`

After that, anyone who installs the script and opens x.com will sync your blocklist automatically, with no manual setup.

## Verify
```sh
curl https://<your-worker>.workers.dev/healthz
# => {"ok":true,...}

curl https://<your-worker>.workers.dev/v1/snapshots/latest
# => {"snapshot_version":"2026.09.02.1","files":[...]}

curl https://<your-worker>.workers.dev/v1/keyword-packs/latest
# => {"pack_version":"2026.09.02.5",...}
```

## Updating the blocklist / keyword packs
Edit the files under `data/`, then re-run `bash scripts/publish.sh` (or drag-and-drop again). No need to redeploy the Worker.

## Local development
```sh
npm install
wrangler dev                     # local workerd; needs a local feedsieve-data bucket too
```

## File structure
```
src/index.ts          Read-only API (Hono)
src/snapshot.ts       Fetch blocklist snapshots from R2
src/env.d.ts          Binding declaration (only DATA: R2Bucket)
wrangler.toml         Deploy config (R2 binding, no D1/cron)
data/snapshots/       Blocklist static artifacts (manifest/official.json/blocklist.yaml)
data/keyword-packs/   Keyword-pack static artifacts (manifest/official.json)
scripts/publish.sh     Upload data/ to R2 (macOS/Linux/bash)
scripts/publish.ps1    Upload data/ to R2 (Windows PowerShell)
```
