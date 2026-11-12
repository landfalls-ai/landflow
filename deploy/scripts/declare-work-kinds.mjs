#!/usr/bin/env node
/**
 * Declares the work.* event kinds the activity integrations suggest (deploy/brain/work-kinds.json) on a Landflow
 * instance, through POST /api/usage/kinds. Safe to run again: a declared kind gets the catalogue's description and
 * fields (events already recorded stay).
 *
 *   node deploy/scripts/declare-work-kinds.mjs [url]      # default http://127.0.0.1:3000
 *
 * Signs in with LANDFLOW_API_KEY (Authorization: Bearer lf_…, needs workflows:write) when set, else with
 * LANDFLOW_OWNER_EMAIL and LANDFLOW_OWNER_PASSWORD (default: the development owner of deploy/.env.example).
 */
import { readFileSync } from 'node:fs';

const url = (process.argv[2] ?? process.env.LANDFLOW_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const catalogue = JSON.parse(readFileSync(new URL('../brain/work-kinds.json', import.meta.url), 'utf8'));

async function headers() {
  const base = { 'content-type': 'application/json' };
  if (process.env.LANDFLOW_API_KEY) return { ...base, authorization: `Bearer ${process.env.LANDFLOW_API_KEY}` };
  const response = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: base,
    body: JSON.stringify({ email: process.env.LANDFLOW_OWNER_EMAIL ?? 'owner@landflow.test', password: process.env.LANDFLOW_OWNER_PASSWORD ?? 'landflow-dev-only' }),
  });
  if (!response.ok) throw new Error(`Sign-in failed: HTTP ${response.status} ${await response.text()}`);
  const cookie = response.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return { ...base, cookie };
}

const auth = await headers();
let failed = 0;
for (const { kind, description } of catalogue.kinds) {
  const response = await fetch(`${url}/api/usage/kinds`, { method: 'POST', headers: auth, body: JSON.stringify({ kind, description, fields: catalogue.fields }) });
  const verb = response.status === 201 ? 'declared' : response.status === 200 ? 'updated ' : `failed (HTTP ${response.status}: ${await response.text()})`;
  if (!response.ok) failed++;
  console.log(`${verb}  ${kind}`);
}
process.exit(failed ? 1 : 0);
