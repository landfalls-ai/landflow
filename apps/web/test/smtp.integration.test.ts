/**
 * Invites and password resets through a real SMTP server: Mailpit from the infra stack (docs/deployment.md), SMTP on
 * 127.0.0.1:51025, its API on http://127.0.0.1:58025. The messages are read back from Mailpit's API and their links
 * followed. Run with LANDFLOW_INTEGRATION=smtp (LANDFLOW_TEST_SMTP_PORT / LANDFLOW_TEST_MAILPIT_URL to point elsewhere).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const enabled = (process.env.LANDFLOW_INTEGRATION ?? '').split(',').includes('smtp');
const MAILPIT = process.env.LANDFLOW_TEST_MAILPIT_URL ?? 'http://127.0.0.1:58025';
const BASE = 'http://localhost:3000';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-smtp-it-'));
const ENV: Record<string, string> = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_SMTP_HOST: '127.0.0.1',
  LANDFLOW_SMTP_PORT: process.env.LANDFLOW_TEST_SMTP_PORT ?? '51025',
  LANDFLOW_SMTP_FROM: 'Landflow Tests <landflow@landflow.test>',
};
const previousEnv = { ...process.env };

type Route = (request: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
type MailpitMessage = { ID: string; Subject: string; From: { Address: string; Name: string }; To: { Address: string }[] };

/** The newest message Mailpit has for `to` (waits up to 10 s for it to arrive). */
async function waitForMail(to: string): Promise<{ summary: MailpitMessage; text: string; html: string }> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const found = (await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`)).json()) as { messages?: MailpitMessage[] };
    const summary = found.messages?.[0];
    if (summary) {
      const full = (await (await fetch(`${MAILPIT}/api/v1/message/${summary.ID}`)).json()) as { Text: string; HTML: string };
      return { summary, text: full.Text, html: full.HTML };
    }
    if (Date.now() > deadline) throw new Error(`No mail for ${to} in Mailpit`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// Mailpit in Docker Desktop can take ~8 s to greet a new connection (a reverse DNS lookup), so allow a minute per test.
describe.skipIf(!enabled)('email through SMTP (LANDFLOW_INTEGRATION=smtp, Mailpit)', { timeout: 60_000 }, () => {
  let auth: typeof import('@/lib/server/auth');
  let mail: typeof import('@/lib/server/auth/mail');
  let ownerSession = '';
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    auth = await import('@/lib/server/auth');
    mail = await import('@/lib/server/auth/mail');
    auth.disableTestAuth();
    const owner = await auth.createOwner({ email: `owner-${run}@landflow.test`, name: 'Olive Owner', password: 'owner-password' });
    ownerSession = auth.createSession(owner, 'password').token;
  });

  afterAll(() => {
    auth?.enableTestAuth();
    for (const key of Object.keys(ENV)) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  it('sends a plain message with the configured From', async () => {
    const to = `plain-${run}@landflow.test`;
    await mail.sendMail({ to, subject: `Hello ${run} – ünïcödé`, text: 'Line one\n.\nLine three (a lone dot above)' });
    const { summary, text } = await waitForMail(to);
    expect(summary.Subject).toBe(`Hello ${run} – ünïcödé`);
    expect(summary.From).toMatchObject({ Address: 'landflow@landflow.test', Name: 'Landflow Tests' });
    expect(text).toContain('Line one\n.\nLine three');
  });

  it('emails an invite; its link creates the account', async () => {
    const invitesRoute = await import('@/app/api/users/invites/route');
    const inviteRoute = await import('@/app/api/auth/invites/[token]/route');
    const to = `invitee-${run}@landflow.test`;
    const response = await (invitesRoute.POST as Route)(
      new Request(`${BASE}/api/users/invites`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: `landflow_session=${ownerSession}` }, body: JSON.stringify({ email: to, role: 'member' }) }),
    );
    const body = await response.json();
    expect(response.status).toBe(201);
    expect(body.emailed).toBe(true);

    const { summary, text, html } = await waitForMail(to);
    expect(summary.Subject).toMatch(/invited/i);
    expect(text).toContain('Olive Owner');
    expect(text).toContain(body.link);
    expect(html).toContain(body.link);

    const token = /\/invite\/([A-Za-z0-9_-]+)/.exec(text)![1];
    const accepted = await (inviteRoute.POST as Route)(
      new Request(`${BASE}/api/auth/invites/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Ivy', password: 'ivy-password' }) }),
      { params: Promise.resolve({ token }) },
    );
    expect(accepted.status).toBe(201);
    expect((await accepted.json()).user).toMatchObject({ email: to, role: 'member' });
  });

  it('emails a password reset; its link sets the new password', async () => {
    const forgotRoute = await import('@/app/api/auth/password/forgot/route');
    const resetRoute = await import('@/app/api/auth/password/reset/route');
    const loginRoute = await import('@/app/api/auth/login/route');
    const to = `resetter-${run}@landflow.test`;
    await auth.createUser({ email: to, name: 'Rae', role: 'member', password: 'old-password' });

    const asked = await (forgotRoute.POST as Route)(new Request(`${BASE}/api/auth/password/forgot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: to }) }));
    expect(asked.status).toBe(200);
    const { summary, text } = await waitForMail(to);
    expect(summary.Subject).toMatch(/reset/i);
    const token = /\/reset-password\/([A-Za-z0-9_-]+)/.exec(text)![1];

    const reset = await (resetRoute.POST as Route)(new Request(`${BASE}/api/auth/password/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, password: 'new-password' }) }));
    expect(reset.status).toBe(200);
    const login = await (loginRoute.POST as Route)(new Request(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: to, password: 'new-password' }) }));
    expect(login.status).toBe(200);
  });
});
