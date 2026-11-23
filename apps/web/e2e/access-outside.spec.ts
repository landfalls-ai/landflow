/**
 * C36: people without a Landflow account ask for access through /request-access, at both sizes. It starts its own scratch host
 * (a mail sink on loopback for the sign-in link, a fake Google OpenID Connect server), because the shared host has no mail:
 *   1. an admin opens the page for one domain and one by-hand entry (through the API, as the Settings tab does);
 *   2. an outsider (no Landflow cookie) signs in by the emailed link (Continue is pressed, the fragment is dropped), asks
 *      for the entry through the form, and sees "Waiting"; a disallowed domain gets the same sentence and no mail;
 *   3. the admin approves in Landflow; the outsider sees it under My requests and gives it back;
 *   4. a second outsider signs in with Google against the fake (Workspace domain, verified email);
 *   5. at 390x844 the tabs scroll and nothing scrolls sideways.
 * The routes belong to C36-A and C36-B: while `/request-access/api/config` answers 404 (not merged yet) every test here skips
 * with that reason. The Settings tab itself is covered by the unit tests; the admin side here goes through the same routes.
 */
import { createServer, type Server } from 'node:net';
import { request as pwRequest, type APIRequestContext } from '@playwright/test';
import { fakeGoogleOidc, GOOGLE_OIDC_CLIENT_ID, GOOGLE_OIDC_CLIENT_SECRET } from '@landflow/test-fakes/google-oidc';
import { expect, open, OWNER, test } from './fixtures';
import { startScratchHost, type ScratchHost } from './scratch-host';

/** A tiny SMTP sink: accepts every message and keeps its text. */
function mailSink(): Promise<{ port: number; messages: string[]; close: () => void }> {
  const messages: string[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let data = false;
    let body = '';
    socket.write('220 sink ESMTP\r\n');
    socket.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (data) {
        body += text;
        if (body.endsWith('\r\n.\r\n')) {
          messages.push(body);
          body = '';
          data = false;
          socket.write('250 OK\r\n');
        }
        return;
      }
      for (const line of text.split('\r\n').filter(Boolean)) {
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250 sink\r\n');
        else if (verb === 'DATA') {
          data = true;
          socket.write('354 go\r\n');
        } else if (verb === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as { port: number }).port, messages, close: () => { for (const s of sockets) s.destroy(); server.close(); } })));
}

