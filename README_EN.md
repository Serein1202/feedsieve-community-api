<p align="right">
  <a href="README.md"><img alt="简体中文" src="https://img.shields.io/badge/%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-switch-2ea44f?style=flat-square"></a>
  <img alt="English" src="https://img.shields.io/badge/English-current-0366d6?style=flat-square">
</p>

# FeedSieve (Self-hosted Lite)

> Visible first, block only. Mark suspected spam accounts with a yellow box on x.com and block them through the page's own native endpoint. **Never hides content.**

This repository contains **two parts** of FeedSieve. Each works on its own, and they work great together:

| Component | Files | Description |
| --- | --- | --- |
| 🐒 **Userscript** (frontend) | `feedsieve.user.js` | Runs in your browser: local detection, yellow-box marking and one-click blocking on x.com. **Ships with offline data — works out of the box.** |
| ☁️ **Community API** (backend, optional) | `src/` + `wrangler.toml` | A **read-only** backend on Cloudflare Workers + Hono, used to sync the community blocklist and public keyword packs. |

It targets a single-user, self-hosted setup: the backend keeps **read endpoints only**, dropping the upstream admin panel,
report/rescue/contribution stats, D1 database and scheduled snapshot generation.
Both the blocklist and the keyword packs are pre-reviewed **static artifacts** committed to the repo — upload them to R2 once.
No database, no migrations, no IDs, no secrets.

