# WorldMonitor Active Deployment Build Guide

Operator runbook for deploying WorldMonitor to Vercel at **https://omnia-global-monitor.vercel.app** with **Upstash Redis** as the primary data store.

Team: `sethrocks-projects` (`team_PCWFPemgZnDsI9xhj7WVV5XC`)

---

## What the app actually needs

WorldMonitor’s Edge API and bootstrap path expect an **Upstash-compatible Redis REST** store via:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

Wired in `server/_shared/redis.ts` for cache, seed snapshots, rate limits, and `/api/bootstrap`.

| Store | Role | Required for this deploy? |
|-------|------|---------------------------|
| **Redis (Upstash REST)** | Primary hot store | **Yes** |
| **Convex** | Pro/auth/billing | No for free dashboard |
| **Neon / Postgres** | Only `consumer-prices-core` sidecar | No for main app |
| **Railway seed/relay** | Keeps Redis fresh | Phase 2 for near-parity |

**Neon is not a Redis alternative.** It remains available if you later want Postgres for consumer-prices or new SQL features—but it does not satisfy `UPSTASH_REDIS_*`.

---

## Redis options with MCP tooling (decision)

**Chosen default: Upstash Redis.**

### Option 1 — Upstash Redis (recommended)

- **Why it wins:** Zero code changes; Vercel Marketplace one-click; Edge-native REST; official agent MCP.
- **Provision:** `vercel link` then `vercel install upstash` (or `vercel integration add upstash`) — auto-injects `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`.
- **MCP (account ops):** `@upstash/mcp-server` — create DBs, backups, list DBs, usage/debug.
- **MCP (data plane):** `@upstash/redis-mcp` — run Redis commands / pipelines against the live DB with the same REST URL/token the app uses.
- **Fit for WorldMonitor:** Exact match for existing client and seed scripts.

### Option 2 — Redis Cloud / self-hosted Redis + official Redis MCP

