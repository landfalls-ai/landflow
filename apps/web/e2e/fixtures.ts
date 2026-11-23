/**
 * The browser tier's `test`: every spec gets
 *   - `baseURL` of the scratch host;
 *   - a loopback guard: a request to any host but localhost/127.0.0.1 is aborted and fails the test afterwards (FR-8);
 *   - `violations`: the page's `securitypolicyviolation` events, collected from before the first script runs;
 *   - `signedIn`: a page signed in as the owner the first flow created (through the API, so a spec does not repeat the sign-in form);
 *   - `upstream`: a worker's own stateful fake (a recording echo server) for flows that call out.
 * Helpers: `open` (a page, waited until it hydrated), `seedWorkflow` (a workflow through the API, run once).
 */
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { defineFake, type Fake } from '@landflow/test-fakes';

export { expect };

/** The development owner (deploy/.env.example); the setup flow creates it. */
export const OWNER = { name: 'Owner', email: 'owner@landflow.test', password: 'landflow-dev-only' } as const;

/** Everything the page tried to load from outside loopback, per context. */
const blocked = new WeakMap<BrowserContext, string[]>();

interface Echo {
  calls: Array<{ method: string; path: string; headers: Record<string, string>; body: unknown }>;
}

/** A stateful echo upstream: it keeps each call it receives, and answers `{ ok: true, echo }` to a caller with the token. */
export const echoUpstream = (): Fake<Echo> =>
  defineFake<Echo>({
    name: 'upstream',
    token: 'e2e-upstream-token',
    // A header-auth credential: the value is sent in `x-api-key`.
    auth: (request, token) => request.headers['x-api-key'] === token,
    initial: () => ({ calls: [] }),
    routes: (state, request) => {
      state.calls.push({ method: request.method, path: request.path, headers: Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k, String(v)])), body: request.body });
      return { body: { ok: true, echo: request.path } };
    },
  });

export interface TierFixtures {
  violations: () => Promise<string[]>;
  signedIn: Page;
  upstream: Fake<Echo>;
}

export const test = base.extend<TierFixtures & { _guard: void }, { workerUpstream: Fake<Echo> }>({
  baseURL: async ({}, use) => {
    const url = process.env.LANDFLOW_E2E_URL;
    if (!url) throw new Error('LANDFLOW_E2E_URL is not set: the browser tier starts its host in global-setup (LANDFLOW_INTEGRATION=browser).');
    await use(url);
  },

  _guard: [
    async ({ context }, use) => {
      const seen: string[] = [];
      blocked.set(context, seen);
      await context.route('**/*', (route) => {
        const { hostname, protocol } = new URL(route.request().url());
        if (['localhost', '127.0.0.1', '[::1]', ''].includes(hostname) || protocol === 'data:' || protocol === 'blob:') return route.continue();
        seen.push(route.request().url());
        return route.abort('blockedbyclient');
      });
      await context.addInitScript(() => {
        const w = window as unknown as { __cspViolations?: string[] };
        w.__cspViolations = [];
        document.addEventListener('securitypolicyviolation', (event) => w.__cspViolations?.push(`${event.violatedDirective} ${event.blockedURI}`));
      });
      await use();
      expect(seen, 'requests that left loopback').toEqual([]);
    },
    { auto: true },
  ],

  violations: async ({ page }, use) => {
    await use(() => page.evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? []));
  },

  signedIn: async ({ page, context, baseURL }, use) => {
    const response = await context.request.post(`${baseURL}/api/auth/login`, { data: { email: OWNER.email, password: OWNER.password }, headers: { origin: baseURL as string } });
    expect(response.status(), 'sign in as the owner (owner-setup runs first)').toBe(200);
    await use(page);
  },

  workerUpstream: [
    async ({}, use) => {
      const fake = echoUpstream();
      await fake.start();
      await use(fake);
      await fake.stop();
    },
    { scope: 'worker' },
  ],
  upstream: async ({ workerUpstream }, use) => {
    workerUpstream.reset();
    await use(workerUpstream);
  },
});

/**
 * Open a path and wait until the page hydrated. `next dev` serves the HTML first and the scripts after: a form filled
 * before they run is reset by React and submits empty, so a spec waits for the network to settle.
 */
export async function open(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: 'networkidle' });
}

/** A two-step workflow through the API (Manual Trigger, Edit Fields: greeting = "Hello"), run once; resolves to its ids. */
export async function seedWorkflow(page: Page, name: string, host: string = process.env.LANDFLOW_E2E_URL as string): Promise<{ workflowId: string; executionId: string }> {
  const request = page.context().request;
  const origin = new URL(host).origin;
  const headers = { origin };
  const created = await request.post(`${origin}/api/workflows`, {
    headers,
    data: {
      name,
      nodes: [
        { id: 't', name: 'Manual Trigger', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        { id: 's', name: 'Edit Fields', type: 'core.set', typeVersion: 1, position: [220, 0], parameters: { mode: 'manual', fields: { values: [{ name: 'greeting', type: 'string', value: 'Hello' }] }, includeOtherFields: true, splitArray: '' } },
      ],
      connections: [{ id: 'e1', type: 'main', source: 't', sourceIndex: 0, target: 's', targetIndex: 0 }],
    },
  });
  expect(created.status()).toBe(201);
  const { workflow } = (await created.json()) as { workflow: { id: string } };
  const run = await request.post(`${origin}/api/workflows/${workflow.id}/run`, { headers, data: {} });
  const stream = await run.text();
  const executionId = /"executionId":"(ex_[^"]+)"/.exec(stream)?.[1];
  expect(executionId, 'the run stream names its execution').toBeTruthy();
  expect(stream).toContain('"type":"execution.finished"');
  return { workflowId: workflow.id, executionId: executionId as string };
}
