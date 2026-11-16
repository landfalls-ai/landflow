/**
 * Join test (wave 14, carryover-w14 §2, `spend-anomaly-join`): SP23's unusual-spend scan ↔ SP08's daily rollup and the
 * AI page's report ↔ the brain's inbox. 20 days of calls go through the real meter and one rollup pass, with a spike
 * today on an agent, a workflow, a person and an unpriced local (`ollama`) model, and a steady high spender. Each flag's
 * value equals the AI page's report for that day and key (the flag's own Open link, sent to the report route), its
 * baseline median equals the median of the report's figures for the 14 days before, and its distinct runs equal the
 * report's `runs`; the steady spender is not flagged; the `spend-anomaly` suggestions in the inbox name no person; and
 * with "Landledger alerts on agent and model spikes" on, the webhook catcher gets only the person's and the workflow's
 * notices. Offline; run under TZ=Pacific/Kiritimati and TZ=America/Los_Angeles too.
 */
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';
import type { AiPageReport } from '@/lib/shared/ai-spend';
import type { NeedsYouRow } from '@/lib/client/run-trace';
import type { Proposal } from '@/lib/shared/brain';

vi.setConfig({ testTimeout: 120_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-spend-anomaly-join-'));
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off', LANDFLOW_PUBLIC_URL: 'http://landflow.test', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' });

await import('@/lib/server/runtime');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { database } = await import('@/lib/server/db');
const { store } = await import('@/lib/server/store');
const { agentStore } = await import('@/lib/server/agents/store');
const { aiUsageMeter, savePriceOverrides, runInUsageScope, agentScope, assistantScope, executionScope } = await import('@/lib/server/ai-usage');
const { afterModelCall } = await import('@/lib/server/ai-usage/scope');
const { markSpendDays, runRollup } = await import('@/lib/server/ai-usage/rollup');
const { scanSpendFlags, BASELINE_DAYS } = await import('@/lib/server/ai-usage/anomalies');
const flags = await import('@/lib/server/ai-usage/spend-flags');
const { formatCost } = await import('@/lib/shared/ai-usage');
const { addDays } = await import('@/lib/shared/ai-forecast');
const { DEFAULT_AGENT_SETTINGS } = await import('@/lib/shared/agents');
const projects = await import('@/lib/server/projects/store');
const { alerts } = await import('@/lib/server/alerts/service');
const { alertStore } = await import('@/lib/server/alerts/store');
const { runDetectors } = await import('@/lib/server/brain');
const reportRoute = await import('@/app/api/insights/ai/route');
const needsYouRoute = await import('@/app/api/runs/needs-you/route');
const proposalsRoute = await import('@/app/api/proposals/route');

type User = Awaited<ReturnType<typeof createUser>>;
type Hook = { event: string; summary: string; details?: Record<string, string>; workflow?: { id: string } };
const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const CLAUDE = 'claude-anomaly-join';
const GPT = 'gpt-anomaly-join';
const LOCAL = 'qwen-join:30b';
const meter = aiUsageMeter();
const today = meter.today(NOW);
const BASELINE = [4, 5, 6, 5, 4, 5, 6, 5, 4, 5, 5, 4, 6, 5, 5, 4, 6, 5, 4, 5];

let owner: User;
let mia: User;
let omar: User;
let agentId: string;
const WF = 'wf_anomaly_join';
const STEADY = 'wf_steady_join';
let catcher: Server;
let hookUrl: string;
const hooks: Hook[] = [];
let seq = 0;

const at = (back: number) => NOW - back * DAY_MS - 60_000;
async function spend(atMs: number, scope: () => Parameters<typeof runInUsageScope>[0], call: { provider: string; model: string; inputTokens: number; outputTokens?: number }) {
  vi.setSystemTime(atMs);
  try {
    await runInUsageScope(scope(), async () => afterModelCall({ operation: 'chat', outputTokens: 0, ...call }));
  } finally {
    vi.setSystemTime(NOW);
  }
}
const dollars = (n: number) => Math.round(n * 1_000_000);

async function as<T>(user: User, fn: () => Promise<T>): Promise<T> {
  enableTestAuth(user);
  try {
    return await fn();
  } finally {
    enableTestAuth();
  }
}
async function report(query: string): Promise<AiPageReport> {
  return as(owner, async () => {
    const response = await (reportRoute.GET as (r: Request) => Promise<Response>)(new Request(`http://landflow.test/api/insights/ai?${query}`));
    expect(response.status, query).toBe(200);
    return (await response.json()) as AiPageReport;
  });
}
const FILTER = { person: 'userId', agent: 'agentId', workflow: 'workflowId', project: 'projectId', model: 'model' } as const;
/** The report's figure for one day and key, in the flag's metric. */
async function figure(flag: flags.SpendFlag, day: string): Promise<{ value: number; runs: number }> {
  const query = new URLSearchParams({ period: 'custom', from: day, to: day, [FILTER[flag.dimension as keyof typeof FILTER]]: flag.key });
  const { totals } = await report(query.toString());
  return { value: flag.metric === 'cost' ? totals.cost : totals.inputTokens + totals.outputTokens, runs: totals.runs };
}
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const anomalies = () => flags.listFlags('anomaly', addDays(today, -1)).filter((f) => f.day === today);
const keyOf = (f: { dimension: string; key: string }) => `${f.dimension}:${f.key}`;
const anomalyHooks = () => hooks.filter((h) => h.event === 'spendAnomaly');

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  catcher = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      hooks.push(JSON.parse(body) as Hook);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => catcher.listen(0, '127.0.0.1', resolve));
  hookUrl = `http://127.0.0.1:${(catcher.address() as AddressInfo).port}/hook`;

  owner = await createUser({ email: 'olga@anomaly-join.test', name: 'Olga', role: 'owner', password: 'olga-password-1' });
  mia = await createUser({ email: 'mia@anomaly-join.test', name: 'Mia Quillfeather', role: 'member', password: 'mia-password-1' });
  omar = await createUser({ email: 'omar@anomaly-join.test', name: 'Omar Steady', role: 'member', password: 'omar-password-1' });
  agentId = agentStore.create({ name: 'Orders desk', instructions: 'Be brief.', model: { provider: 'anthropic', model: CLAUDE }, settings: DEFAULT_AGENT_SETTINGS } as never).id;
  // One team project holds the agent, the workflow and the steady spender's workflow: its day moves too little to flag.
  const alpha = projects.createTeamProject({ name: 'Alpha' }).id;
  for (const id of [WF, STEADY]) {
    store.saveWorkflow({ id, name: id === WF ? 'Nightly sync' : 'Steady import', nodes: [], connections: [] } as unknown as Workflow);
    projects.setHomeProject('workflow', id, alpha);
  }
  projects.setHomeProject('agent', agentId, alpha);
  savePriceOverrides([
    { provider: 'anthropic', model: CLAUDE, input: 1, output: 0 },
    { provider: 'openai', model: GPT, input: 1, output: 0 },
  ]);
  meter.invalidatePrices();

  const agent = (back: number, run: string, cost: number) => spend(at(back), () => agentScope({ agentId, agentName: 'Orders desk', sessionId: run, settings: DEFAULT_AGENT_SETTINGS }), { provider: 'anthropic', model: CLAUDE, inputTokens: dollars(cost) });
  const flow = (back: number, run: string, cost: number) => spend(at(back), () => executionScope({ executionId: run, workflowId: WF }), { provider: 'anthropic', model: CLAUDE, inputTokens: dollars(cost) });
  const person = (back: number, cost: number) => spend(at(back), () => assistantScope({ userId: mia.id, surface: 'spotlight' }), { provider: 'anthropic', model: CLAUDE, inputTokens: dollars(cost) });
  const local = (back: number, tokens: number) => spend(at(back), () => assistantScope({ userId: mia.id, surface: 'spotlight' }), { provider: 'ollama', model: LOCAL, inputTokens: tokens * 0.75, outputTokens: tokens * 0.25 });
  const steady = (back: number, run: string, cost: number) => spend(at(back), () => executionScope({ executionId: run, workflowId: STEADY, userId: omar.id }), { provider: 'openai', model: GPT, inputTokens: dollars(cost) });

  // 20 ordinary days, then today: the agent $4–6 a day in one session, $20 today in two; the workflow half that in one
  // run, $15 today in three; Mia's Spotlight a quarter of it, $10 today, and an unpriced local model there, 20k tokens a
  // day, 500k today; Omar's steady $100 a day in a workflow, $102 today.
  for (let back = BASELINE.length; back >= 1; back--) {
    const usual = BASELINE[back - 1]!;
    await agent(back, `s_aj_${back}`, usual);
    await flow(back, `ex_aj_${back}`, usual / 2);
    await person(back, usual / 4);
    await local(back, 20_000);
    await steady(back, `ex_sj_${back}`, 100);
    seq++;
  }
  await agent(0, 's_aj_t1', 12);
  await agent(0, 's_aj_t2', 8);
  for (const k of [1, 2, 3]) await flow(0, `ex_aj_t${k}`, 5);
  await person(0, 10);
  await local(0, 500_000);
  await steady(0, 'ex_sj_t', 102);

  markSpendDays(Array.from({ length: BASELINE.length + 1 }, (_, back) => meter.today(at(back))));
  runRollup();
  scanSpendFlags(NOW);
});