- **MCP:** Official [redis/mcp-redis](https://github.com/redis/mcp-redis) — rich key/stream/JSON/search tools over `redis://` or `rediss://`.
- **Gap for this app:** WorldMonitor talks **HTTP REST** (`UPSTASH_REDIS_REST_*`), not TCP RESP from Edge. You need an Upstash-compatible REST proxy (see `docker-compose.yml` / `SELF_HOSTING.md`) or client rewrites.
- **When to pick:** You already run Redis Enterprise/Cloud and accept proxy + ops cost.

### Option 3 — Valkey / Dragonfly / KeyDB

- **Protocol:** Redis-compatible RESP servers; good drop-ins behind the Docker Redis + REST proxy pattern in `SELF_HOSTING.md`.
- **MCP:** No first-class vendor MCP comparable to Upstash. Use **official Redis MCP** pointed at their TCP URL if RESP-compatible.
- **When to pick:** Self-host / cost control; not ideal for a Vercel-first active deploy.

### Option 4 — Neon / Supabase (Postgres)

- **MCP:** Neon MCP and Supabase MCP are available in Cursor.
- **Not interchangeable with Redis** for this codebase. Do not use as the primary store for bootstrap/cache/seeds.
- **Optional later:** Neon for `consumer-prices-core` `DATABASE_URL` only.

### Option 5 — Stripe Projects catalog Redis

- Stripe Projects can provision third-party Redis/caching if the catalog lists a provider; then copy credentials into Vercel env.
- Weaker fit than Marketplace Upstash for this repo (extra indirection; still need Upstash REST compatibility).

**Decision locked:** Use **Upstash Redis** + enable **Upstash MCP** (account) and optionally **Upstash Redis MCP** (commands) for agent-driven ops.

---

## Target deployment topology

```text
Browser → Vercel (Vite SPA + Edge API)
              ↓
         Upstash Redis REST
              ↑
    Phase 2: Railway seeders / AIS relay
              ↑
    Cursor agents via Upstash MCP
```

- **URL:** `https://omnia-global-monitor.vercel.app` (project name `omnia-global-monitor`).
- **Fallbacks if name taken:** `omnia-monitor`, `omniamonitor` (shorter is better).
- **Scope Phase 1 (MVP):** App + Edge + Upstash — dashboard loads; panels that need seeds may be sparse.
- **Scope Phase 2 (near-parity):** Railway (or similar) AIS relay + seed crons writing into the same Upstash DB.

---

## Phase 1 — Deploy checklist

### 1. Prerequisites

- Node.js 22+
- Vercel CLI (`npm i -g vercel` or `npx vercel`)
- Access to Vercel team `sethrocks-projects`
- Upstash account (created automatically via Marketplace, or existing)

### 2. Link / create the Vercel project

```bash
cd /path/to/worldmonitor
npx vercel link --yes --scope sethrocks-projects --project omnia-global-monitor
```

If the project does not exist yet:

```bash
npx vercel project add omnia-global-monitor --scope sethrocks-projects
npx vercel link --yes --scope sethrocks-projects --project omnia-global-monitor
```

Confirm:

- Framework: Vite (auto-detect)
- Root directory: `.`
- Build command: `npm run build` (from `package.json`)
- Output: Vite dist + `api/` Edge Functions (see `vercel.json`)

Production hostname after first deploy: **https://omnia-global-monitor.vercel.app**

### 3. Provision Upstash Redis

**A — Marketplace (preferred for permanent prod):**

```bash
npx vercel install upstash
# or:
npx vercel integration add upstash
```

**B — Agent start-redis (used for this deploy; claim within 3 days):**

```bash
curl -X POST -H "Idempotency-Key: $(uuidgen | tr '[:upper:]' '[:lower:]')" \
  https://upstash.com/start-redis
```

Parse Endpoint + Token from the markdown response. Claim at the console URL in the response. Do not commit tokens to git.

**C — Manual console + wire script:**

1. Create a Redis DB at [console.upstash.com](https://console.upstash.com) (or use agent start-redis above).
2. Copy REST URL + token.
3. Either paste into the [Vercel env UI](https://vercel.com/sethrocks-projects/omnia-global-monitor/settings/environment-variables), or:

```bash
export VERCEL_TOKEN=...   # https://vercel.com/account/tokens
export UPSTASH_REDIS_REST_URL=...
export UPSTASH_REDIS_REST_TOKEN=...
node scripts/omnia-wire-upstash.mjs
```

Or via CLI:

```bash
npx vercel env add UPSTASH_REDIS_REST_URL production
npx vercel env add UPSTASH_REDIS_REST_TOKEN production
npx vercel env add UPSTASH_REDIS_REST_URL preview
npx vercel env add UPSTASH_REDIS_REST_TOKEN preview
```

Verify both keys exist for Production and Preview, then redeploy.

### 4. Optional Phase 1 API keys

From `.env.example` — unlock live upstream fetches without the full seed stack:

| Variable | Purpose |
|----------|---------|
| `GROQ_API_KEY` | AI summarization |
| `FINNHUB_API_KEY` | Stock quotes |
| `FRED_API_KEY` | Economic data |
| `EIA_API_KEY` | Energy data |

Skip for MVP: Clerk/Convex/Dodo, `WS_RELAY_*`, Mintlify, R2, Tauri.

### 5. Deploy production

```bash
npx vercel --prod --yes --scope sethrocks-projects
```

Or push to the Git branch connected to the project (auto-deploy on `main` if Git is linked).

### 6. Smoke checks

```bash
BASE=https://omnia-global-monitor.vercel.app

curl -sI "$BASE/" | head -5
curl -sI "$BASE/dashboard" | head -5
curl -sS "$BASE/api/health" | head -c 2000; echo
curl -sS "$BASE/api/bootstrap" | head -c 500; echo
```

Pass criteria:

| Check | Expect |
|-------|--------|
| `/` | HTML 200 |
| `/dashboard` | HTML 200 (or rewrite to dashboard) |
| `/api/health` | JSON; Redis reachable (not `REDIS_DOWN`) |
| `/api/bootstrap` | JSON payload (may be sparse until Phase 2 seeds) |

---

## Cursor MCP setup (Upstash)

Do **not** commit API keys or REST tokens to git. Configure locally in Cursor.

### Account ops — `@upstash/mcp-server`

Create an API key at [Upstash Console → Account → API Keys](https://console.upstash.com).

Add to Cursor `~/.cursor/mcp.json` (or project `.cursor/mcp.json` — keep secrets out of the repo):

```json
{
  "mcpServers": {
    "upstash": {
      "command": "npx",
      "args": [
        "-y",
        "@upstash/mcp-server@latest",
        "--email",
        "YOUR_UPSTASH_EMAIL",
        "--api-key",
        "YOUR_UPSTASH_API_KEY"
      ]
    }
  }
}
```

Example prompts:

- "Create a new Redis database in us-east-1"
- "List my databases sorted by memory usage"
- "Create a backup of this db"

Readonly API keys are supported; write tools are disabled when using one.

### Data plane — `@upstash/redis-mcp`

Uses the same REST credentials as the app:

```json
{
  "mcpServers": {
    "upstash-redis": {
      "command": "npx",
      "args": ["-y", "@upstash/redis-mcp"],
      "env": {
        "UPSTASH_REDIS_REST_URL": "https://YOUR_DB.upstash.io",
        "UPSTASH_REDIS_REST_TOKEN": "YOUR_REST_TOKEN"
      }
    }
  }
}
```

Example prompts:

- "Run KEYS seed-meta:* and show me freshness"
- "GET the bootstrap payload keys"
- "Pipeline: EXISTS UPSTASH health keys"

Docs: [Upstash MCP](https://upstash.com/docs/agent-resources/mcp) · [Upstash Redis MCP](https://upstash.com/docs/redis/sdks/mcp)

---

## Optional Neon (Postgres) — not for Redis

Only if you need the consumer-prices scrape pipeline later:

1. Provision Neon (Marketplace: `vercel integration add neon`, or Neon console / MCP `create_project`).
2. Set `DATABASE_URL` for the Railway/Docker `consumer-prices-core` service — **not** as a substitute for `UPSTASH_REDIS_*` on the Vercel app.
3. That sidecar still publishes snapshots to Redis via `UPSTASH_REDIS_REST_*`.

---

## Phase 2 — Near-parity (Railway seed / relay)

Vercel Edge cannot run long-lived WebSockets or continuous Playwright scrapers. Production parity needs a worker that writes into the **same** Upstash Redis.

### What to run

| Component | Entry | Purpose |
|-----------|-------|---------|
| AIS relay + inline seed loops | `scripts/ais-relay.cjs` | Ships, OpenSky (cloud IPs blocked), RSS proxy helpers, satellite TLEs, etc. |
| Seed scripts | `scripts/run-seeders.sh` / individual `scripts/seed-*.mjs` | Populate Redis snapshots + `seed-meta:*` for health |

See `SELF_HOSTING.md`, `ARCHITECTURE.md`, and `docs/relay-parameters.mdx`.

### Railway (or equivalent) setup sketch

1. Create a Railway service from this repo (Docker or Node).
2. Set env:
   - `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (same DB as Vercel)
   - `RELAY_SHARED_SECRET` (generate: `openssl rand -hex 32`)
   - Optional: `AISSTREAM_API_KEY`, `NASA_FIRMS_API_KEY`, `OPENAQ_API_KEY`, and other keys from `.env.example`
3. Run `scripts/ais-relay.cjs` as the long-lived process; schedule seed crons as additional services or cron jobs.
4. On Vercel, set `WS_RELAY_URL` + `RELAY_SHARED_SECRET` (+ `RELAY_AUTH_HEADER` if used) so Edge can call the relay.

Without Phase 2: the SPA and Edge still work; many intelligence panels stay empty/stale and `/api/health` may warn on missing `seed-meta:*`.

---

## Deployment status (2026-07-26)

| Item | Status |
|------|--------|
| Vercel project | **Live** — `omnia-global-monitor` (`prj_i4fnQiU0Q9iIVko9BznCwtwTXeja`) |
| Production URL | **https://omnia-global-monitor.vercel.app** |
| Team | `sethrocks-projects` |
| Git | Connected — production deploys from `CitizenCoped/worldmonitor` `main` |
| Current deploy | **Full WorldMonitor SPA** (Vite dashboard + Edge API) |
| Upstash Redis | **DB provisioned** via [start-redis](https://upstash.com/start-redis); **Vercel env not yet set** (health reports `REDIS_DOWN` until wired) |
| Redis claim URL | https://upstash.com/start-redis/console/29aa31ba-1cba-479a-b6b4-271be2ae4ef4 |
| Redis DB id | `29aa31ba-1cba-479a-b6b4-271be2ae4ef4` |
| Expires if unclaimed | **2026-07-29** |

### Wire Redis into Vercel (required for healthy API)

The SPA is live, but Edge handlers need project env vars. Pick one path:

**A — Dashboard (fastest, no CLI):**

1. Re-fetch credentials (safe to re-run; returns the same DB):

```bash
curl -sS -X POST \
  -H "Idempotency-Key: 29aa31ba-1cba-479a-b6b4-271be2ae4ef4" \
  https://upstash.com/start-redis
```

2. Open [Project → Settings → Environment Variables](https://vercel.com/sethrocks-projects/omnia-global-monitor/settings/environment-variables).
3. Add `UPSTASH_REDIS_REST_URL` = Endpoint and `UPSTASH_REDIS_REST_TOKEN` = Token for **Production** and **Preview**.
4. Redeploy Production (Deployments → ⋯ → Redeploy).

**B — Script (needs a Vercel token):**

1. Create a token at https://vercel.com/account/tokens
2. Export `VERCEL_TOKEN`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
3. Run: `node scripts/omnia-wire-upstash.mjs`

**C — Marketplace (permanent):**

```bash
npx vercel link --yes --scope sethrocks-projects --project omnia-global-monitor
npx vercel install upstash
```

### Claim Redis (keep past 2026-07-29)

Open https://upstash.com/start-redis/console/29aa31ba-1cba-479a-b6b4-271be2ae4ef4 → sign in → **Claim**. After claiming, paste the console REST URL/token into Vercel (or switch to Marketplace Upstash).

### Smoke after Redis is wired

```bash
BASE=https://omnia-global-monitor.vercel.app
curl -sS "$BASE/api/health?compact=1"
# expect not REDIS_DOWN once env is live
```

---

## Success criteria

- [x] Production URL on `omnia-global-monitor.vercel.app`
- [ ] `/api/health` sees Redis (not `REDIS_DOWN`) — **blocked on Vercel env wire-up above**
- [x] Full WorldMonitor dashboard HTML serves from git `main`
- [ ] Upstash MCP can list the DB and inspect keys (after local MCP config + claim)
- [x] This file (`buildguide.md`) is the single operator runbook
- [x] Full WorldMonitor SPA linked from git
- [ ] Redis claimed / Marketplace permanent DB (before 2026-07-29)

---

## Quick reference

| Item | Value |
|------|-------|
| Vercel project | `omnia-global-monitor` |
| Project ID | `prj_i4fnQiU0Q9iIVko9BznCwtwTXeja` |
| Production URL | https://omnia-global-monitor.vercel.app |
| Dashboard env | https://vercel.com/sethrocks-projects/omnia-global-monitor/settings/environment-variables |
| Team | `sethrocks-projects` |
| Redis | Upstash REST (`UPSTASH_REDIS_REST_*`) |
| Redis claim | https://upstash.com/start-redis/console/29aa31ba-1cba-479a-b6b4-271be2ae4ef4 |
| Wire script | `scripts/omnia-wire-upstash.mjs` |
| Config | `vercel.json`, `api/`, `server/_shared/redis.ts` |
| Seeds | Phase 2 — Railway + `scripts/ais-relay.cjs` / `scripts/run-seeders.sh` |
