/**
 * Before the specs: refuse unless the flag names `browser`, note what `apps/web/.data` looks like (the teardown checks it
 * is untouched), start the scratch host and warm the pages that need no sign-in. The host's URL goes to the workers in
 * `LANDFLOW_E2E_URL`. The fakes are not here: a worker starts its own (fixtures.ts), so no test shares one.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { requireBrowserTier } from './gate';
import { hasProductionBuild, LIVE_DATA_DIR, startScratchHost, type ScratchHost } from './scratch-host';

declare global {
  // eslint-disable-next-line no-var
  var __landflowE2E: { host?: ScratchHost; prodHost?: ScratchHost; liveDataStamp?: string } | undefined;
}

/** The newest modification time under a directory and its entry count: a change to the live data directory shows in either. */
export function dataStamp(dir: string = LIVE_DATA_DIR): string {
  if (!existsSync(dir)) return 'absent';
  let newest = 0;
  let count = 0;
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const stat = statSync(full);
      count += 1;
      newest = Math.max(newest, stat.mtimeMs);
      if (stat.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return `${count}:${newest}`;
}

export default async function globalSetup(): Promise<void> {
  requireBrowserTier();
  const state: NonNullable<typeof globalThis.__landflowE2E> = (globalThis.__landflowE2E = { liveDataStamp: dataStamp() });
  state.host = await startScratchHost();
  process.env.LANDFLOW_E2E_URL = state.host.url;
  // Compile the sign-in pages now so the first spec does not spend its budget on it.
  for (const path of ['/login', '/setup']) await fetch(`${state.host.url}${path}`, { redirect: 'manual' }).catch(() => undefined);

  // The CSP smoke test wants a production build (`LANDFLOW_E2E_PROD=1` and `pnpm build` first); without one it runs on the dev host, CSP enforced.
  if (process.env.LANDFLOW_E2E_PROD === '1') {
    if (!hasProductionBuild()) throw new Error('LANDFLOW_E2E_PROD=1 needs a production build: run `pnpm --filter @landflow/web build` first.');
    // The production profile refuses the development password and an unset registry secret: a throwaway password for this run only.
    process.env.LANDFLOW_E2E_PROD_PASSWORD = `e2e-${randomBytes(12).toString('hex')}`;
    state.prodHost = await startScratchHost({ prod: true, env: { LANDFLOW_OWNER_EMAIL: 'owner@landflow.test', LANDFLOW_OWNER_PASSWORD: process.env.LANDFLOW_E2E_PROD_PASSWORD, LANDFLOW_REGISTRY_OPEN: 'true' } });
    process.env.LANDFLOW_E2E_PROD_URL = state.prodHost.url;
  }
}