> **About the default API address**: The userscript defaults to the original author's community API
> `https://feedsieve-api.chendahuang.com` (original repo is now 404, that API is offline). This does **not** break the
> userscript — it ships with complete offline fallback data (see [Offline fallback & data sources](#offline-fallback--data-sources)).
> If you want to sync fresh blocklists / keyword packs yourself, self-host the backend
> ([Self-hosting the backend](#self-hosting-the-backend-step-by-step)) and point the script at it
> ([Point the userscript at your API](#point-the-userscript-at-your-api)).

---

## Acknowledgments

This project is a "self-hosted lite" fork of [chendahuang/feedsieve](https://github.com/realchendahuang/feedsieve)
(original repo is now 404). It strips out the parts that only matter for multi-user collaboration — D1, admin panel,
report/rescue/contribution stats, secrets — and reshapes the backend into a read-only, single-R2-bucket form.

Many thanks to **chendahuang** for the original architecture and community design.

---

## Table of contents

- [How it works](#how-it-works)
- [Features](#features)
- [Quick start: install the userscript](#quick-start-install-the-userscript)
- [Offline fallback & data sources](#offline-fallback--data-sources)
- [Privacy](#privacy)
- [Self-hosting the backend (step by step)](#self-hosting-the-backend-step-by-step)
- [Point the userscript at your API](#point-the-userscript-at-your-api)
- [API endpoints](#api-endpoints)
- [Data format & updating](#data-format--updating)
- [Local development](#local-development)
- [Project structure](#project-structure)
- [FAQ](#faq)
- [License](#license)

---

## How it works

```
┌──────────────────────────── x.com page ─────────────────────────────┐
│  Userscript feedsieve.user.js                                       │
│   ├─ Local detection (built-in heuristics + keyword packs)          │
│   ├─ Yellow-box marking (outline; takes no layout, hides nothing)   │
│   └─ User clicks "Block" → calls x.com's own native block endpoint  │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ GET-only read sync (optional)
                                ▼
┌──────────────── Cloudflare Worker (optional, self-hosted)───────────┐
│  GET /v1/snapshots/...      community blocklist snapshots           │
│  GET /v1/keyword-packs/...  public keyword packs                    │
│  Data served from R2 bucket "feedsieve-data" (static files)         │
└─────────────────────────────────────────────────────────────────────┘
```

Key points:

1. **Detection happens locally.** The script matches an account's display name / handle / post text / bio against
   built-in heuristics and keyword packs.
2. **Marking ≠ hiding.** A hit just draws a yellow `outline`; the content stays visible and the user keeps final say.
3. **Blocking is user-triggered**, through x.com's own native endpoint (the only POST in the script — it targets x.com,
   not the community API).
4. **The community API is just an optional incremental data source.** When it's unreachable, the script falls back to
   built-in data and keeps working.

---

## Features

### Userscript

- **Yellow-box marking, never hides**: outlines suspected spam accounts with `outline`, so it doesn't squeeze X's
  layout or cover any tweet.
- **Three marking strengths**:
  - `refresh` (clean)
  - `standard` (default)
  - `deep_clean` (also enables more aggressive fingerprint / domain detection)
- **Built-in heuristics**:
  - `default-name-digits`: default name + long digit tail, likely bulk-registered
  - `spam-link-hint`: post contains a suspicious outbound link
  - `templated-text`: templated spam copy
  - `porn-bait-zh`: Chinese adult gray-traffic bait
- **Keyword packs**: 8 categories, 778 rules, subscribable per category in the panel, plus **custom keywords**
  (up to 80, stored locally).
- **Category labels**: bot / repeat spam / advertising / adult traffic / scam / engagement bait / other.
- **Block all on page**: bulk-block every yellow-boxed account on the current page.
- **False-positive correction**: click "Mistaken?" on an account to add it to your personal allowlist.
- **Control panel**: shows snapshot version, last sync time, yellow boxes on page, allowlist count, block ledger;
  includes a draggable floating button (FAB).
- **Menu commands** (Tampermonkey menu):
  - FeedSieve: open panel
  - FeedSieve: sync blocklist & keyword packs now
  - FeedSieve: block all yellow-boxed accounts on this page

### Community API (backend)

- **Read-only**: every endpoint is `GET`; there are no write endpoints.
- **Single R2 bucket**: blocklists (`snapshots/`) and keyword packs (`keyword-packs/`) share one bucket.
- **No database / secrets / cron jobs needed.**
- **CORS wide open**, so any frontend can consume it.
- **Cache-friendly**: short cache for manifests (300s), immutable cache for versioned files (1 year).
- **Public policy**: `/v1/policy` exposes the thresholds — no hidden black box.

---

## Quick start: install the userscript

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or Violentmonkey) in your browser.
2. Open `feedsieve.user.js`; Tampermonkey shows an install page — click install.
3. Open [x.com](https://x.com/). A FeedSieve floating button appears in the bottom-right; click it to open the panel.
4. It works with defaults (built-in data). To sync your own backend, see
   [Point the userscript at your API](#point-the-userscript-at-your-api).

> The script's `@match` covers `https://x.com/*` and `https://twitter.com/*`, with `@run-at document-start`.

---

## Offline fallback & data sources

**This is a core design point: the script works even if every API is unreachable.**

The script bundles two complete offline datasets:

| Data | Bundled constant | Content |
| --- | --- | --- |
| Community blocklist | `BUNDLED_SNAPSHOT` | snapshot `2026.09.02.1`, 6 entries |
| Keyword packs | `BUNDLED_KEYWORD_PACK_CATALOG` | pack `2026.09.02.5`, 8 packs / 778 rules |

Fallback logic (source highlights):

- Blocklist: `getCommunitySnapshot()` → `getStoredCommunitySnapshot() ?? BUNDLED_SNAPSHOT`
- Keyword packs: `getKeywordPackCatalog()` → `return BUNDLED_KEYWORD_PACK_CATALOG` when there's no local cache
- Sync functions are wrapped in `try/catch`; a failure just returns `{status:"error"}` instead of throwing, and the
  bootstrap is additionally guarded by `.catch(()=>{})`

So when the official API is unavailable: **detection, marking and blocking all keep working**; only syncing *newer*
blocklists / keyword packs is affected. A "sync failed" message in the panel is expected and **does not affect core
functionality**.

> ⚠️ **Note the default subscription scope**: by default the script subscribes to only `adult_gray_traffic`
> (adult gray traffic, 629 rules). The other 7 packs (149 rules) are **off by default** and must be ticked in the panel
> (ticking is a purely local action and does not depend on the API).

---

## Privacy

- **Custom keywords stay local**: they live in Tampermonkey's `GM_setValue` or browser `localStorage`
  (key prefix `feedsieve:`), and are **never uploaded anywhere**. You can't see others' keywords, and yours don't leak.
- **Read-only access to the community API**: the script only issues `GET` requests to it (blocklist manifest/snapshot,
  keyword-pack manifest/body).
- **No reporting / no contribution**: this lite script uploads nothing to any backend, and the backend has no write
  endpoints anyway.
- **Blocking happens inside the x.com page**, via the page's native endpoint — unrelated to the community API.

> In other words: using someone else's community API only consumes its **read request quota**; it never writes to or
> pollutes their data.

---

## Self-hosting the backend (step by step)

### Prerequisites

- A **GitHub repository** (push this folder to it, for one-click deploy)
- A **Cloudflare account** (the free plan is enough)
- **Node.js** locally (only needed to upload data with a script; not needed if you use the R2 dashboard drag-and-drop)

### 1. Push to GitHub

```sh
cd feedsieve-community-api
git init
git add -A
git commit -m "feedsieve community api (self-hosted)"
git remote add origin https://github.com/<your-username>/feedsieve-community-api.git
git push -u origin main
```

### 2. Create an R2 bucket on Cloudflare

Dashboard → **R2** → **Create bucket** → name it **`feedsieve-data`**.

> ⚠️ **The name must match exactly**: `wrangler.toml` references the bucket by **name**
> (`bucket_name = "feedsieve-data"`). With the right name, you don't need any `database_id` when deploying.
> The free quota is plenty for personal use.

### 3. Deploy the Worker

**Method A: one-click deploy button** (or import the Git repository manually in the Dashboard)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?repository-url=https://github.com/YOUR_USERNAME/feedsieve-community-api)

**Method B: local wrangler**

```sh
npm install
npx wrangler login
npx wrangler deploy
```

After deploying you get an address: `https://<your-worker>.workers.dev`.

> 💡 **`*.workers.dev` can be unstable in some regions.** Consider binding your own domain under
> Worker → **Settings → Triggers → Custom Domains** (a cheap `.top` / `.cn` domain works) and use that in the script.

### 4. Upload the blocklist and keyword packs to R2

The source data lives in `data/`. Pick either method:

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

> ⚠️ **You must pass `--remote`**: in wrangler 4.x, `r2 object put` writes only to the **local simulated R2** by
> default (it prints `Resource location: local` — it looks like it "succeeded" but nothing is in the live bucket).
> Both scripts in this repo already include `--remote`; just run them.

**Method B: R2 dashboard drag-and-drop**

Open the `feedsieve-data` bucket and upload the corresponding files from `data/` to these paths:

| Path in R2 | File to upload |
| --- | --- |
| `snapshots/latest.json` | `data/snapshots/manifest.json` |
| `snapshots/2026.09.02.1/official.json` | `data/snapshots/official.json` |
| `snapshots/2026.09.02.1/blocklist.yaml` | `data/snapshots/blocklist.yaml` |
| `keyword-packs/latest.json` | `data/keyword-packs/manifest.json` |
| `keyword-packs/2026.09.02.5/official.json` | `data/keyword-packs/official.json` |

> The directory version numbers come from `snapshot_version` / `pack_version` in `data/*/manifest.json`.

### 5. Verify

```sh
curl https://<your-worker>.workers.dev/healthz
# => {"ok":true,"service":"feedsieve-community-api","time":"..."}

curl https://<your-worker>.workers.dev/v1/snapshots/latest
# => {"snapshot_version":"2026.09.02.1","files":[...]}

curl https://<your-worker>.workers.dev/v1/keyword-packs/latest
# => {"pack_version":"2026.09.02.5",...}
```

---

## Point the userscript at your API

The script defaults to the official API (now offline). To make it use your backend, pick one:

**Option 1: fill in the address in the panel (recommended, no script edits)**

Open the FeedSieve panel on x.com → set **API address** to `https://<your-worker>.workers.dev`
(or your custom domain) → click **Sync**. **Leaving it blank falls back to the official default.**

**Option 2: change the script default and redistribute**

If you want to share the script with others and have it use your backend **out of the box**, replace every occurrence of
`https://feedsieve-api.chendahuang.com` in `feedsieve.user.js` with your address — **4 places** in total:

| Location | Purpose |
| --- | --- |
| header comment | description text |
| `DEFAULT_COMMUNITY_API_BASE` | default base for blocklist sync |
| `DEFAULT_KEYWORD_PACK_API_BASE` | default base for keyword-pack sync |
| settings panel `placeholder` | UI hint |

> After that, anyone who installs the script and opens x.com syncs your blocklist automatically, no manual setup.
> ⚠️ Note that this exposes your endpoint to all users, **sharing your Workers request quota** (free plan ≈ 100k
> requests/day). If it's just for yourself, prefer Option 1.

---

## API endpoints

All endpoints are `GET` and have CORS enabled.

| Endpoint | Description | Cache |
| --- | --- | --- |
| `GET /healthz` | Liveness check | - |
| `GET /v1/policy` | Public policy (block thresholds etc.) | - |
| `GET /v1/snapshots/latest` | Blocklist manifest (with sha256) | 300s |
| `GET /v1/snapshots/:version/official.json` | Machine-readable blocklist | 1 year (immutable) |
| `GET /v1/snapshots/:version/blocklist.yaml` | Human-readable blocklist (YAML) | 1 year (immutable) |
| `GET /v1/blocklist/latest.yaml` | Latest blocklist (YAML shortcut) | 300s |
| `GET /v1/blocklist/latest.json` | Latest blocklist (JSON shortcut) | 300s |
| `GET /v1/keyword-packs/latest` | Keyword-pack manifest | 300s |
| `GET /v1/keyword-packs/:version/official.json` | Keyword-pack body | 1 year (immutable) |

`version` must match `^\d{4}\.\d{2}\.\d{2}\.\d{1,4}$` (e.g. `2026.09.02.1`).

---

## Data format & updating

Static artifacts under `data/`:

```
data/
├── snapshots/
│   ├── manifest.json     # schema_version 2; holds snapshot_version and per-file sha256/entries
│   ├── official.json     # machine-readable blocklist (entries array)
│   └── blocklist.yaml    # human-readable blocklist
└── keyword-packs/
    ├── manifest.json     # schema_version 1; holds pack_version and sha256/packs/rules
    └── official.json     # 8 packs, 778 rules total
```

Current data versions:

- **Blocklist snapshot** `snapshot_version = 2026.09.02.1` (6 entries)
- **Keyword packs** `pack_version = 2026.09.02.5` (8 packs / 778 rules)

### Update flow

1. Edit the relevant files under `data/` (and update `sha256` etc. in the manifest accordingly).
2. Re-run the publish script (or drag-and-drop again).
3. **No need to redeploy the Worker.**

### ⚠️ Hard constraint: files must stay LF

Artifacts are verified by **sha256**. `.gitattributes` forces `* text eol=lf`, so checkouts on any platform stay LF.
If you convert `official.json` / `blocklist.yaml` etc. to CRLF, **the userscript's hash check fails and it rejects the
entire blocklist**.

---

## Local development

```sh
npm install

npm run dev        # wrangler dev, local workerd (needs a local feedsieve-data bucket too)
npm run typecheck  # tsc --noEmit
npm run deploy     # wrangler deploy
npm run publish    # bash scripts/publish.sh (upload data/ to R2)
```

---

## Project structure

```
feedsieve.user.js         🐒 Userscript (local detection + yellow-box marking + one-click blocking; offline data)
src/
  index.ts                Read-only API (Hono; all endpoints are GET)
  snapshot.ts             Read blocklist snapshots and keyword packs from R2
  env.d.ts                Binding declaration (only DATA: R2Bucket)
wrangler.toml             Deploy config (single R2 binding; no D1 / cron / secrets)
data/
  snapshots/              Blocklist static artifacts (manifest / official.json / blocklist.yaml)
  keyword-packs/          Keyword-pack static artifacts (manifest / official.json)
scripts/
  publish.sh              Upload data/ to R2 (macOS/Linux/bash)
  publish.ps1             Upload data/ to R2 (Windows PowerShell)
package.json              Dependencies and scripts (hono / wrangler / typescript)
.gitattributes            Forces LF (protects sha256 checks)
```

---

## FAQ

**Q: The official API is down — does the userscript still work?**
Yes. It bundles complete offline data (6 blocklist entries + 778 keyword rules); detection, marking and blocking
don't depend on the API. See [Offline fallback & data sources](#offline-fallback--data-sources).

**Q: If someone adds custom keywords, will it pollute my server data?**
No. Custom keywords are **stored locally**, and the backend has **no write endpoints** — it's read-only by design.
The only impact is sharing read request quota.

**Q: Why does the panel show "sync failed" while yellow boxes still appear?**
Because a failed sync doesn't affect local detection — the boxes come from bundled keyword packs. The message
disappears once you set a working API address.

**Q: Why is only the "adult gray traffic" pack enabled by default?**
That's the script's default subscription (`DEFAULT_SUBSCRIBED_CATEGORY_IDS`). To enable all 778 rules, tick the
remaining packs in the panel.

**Q: Why must the R2 upload script pass `--remote`?**
In wrangler 4.x, `r2 object put` writes to the local simulated R2 by default. Without `--remote` it "succeeds"
falsely — the terminal says done, but the live bucket is empty.

**Q: `*.workers.dev` is slow / unreachable in my region — what can I do?**
Bind a custom domain (Worker → Settings → Triggers → Custom Domains) and use that domain in the script.

---

## Links

- 🐒 [Userscript](https://github.com/Serein1202/feedsieve-community-api) (`feedsieve.user.js` in this repo) — MIT
- ☁️ [Self-hosted backend](https://github.com/Serein1202/feedsieve-community-api) (`src/` in this repo) — MIT
- 📦 Upstream project: [realchendahuang/feedsieve](https://github.com/realchendahuang/feedsieve) (repo is now 404)

---

## License

[MIT](LICENSE)