afterAll(async () => {
  vi.useRealTimers();
  enableTestAuth();
  await new Promise<void>((resolve) => catcher.close(() => resolve()));
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

describe('unusual spend against the AI page’s report', () => {
  it('flags today’s spikes on the agent, the workflow, the person and the local model, not the steady spender', () => {
    const found = anomalies().map(keyOf).sort();
    expect(seq).toBe(BASELINE.length);
    expect(found).toEqual([`agent:${agentId}`, `workflow:${WF}`, `person:${mia.id}`, `model:ollama/${LOCAL}`, `model:anthropic/${CLAUDE}`].sort());
    expect(found).not.toContain(`person:${omar.id}`);
    expect(found).not.toContain(`model:openai/${GPT}`);
    expect(found).not.toContain(`workflow:${STEADY}`);
    expect(found.filter((k) => k.startsWith('project:'))).toEqual([]);
    const local = anomalies().find((f) => f.key === `ollama/${LOCAL}`)!;
    expect(local.metric).toBe('tokens');
  });

  it('gives each flag the report’s figure and runs for that day and key, through the flag’s own Open link', async () => {
    for (const flag of anomalies()) {
      const own = await figure(flag, today);
      expect(own.value, keyOf(flag)).toBeCloseTo(flag.value, 6);
      expect(own.runs, keyOf(flag)).toBe(flag.runs);
      // The link Needs you and the alert open is the same report.
      const href = flags.flagHref(flag);
      const { totals } = await report(href.split('?')[1]!);
      expect(flag.metric === 'cost' ? totals.cost : totals.inputTokens + totals.outputTokens, href).toBeCloseTo(flag.value, 6);
    }
    expect(anomalies().find((f) => f.dimension === 'agent')!.runs).toBe(2);
    expect(anomalies().find((f) => f.key === WF)!.runs).toBe(3);
  });

  it('takes its baseline median from the report’s daily figures over the 14 days before (rollup days included)', async () => {
    for (const flag of anomalies()) {
      const days = Array.from({ length: BASELINE_DAYS }, (_, i) => addDays(today, -(BASELINE_DAYS - i)));
      const values: number[] = [];
      for (const day of days) values.push((await figure(flag, day)).value);
      expect(flag.baselineDays, keyOf(flag)).toBe(BASELINE_DAYS);
      expect(flag.baselineMedian!, keyOf(flag)).toBeCloseTo(median(values), 6);
    }
  });

  it('shows the person’s flag in their own Needs you with the same figure', async () => {
    const items = await as(mia, async () => ((await (await needsYouRoute.GET(new Request('http://landflow.test/api/runs/needs-you'))).json()) as { items: NeedsYouRow[] }).items.filter((i) => i.kind === 'spend'));
    const flag = anomalies().find((f) => f.dimension === 'person' && f.key === mia.id)!;
    const item = items.find((i) => i.flagId === flag.id)!;
    expect(item.title).toContain(formatCost((await figure(flag, today)).value));
    expect(items.every((i) => !i.title.includes('Omar'))).toBe(true);
  });
});

describe('the inbox and the channels', () => {
  it('puts the agent’s and the workflow’s spikes in the inbox, naming no person', async () => {
    await runDetectors({ only: ['spend-anomaly'] });
    const listed = await as(owner, async () => ((await (await proposalsRoute.GET(new Request('http://landflow.test/api/proposals?detector=spend-anomaly'))).json()) as { proposals: Proposal[] }).proposals);
    expect(listed.map((p) => `${p.target?.type}:${p.target?.id}`).sort()).toEqual([`agent:${agentId}`, `workflow:${WF}`].sort());
    const text = JSON.stringify(listed);
    for (const word of [mia.id, mia.email, 'Mia', 'Quillfeather', omar.id, 'Omar']) expect(text, word).not.toContain(word);
  });

  it('with Landledger on agent and model spikes, sends only the person’s and the workflow’s notices; without it, all of them', async () => {
    const channel = alertStore.createChannel({ name: 'Catcher', kind: 'webhook', config: { url: hookUrl } });
    const rule = alertStore.createRule({ name: 'AI cost (Landledger)', kind: 'cost', enabled: true, workflows: { mode: 'all' }, events: ['costThreshold'], channelIds: [channel.id], throttleMinutes: 0, cost: { thresholdPercent: 99, landledgerHandlesAgentModel: true } });
    await alerts.tick(NOW);
    expect(anomalyHooks().map((h) => h.workflow!.id).sort()).toEqual([mia.id, WF].sort());
    // Each notice carries the report's figure.
    for (const hook of anomalyHooks()) {
      const flag = anomalies().find((f) => f.key === hook.workflow!.id)!;
      expect(hook.details!.Spent).toBe(`${formatCost((await figure(flag, today)).value)} on ${today} so far`);
      expect(hook.details!.Runs).toBe(String(flag.runs));
    }
    alertStore.deleteRule(rule.id);
    hooks.length = 0;
    alertStore.createRule({ name: 'AI cost', kind: 'cost', enabled: true, workflows: { mode: 'all' }, events: ['costThreshold'], channelIds: [channel.id], throttleMinutes: 0, cost: { thresholdPercent: 99 } });
    await alerts.tick(NOW);
    expect(anomalyHooks().map((h) => h.workflow!.id).sort()).toEqual(anomalies().map((f) => f.key).sort());
  });
});
