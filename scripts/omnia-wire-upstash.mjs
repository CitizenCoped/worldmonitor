#!/usr/bin/env node
/**
 * Wire Upstash Redis REST credentials into the Omnia Vercel project.
 *
 * Usage:
 *   export VERCEL_TOKEN=...                 # https://vercel.com/account/tokens
 *   export UPSTASH_REDIS_REST_URL=...
 *   export UPSTASH_REDIS_REST_TOKEN=...
 *   node scripts/omnia-wire-upstash.mjs
 *
 * Or re-fetch an agent Redis DB then wire:
 *   curl -sS -X POST -H "Idempotency-Key: <db-uuid>" https://upstash.com/start-redis
 *   # parse Endpoint + Token, then export and run this script
 *
 * Optional:
 *   VERCEL_TEAM_ID   (default: team_PCWFPemgZnDsI9xhj7WVV5XC)
 *   VERCEL_PROJECT   (default: omnia-global-monitor)
 *   SKIP_REDEPLOY=1  skip triggering a production redeploy
 */
import { spawnSync } from 'node:child_process';

const TEAM_ID = process.env.VERCEL_TEAM_ID || 'team_PCWFPemgZnDsI9xhj7WVV5XC';
const PROJECT = process.env.VERCEL_PROJECT || 'omnia-global-monitor';
const TOKEN = process.env.VERCEL_TOKEN;
const URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function die(msg) {
  console.error(msg);
  process.exit(1);
}

if (!TOKEN) die('Missing VERCEL_TOKEN (create one at https://vercel.com/account/tokens)');
if (!URL || !REDIS_TOKEN) {
  die('Missing UPSTASH_REDIS_REST_URL and/or UPSTASH_REDIS_REST_TOKEN');
}

async function upsertEnv(key, value) {
  const endpoint = new URL(`https://api.vercel.com/v10/projects/${encodeURIComponent(PROJECT)}/env`);
  endpoint.searchParams.set('upsert', 'true');
  endpoint.searchParams.set('teamId', TEAM_ID);

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      key,
      value,
      type: 'encrypted',
      target: ['production', 'preview', 'development'],
    }),
  });

  const body = await resp.text();
  if (!resp.ok) {
    die(`Failed to set ${key}: HTTP ${resp.status}\n${body}`);
  }
  console.log(`Set ${key} for production/preview/development`);
}

async function redeploy() {
  if (process.env.SKIP_REDEPLOY === '1') {
    console.log('SKIP_REDEPLOY=1 — not triggering redeploy');
    return;
  }

  const endpoint = new URL('https://api.vercel.com/v13/deployments');
  endpoint.searchParams.set('teamId', TEAM_ID);
  endpoint.searchParams.set('forceNew', '1');

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: PROJECT,
      project: PROJECT,
      target: 'production',
      gitSource: {
        type: 'github',
        org: 'CitizenCoped',
        repo: 'worldmonitor',
        ref: 'main',
      },
    }),
  });

  const body = await resp.text();
  if (!resp.ok) {
    console.warn(`Redeploy via API failed (HTTP ${resp.status}). Trigger a redeploy from the Vercel dashboard or push an empty commit.`);
    console.warn(body.slice(0, 500));
    // Fall back to CLI if present
    const cli = spawnSync('npx', ['vercel', 'redeploy', '--yes', '--scope', 'sethrocks-projects'], {
      stdio: 'inherit',
      env: { ...process.env, VERCEL_ORG_ID: TEAM_ID },
    });
    if (cli.status !== 0) {
      die('Could not trigger redeploy automatically — redeploy manually after env is set.');
    }
    return;
  }
  console.log('Triggered production redeploy');
  console.log(body.slice(0, 400));
}

await upsertEnv('UPSTASH_REDIS_REST_URL', URL);
await upsertEnv('UPSTASH_REDIS_REST_TOKEN', REDIS_TOKEN);
await redeploy();
console.log('Done. Smoke: curl -sS "https://omnia-global-monitor.vercel.app/api/health?compact=1"');
