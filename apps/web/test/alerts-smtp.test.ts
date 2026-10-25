/**
 * Failure alerts by email through a real SMTP server (opt-in; Mailpit must be running):
 *
 *   docker compose -p landflow-infra -f deploy/compose.infra.yml up -d mailpit
 *   LANDFLOW_INTEGRATION=smtp npx vitest run test/alerts-smtp.test.ts
 *
 * The host's SMTP settings (LANDFLOW_SMTP_HOST/PORT, as invites use) point at Mailpit; a failed run sends the alert
 * to two addresses, and Mailpit's API (http://127.0.0.1:58025/api/v1) shows both with the execution link. The dev
 * Mailpit can take ~8 s to greet a connection (a reverse DNS lookup under Docker Desktop), hence the long timeouts.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ExecutionRecord } from '@/lib/shared/types';

const enabled = Boolean(process.env.LANDFLOW_INTEGRATION?.split(',').includes('smtp'));
const MAILPIT = process.env.LANDFLOW_MAILPIT_URL ?? 'http://127.0.0.1:58025';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-alerts-smtp-'));
const ENV = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_PUBLIC_URL: 'http://landflow.test',
  LANDFLOW_SMTP_HOST: process.env.LANDFLOW_SMTP_HOST ?? '127.0.0.1',
  LANDFLOW_SMTP_PORT: process.env.LANDFLOW_SMTP_PORT ?? '51025',
  LANDFLOW_SMTP_FROM: 'Landflow Alerts <alerts@landflow.test>',
};
const previousEnv = { ...process.env };

interface MailpitSummary {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

async function mailsTo(address: string, count: number): Promise<MailpitSummary[]> {
  const end = Date.now() + 10_000;
  for (;;) {
    const response = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}&limit=10`);
    const { messages } = (await response.json()) as { messages: MailpitSummary[] };
    if (messages.length >= count || Date.now() > end) return messages;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe.skipIf(!enabled)('failure alerts over SMTP (Mailpit)', async () => {
  Object.assign(process.env, ENV);
  const { alerts } = await import('@/lib/server/alerts/service');
  const { alertStore } = await import('@/lib/server/alerts/store');
  const { setMailTransport } = await import('@/lib/server/auth/mail');
  setMailTransport(undefined);

  afterAll(() => {
    alerts.stop();
    for (const key of Object.keys(ENV)) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  const tag = Math.random().toString(36).slice(2, 10);
  const ops = `ops-${tag}@landflow.test`;
  const oncall = `oncall-${tag}@landflow.test`;

  it('emails a failed run to every address, with the execution link', async () => {
    const channel = alertStore.createChannel({ name: 'Ops', kind: 'email', config: { to: `${ops}, On call <${oncall}>` } });
    alertStore.createRule({ name: 'All failures', enabled: true, workflows: { mode: 'all' }, events: ['failed'], channelIds: [channel.id], throttleMinutes: 0 });
    const now = new Date().toISOString();
    const record: ExecutionRecord = {
      executionId: `exec_smtp_${tag}`,
      workflowId: 'wf_smtp',
      workflowName: `Nightly export ${tag}`,
      mode: 'trigger',
      status: 'error',
      startedAt: now,
      finishedAt: now,
      durationMs: 5,
      runData: {},
      executionOrder: ['Upload'],
      error: { message: 'S3 answered 403 AccessDenied', nodeId: 'Upload', nodeName: 'Upload to S3' },
    };
    await alerts.finished(record);
    expect(alertStore.channel(channel.id)!.lastDelivery).toMatchObject({ ok: true, message: `Sent to ${ops}, On call <${oncall}>` });

    for (const address of [ops, oncall]) {
      const [summary] = await mailsTo(address, 1);
      expect(summary, `a message to ${address}`).toBeDefined();
      expect(summary.Subject).toBe(`Failed: Nightly export ${tag}`);
      const detail = (await (await fetch(`${MAILPIT}/api/v1/message/${summary.ID}`)).json()) as { Text: string; HTML: string; From: { Address: string } };
      expect(detail.From.Address).toBe('alerts@landflow.test');
      expect(detail.Text).toContain('Failed node: Upload to S3');
      expect(detail.Text).toContain('Error: S3 answered 403 AccessDenied');
      expect(detail.Text).toContain(`http://landflow.test/workflows/wf_smtp/executions/exec_smtp_${tag}`);
      expect(detail.HTML).toContain(`href="http://landflow.test/workflows/wf_smtp/executions/exec_smtp_${tag}"`);
    }
  }, 60_000);

  it('sends a test alert and reports an unreachable server', async () => {
    const channel = alertStore.createChannel({ name: 'Test', kind: 'email', config: { to: `test-${tag}@landflow.test` } });
    expect(await alerts.test(channel.id)).toMatchObject({ ok: true });
    const [summary] = await mailsTo(`test-${tag}@landflow.test`, 1);
    expect(summary.Subject).toBe('Test alert from Landflow');

    process.env.LANDFLOW_SMTP_PORT = '9';
    try {
      const failed = await alerts.test(channel.id);
      expect(failed.ok).toBe(false);
      expect(failed.message).toMatch(/ECONNREFUSED|closed|timed out/);
    } finally {
      process.env.LANDFLOW_SMTP_PORT = ENV.LANDFLOW_SMTP_PORT;
    }
  }, 60_000);
});