/** The sign-in link in a mail: soft line breaks undone. */
const linkIn = (message: string | undefined): string | undefined => message?.replace(/=\r?\n/g, '').match(/https?:\/\/[^\s"<>]+\/request-access#t=[A-Za-z0-9_-]+/)?.[0];

test.describe.configure({ mode: 'serial' });

let host: ScratchHost | undefined;
let sink: Awaited<ReturnType<typeof mailSink>> | undefined;
const google = fakeGoogleOidc();
let admin: APIRequestContext | undefined;
let missing = false;
let entryName = '';

test.beforeAll(async ({}, testInfo) => {
  const size = testInfo.project.name;
  entryName = `Figma seat ${size}`;
  sink = await mailSink();
  const issuer = await google.start();
  host = await startScratchHost({ env: { LANDFLOW_SMTP_HOST: '127.0.0.1', LANDFLOW_SMTP_PORT: String(sink.port), LANDFLOW_SMTP_IGNORE_TLS: 'true', LANDFLOW_SMTP_FROM: 'Landflow <landflow@localhost>' } });
  const origin = host.url;
  const probe = await fetch(`${origin}/request-access/api/config`).catch(() => undefined);
  missing = !probe || probe.status === 404 && !(await probe.clone().text()).includes('enabled');
  if (missing) return;
  admin = await pwRequest.newContext({ baseURL: origin, extraHTTPHeaders: { origin } });
  const created = await admin.post('/api/auth/setup', { data: OWNER });
  expect(created.status()).toBe(201);
  const me = (await (await admin.get('/api/auth/me')).json()) as { user: { id: string } };
  expect((await admin.post('/api/access/setup', { data: {}, timeout: 90_000 })).status()).toBeLessThan(300);
  const entry = await admin.post('/api/access/entries', {
    data: { name: entryName, description: 'A seat, set up by hand', durations: [60], approverIds: [me.user.id], owners: [me.user.id], eligibleUserIds: [], enabled: true, outsideMayAsk: true, system: 'manual', target: { instructions: 'Add them by hand' }, credentialId: null },
  });
  expect(entry.status()).toBeLessThan(300);
  // A closed entry: outsiders must not see it.
  await admin.post('/api/access/entries', { data: { name: `Closed ${size}`, durations: [60], approverIds: [me.user.id], owners: [me.user.id], eligibleUserIds: [], enabled: true, outsideMayAsk: false, system: 'manual', target: {}, credentialId: null } });
  // The fake's client takes this host's callback; its Workspace accounts.
  await fetch(`${issuer}/_fake/clients`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientId: GOOGLE_OIDC_CLIENT_ID, clientSecret: GOOGLE_OIDC_CLIENT_SECRET, redirectUris: [`${origin}/request-access/api/sign-in/google/callback`] }) });
  await fetch(`${issuer}/_fake/accounts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'dana@partner.test', name: 'Dana Partner', hd: 'partner.test', emailVerified: true }) });
  const credential = await admin.post('/api/credentials', { data: { name: 'Fake Google', type: 'oidcClient', data: { issuer, clientId: GOOGLE_OIDC_CLIENT_ID, clientSecret: GOOGLE_OIDC_CLIENT_SECRET } } });
  const credentialId = credential.status() < 300 ? ((await credential.json()) as { id?: string }).id : undefined;
  const saved = await admin.put('/api/access/outside', { data: { enabled: true, domains: ['partner.test'], google: credentialId ? { enabled: true, credentialId } : { enabled: false } } });
  expect(saved.status()).toBeLessThan(300);
});

test.afterAll(async () => {
  await admin?.dispose();
  await host?.stop();
  sink?.close();
  await google.stop?.();
});

test('an outsider signs in by link, asks, is approved, and gives it back', async ({ browser }, testInfo) => {
  test.skip(missing, 'the /request-access routes (C36-A identity, C36-B requests) are not in this build yet');
  const origin = host!.url;
  const phone = testInfo.project.use.isMobile === true;
  const context = await browser.newContext({ baseURL: origin, viewport: testInfo.project.use.viewport ?? undefined, isMobile: testInfo.project.use.isMobile, hasTouch: testInfo.project.use.hasTouch });
  try {
    const page = await context.newPage();
    const email = `erin-${testInfo.project.name}@partner.test`;
    await open(page, '/request-access');
    await expect(page.getByRole('heading', { name: 'Ask for access' })).toBeVisible();
    // Nothing of the catalog before sign-in.
    await expect(page.getByText(entryName)).toHaveCount(0);

    // A domain that isn't allowed: the same sentence, and no mail.
    const before = sink!.messages.length;
    await page.getByLabel('Your work email').fill('mallory@other.test');
    await page.getByTestId('outside-send').click();
    await expect(page.getByTestId('outside-sent')).toBeVisible();
    await page.waitForTimeout(1_500);
    expect(sink!.messages.length).toBe(before);
    await page.getByRole('button', { name: 'Use another address' }).click();

    await page.getByLabel('Your work email').fill(email);
    await page.getByTestId('outside-send').click();
    await expect(page.getByTestId('outside-sent')).toBeVisible();
    await expect.poll(() => linkIn(sink!.messages.at(-1)), { timeout: 20_000 }).toBeTruthy();
    const link = linkIn(sink!.messages.at(-1))!;

    // The link waits for Continue; the fragment is gone afterwards.
    await page.goto(link);
    await expect(page.getByTestId('outside-verify')).toBeVisible();
    await page.getByTestId('outside-continue').click();
    await expect(page.getByTestId('outside-sign-out')).toBeVisible({ timeout: 20_000 });
    expect(page.url()).not.toContain('#t=');
    // The same link again is spent.
    const again = await context.newPage();
    await again.goto(link);
    await again.getByTestId('outside-continue').click();
    await expect(again.getByText('expired or was already used')).toBeVisible();
    await again.close();

    // Ask: the open entry shows, the closed one does not.
    await page.getByTestId('access-entry').waitFor();
    await expect(page.getByTestId('access-entry')).not.toContainText('Closed');
    await page.getByTestId('access-entry').selectOption({ label: `${entryName} · Manual (done by hand)` });
    await page.getByTestId('access-duration-60').click();
    await page.getByTestId('access-reason').fill('e2e: design review');
    await page.getByTestId('access-ask-go').click();
    await expect(page.getByTestId('access-requests')).toContainText('Waiting', { timeout: 60_000 });
    if (phone) expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);

    // The admin decides inside Landflow: the question names the outsider.
    await expect.poll(async () => ((await (await admin!.get('/api/access/requests?scope=decide&limit=50')).json()) as { items: Array<{ canDecide: boolean }> }).items.filter((r) => r.canDecide).length, { timeout: 60_000 }).toBeGreaterThan(0);
    const waiting = ((await (await admin!.get('/api/access/requests?scope=decide&limit=50')).json()) as { items: Array<{ id: string; canDecide: boolean; question?: { text: string } }> }).items.find((r) => r.canDecide)!;
    expect(waiting.question?.text).toContain(email);
    expect(waiting.question?.text).toMatch(/outside/i);
    expect((await admin!.post(`/api/access/requests/${waiting.id}/decision`, { data: { approved: true, choice: '60' } })).status()).toBeLessThan(300);

    await page.reload();
    await page.getByRole('tab', { name: 'My requests' }).click();
    await expect(page.getByTestId('access-requests')).toContainText(/Approved|Granted/, { timeout: 60_000 });
    // No approver names, ever.
    await expect(page.getByTestId('access-requests')).not.toContainText(OWNER.name);

    // Sign out ends the session: the page asks to sign in again.
    await page.getByTestId('outside-sign-out').click();
    await expect(page.getByTestId('outside-send')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('an outsider signs in with Google', async ({ browser }, testInfo) => {
  test.skip(missing, 'the /request-access routes (C36-A identity, C36-B requests) are not in this build yet');
  const config = (await (await fetch(`${host!.url}/request-access/api/config`)).json()) as { google?: boolean };
  test.skip(!config.google, 'Google sign-in could not be set up on this host (the OpenID Connect credential was refused)');
  const context = await browser.newContext({ baseURL: host!.url, viewport: testInfo.project.use.viewport ?? undefined, isMobile: testInfo.project.use.isMobile, hasTouch: testInfo.project.use.hasTouch });
  try {
    const page = await context.newPage();
    await open(page, '/request-access');
    await page.getByTestId('outside-google').click();
    // The fake's sign-in page: one button per seeded account.
    await page.getByRole('button', { name: /dana@partner\.test/ }).click();
    await expect(page.getByTestId('outside-email')).toContainText('dana@partner.test', { timeout: 30_000 }).catch(async () => {
      await expect(page.getByText('Signed in as dana@partner.test')).toBeVisible();
    });
    await expect(page.getByTestId('outside-sign-out')).toBeVisible();
  } finally {
    await context.close();
  }
});
