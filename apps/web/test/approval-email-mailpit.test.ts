/**
 * Approvals by email through the host's real SMTP client into the infra Mailpit (`landflow-infra-mailpit`, SMTP 51025, API 58025):
 * an AI Agent node waits for a tool approval, the emailed link is read back from Mailpit's API and decides. Skipped when Mailpit
 * is not reachable (docker compose -f deploy/compose.infra.yml up -d mailpit).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import { startFakeModels } from './fake-ai-services';

vi.setConfig({ testTimeout: 30_000 });

const SMTP_PORT = process.env.LANDFLOW_SMTP_PORT ?? '51025';
const API = `http://127.0.0.1:${process.env.LANDFLOW_MAIL_UI_PORT ?? '58025'}`;
const reachable = await fetch(`${API}/api/v1/info`, { signal: AbortSignal.timeout(1_500) }).then((r) => r.ok, () => false);

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-approval-mail-'));
const ENV = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_PUBLIC_URL: 'https://landflow.test',
  LANDFLOW_SMTP_HOST: '127.0.0.1',
  LANDFLOW_SMTP_PORT: SMTP_PORT,
  LANDFLOW_SMTP_IGNORE_TLS: 'true',
  LANDFLOW_SMTP_FROM: 'Landflow <approvals@landflow.test>',
};
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { runWorkflow } = await import('@/lib/server/runner');
const emailRoute = await import('@/app/api/approvals/email/[token]/route');
registry.registerBuiltin(corePlugin);

const models = reachable ? await startFakeModels() : undefined;
afterAll(async () => {
  await models?.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const node = (id: string, type: string, parameters: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters, ...extra });
const edge = (source: string, target: string, type: 'main' | 'ai_languageModel' | 'ai_tool' = 'main') => ({ id: `${source}-${target}`, type, source, target, sourceIndex: 0, targetIndex: 0 });

describe.skipIf(!reachable)('approval emails through Mailpit', () => {
  it('delivers the links over SMTP and the approve link resumes the waiting execution', async () => {
    const address = `approver-${Date.now()}@landflow.test`;
    const openAi = credentials.create({ name: 'Fake OpenAI', type: 'core.openAiApi', data: { apiKey: 'sk-test', baseUrl: models!.url } });
    const workflow: Workflow = {
      id: 'wf_mailpit_approval',
      name: 'Mailpit approvals',
      nodes: [
        node('Start', 'core.manualTrigger'),
        node('Agent', 'core.aiAgent', { prompt: 'What is 6*7?', requireApproval: 'all', approvalChannel: 'email', approvalEmails: address }),
        node('Model', 'core.openAiChatModel', { model: 'gpt-test' }, { credentials: { openAiApi: { id: openAi.id, name: openAi.name } } }),
        node('Calculator', 'core.calculatorTool'),
      ],
      connections: [edge('Start', 'Agent'), edge('Model', 'Agent', 'ai_languageModel'), edge('Calculator', 'Agent', 'ai_tool')],
    };
    store.saveWorkflow(workflow);
    const waiting = await runWorkflow({ workflow, mode: 'manual', startNodeId: 'Start' });
    expect(waiting.status).toBe('waiting');

    // Mailpit's search finds the message by recipient.
    let id: string | undefined;
    for (let tries = 0; tries < 50 && !id; tries++) {
      const found = (await (await fetch(`${API}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`)).json()) as { messages?: Array<{ ID: string }> };
      id = found.messages?.[0]?.ID;
      if (!id) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(id, 'the approval email reached Mailpit').toBeTruthy();
    const message = (await (await fetch(`${API}/api/v1/message/${id}`)).json()) as { Subject: string; From: { Address: string }; Text: string; HTML: string };
    expect(message.Subject).toBe('Agent wants to run a tool: approve Calculator?');
    expect(message.From.Address).toBe('approvals@landflow.test');
    expect(message.HTML).toContain('/api/approvals/email/');
    const approve = /Approve: (\S+)/.exec(message.Text)![1];
    expect(approve.startsWith('https://landflow.test/api/approvals/email/')).toBe(true);

    const token = approve.slice(approve.lastIndexOf('/') + 1);
    const page = await emailRoute.GET(new Request(approve), { params: Promise.resolve({ token }) });
    expect(await page.text()).toContain('Approve this tool call?');
    expect(store.getExecution(waiting.executionId)!.status).toBe('waiting');
    const decided = await emailRoute.POST(new Request(approve, { method: 'POST' }), { params: Promise.resolve({ token }) });
    expect(decided.status).toBe(200);
    expect(store.getExecution(waiting.executionId)!.status).toBe('success');
    expect((await emailRoute.POST(new Request(approve, { method: 'POST' }), { params: Promise.resolve({ token }) })).status).toBe(409);
  });
});
