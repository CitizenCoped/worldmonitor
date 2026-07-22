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

### 3. Provision Upstash Redis (Marketplace)

Preferred (auto-wires env vars into the linked project):

```bash
npx vercel install upstash
# or:
npx vercel integration add upstash
```

Manual alternative:

1. Create a Redis DB at [console.upstash.com](https://console.upstash.com).
2. Copy REST URL + token.
3. Set on the Vercel project for Production and Preview:

```bash
npx vercel env add UPSTASH_REDIS_REST_URL production
npx vercel env add UPSTASH_REDIS_REST_TOKEN production
npx vercel env add UPSTASH_REDIS_REST_URL preview
npx vercel env add UPSTASH_REDIS_REST_TOKEN preview
```

Verify in the Vercel dashboard → Project → Settings → Environment Variables that both keys exist for Production and Preview.

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

## Deployment status (2026-07-22)

| Item | Status |
|------|--------|
| Vercel project | **Created** — `omnia-global-monitor` (`prj_i4fnQiU0Q9iIVko9BznCwtwTXeja`) |
| Production URL | **https://omnia-global-monitor.vercel.app** |
| Team | `sethrocks-projects` |
| Current deploy | MVP scaffold (home + dashboard placeholders + `/api/health` + `/api/bootstrap`) |
| Upstash Redis | **Provisioned** via [Upstash agent start-redis](https://upstash.com/start-redis) (temporary until claimed) |
| Redis claim URL | https://upstash.com/start-redis/console/1c5f55a0-8881-4bdf-8b42-acc9c926cce7 |
| Redis DB id | `1c5f55a0-8881-4bdf-8b42-acc9c926cce7` |
| Expires if unclaimed | **2026-07-25** |

### Claim Redis (required to keep it)

Open the claim URL above, sign in to Upstash, and click **Claim**. After claiming:

1. Copy REST URL + token from the Upstash console.
2. Set them as Vercel project env vars (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`) for Production + Preview via Marketplace or dashboard.
3. Redeploy. Prefer Marketplace (`vercel install upstash`) for a permanent billed/free-tier DB instead of the 3-day agent DB when ready.

### Promote scaffold → full WorldMonitor SPA

The live site is an MVP scaffold so the project hostname and Redis path could ship without a Vercel CLI login in this agent environment. To serve the real dashboard:

1. In Vercel → Project → Settings → Git, connect `CitizenCoped/worldmonitor` (or your fork).
2. Ensure `UPSTASH_REDIS_REST_*` are set on the project (Marketplace or claimed agent DB).
3. Deploy from `main` (build: `npm run build`, root directory `.`, Node 22+).
4. Confirm `/dashboard` serves the Vite SPA and `/api/bootstrap` hydrates from seed keys (Phase 2 seeds still optional).

---

## Success criteria

- [x] Production URL on `omnia-global-monitor.vercel.app`
- [x] `/api/health` sees Redis (`redis: "up"`) after agent Redis wiring
- [x] Dashboard HTML serves; Edge RPCs respond
- [ ] Upstash MCP can list the DB and inspect keys (after local MCP config + claim)
- [x] This file (`buildguide.md`) is the single operator runbook
- [ ] Full WorldMonitor SPA linked from git (follow promote steps above)
- [ ] Redis claimed / Marketplace permanent DB (before 2026-07-25)

---

## Quick reference

| Item | Value |
|------|-------|
| Vercel project | `omnia-global-monitor` |
| Project ID | `prj_i4fnQiU0Q9iIVko9BznCwtwTXeja` |
| Production URL | https://omnia-global-monitor.vercel.app |
| Team | `sethrocks-projects` |
| Redis | Upstash REST (`UPSTASH_REDIS_REST_*`) |
| Redis claim | https://upstash.com/start-redis/console/1c5f55a0-8881-4bdf-8b42-acc9c926cce7 |
| Config | `vercel.json`, `api/`, `server/_shared/redis.ts` |
| Seeds | Phase 2 — Railway + `scripts/ais-relay.cjs` / `scripts/run-seeders.sh` |
