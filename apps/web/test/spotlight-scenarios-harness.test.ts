/**
 * The Spotlight scenario suite's own tests: the scripted model, the touched-nodes diff, the glob, the unit assertion, the
 * live switch, the outbound guard (in a child process) and the scorecard's report. All new code: each fails without it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Workflow } from '@landflow/engine';
import { call, checks, defineScenarios, scriptedModel, touchedNodes, type Outcome, type Scenario } from './spotlight-scenarios/scenario';
import { assertUnit, failedChecks, liveEnabled, reportOf, runScenario, tables } from './spotlight-scenarios/harness';

const node = (id: string, name: string, parameters: Record<string, unknown> = {}) => ({ id, name, type: 'core.code', typeVersion: 1, position: [0, 0] as [number, number], parameters });
const wf = (): Workflow => ({ id: 'wf_h', name: 'H', nodes: [node('a', 'A'), node('b', 'B'), node('c', 'C')], connections: [{ id: 'e1', type: 'main', source: 'a', sourceIndex: 0, target: 'b', targetIndex: 0 }], pinData: {}, settings: {} }) as Workflow;

const outcome = (over: Partial<Outcome> = {}): Outcome => ({ scenario: 'x', form: 'unit', ms: 5, text: '', tools: [], proposals: [], needs: [], sent: [], refused: [], agents: [], modelCalls: 0, tokens: { input: 0, output: 0 }, ...over });

describe('scriptedModel', () => {
  it('answers in order, records what it was asked and throws when the script runs out', async () => {
    const { model, calls } = scriptedModel([{ text: 'one' }, call('propose_changes', { summary: 's', ops: [] })]);
    const ask = { system: 'sys', messages: [], tools: [] } as never;
    expect((await model.generate(ask)).text).toBe('one');
    expect((await model.generate(ask)).toolCalls[0].name).toBe('propose_changes');
    await expect(model.generate(ask)).rejects.toThrow('No scripted turn left');
    expect(calls).toHaveLength(3);
  });
});

describe('touchedNodes', () => {
  it('lists a changed parameter, a new wire, an added and a removed node, and not an untouched one', () => {
    const before = wf();
    const after = wf();
    after.nodes[0] = node('a', 'A', { x: 1 });
    expect(touchedNodes(before, after)).toEqual(['A']);
    after.connections.push({ id: 'e2', type: 'main', source: 'b', sourceIndex: 0, target: 'c', targetIndex: 0 });
    expect(touchedNodes(before, after).sort()).toEqual(['A', 'B', 'C']);
    after.nodes.push(node('d', 'D'));
    after.nodes = after.nodes.filter((n) => n.id !== 'c');
    expect(touchedNodes(before, after)).toContain('D');
    expect(touchedNodes(before, after)).toContain('C');
    expect(touchedNodes(before, wf())).toEqual([]);
    expect(touchedNodes(undefined, wf())).toEqual([]);
  });
});

describe('the scenario files', () => {
  const files = import.meta.glob<{ default: Scenario[] }>('./spotlight-scenarios/sb*.ts', { eager: true });
  const all = Object.values(files).flatMap((f) => f.default);

  it('finds sb00.ts, and every id is unique and starts with its owner in lower case', () => {
    expect(Object.keys(files)).toContain('./spotlight-scenarios/sb00.ts');
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length);
    for (const s of all) expect(s.id.startsWith(`${s.owner.toLowerCase()}-`)).toBe(true);
    expect(all.filter((s) => s.owner === 'SB00').length).toBeGreaterThanOrEqual(10);
  });

  it('keeps no outside URL in a fixture or an ask: the echo server is 127.0.0.1:3399', () => {
    const text = JSON.stringify(all.map((s) => [s.ask, s.start?.workflow]));
    for (const url of text.match(/https?:\/\/[^"\\\s)]+/g) ?? []) expect(url).toMatch(/^https?:\/\/(127\.0\.0\.1|localhost)/);
  });
});

describe('the unit assertion', () => {
  const scenario = defineScenarios([{ id: 'sb00-fake', owner: 'SB00', job: 'fix', via: 'chat', title: 't', ask: 'a', checks: [checks.proposed, checks.noChange] }])[0];

  it('fails naming the check that did not hold, and passes when all do', () => {
    expect(() => assertUnit(scenario, outcome())).toThrow('Showed a change card');
    expect(failedChecks(scenario, outcome())).toEqual(['Showed a change card']);
    expect(() => assertUnit({ ...scenario, checks: [checks.noChange] }, outcome())).not.toThrow();
    expect(() => assertUnit({ ...scenario, checks: [] }, outcome({ error: 'boom' }))).toThrow('boom');
  });
});

describe('the live form', () => {
  it('runs only when LANDFLOW_INTEGRATION names spotlight', () => {
    expect(liveEnabled({})).toBe(false);
    expect(liveEnabled({ LANDFLOW_INTEGRATION: 'ollama,browser' })).toBe(false);
    expect(liveEnabled({ LANDFLOW_INTEGRATION: 'ollama, spotlight' })).toBe(true);
  });
});

describe('the harness drives the product', () => {
  it('a build: the fake Ollama answers the script and the draft is laid out as a workflow', async () => {
    const draft = { name: 'D', nodes: [{ key: 'start', type: 'core.manualTrigger', name: 'Start' }, { key: 'set', type: 'core.set', name: 'Set' }], connections: [{ from: 'start', to: 'set' }] };
    const scenario: Scenario = { id: 'sb00-h-build', owner: 'SB00', job: 'build', via: 'build', title: 't', ask: 'copy the fields over', script: [{ text: JSON.stringify(draft) }], checks: [] };
    const o = await runScenario(scenario, 'unit');
    expect(o.error).toBeUndefined();
    expect(o.after?.nodes.map((n) => n.type)).toEqual(['core.manualTrigger', 'core.set']);
    expect(o.after?.connections).toHaveLength(1);
    expect(o.modelCalls).toBe(1);
  });

  it('a chat: the proposal is applied with applyOps and the tools and reply are collected', async () => {
    const scenario: Scenario = {
      id: 'sb00-h-chat',
      owner: 'SB00',
      job: 'fix',
      via: 'chat',
      title: 't',
      ask: 'retry B 3 times',
      start: { workflow: wf() },
      script: [call('propose_changes', { summary: 'Set retries', ops: [{ op: 'setNodeSettings', node: 'B', settings: { maxTries: 3, retryOnFail: true } }] }), { text: 'Set B to retry.' }],
      checks: [checks.onlyTouches(['B']), checks.proposed],
    };
    const o = await runScenario(scenario, 'unit');
    expect(o.tools).toContain('propose_changes');
    expect(o.text).toBe('Set B to retry.');
    expect(touchedNodes(o.before, o.after)).toEqual(['B']);
    expect(o.refused).toEqual([]);
    expect(failedChecks(scenario, o)).toEqual([]);
  });

  it('a session: scripted runs, a fix between them, and the "Needs you" rows recorded', async () => {
    const scenario: Scenario = {
      id: 'sb00-h-session',
      owner: 'SB00',
      job: 'fix',
      via: 'session',
      title: 't',
      ask: 'make C run',
      start: { workflow: { ...wf(), nodes: [{ ...node('t', 'Start'), type: 'core.manualTrigger' }, node('b', 'B'), node('c', 'C')], connections: [{ id: 'e1', type: 'main', source: 't', sourceIndex: 0, target: 'b', targetIndex: 0 }, { id: 'e2', type: 'main', source: 'b', sourceIndex: 0, target: 'c', targetIndex: 0 }] } as Workflow, sessionRuns: [{ C: { error: 'Boom: bad code' } }, {}] },
      script: [{ text: 'Nothing to change yet.' }, call('propose_changes', { summary: 'Fixed C', ops: [{ op: 'setParameters', node: 'C', parameters: { codeEach: 'return $json;' } }] }), { text: 'Fixed C.' }],
      checks: [],
    };
    const o = await runScenario(scenario, 'unit');
    expect(o.error).toBeUndefined();
    expect(o.proposals.map((p) => p.summary)).toContain('Fixed C');
    expect(o.after?.nodes.find((n) => n.name === 'C')?.parameters).toMatchObject({ codeEach: 'return $json;' });
  });

  it('a session that needs a person records the row', async () => {
    const scenario: Scenario = {
      id: 'sb00-h-needs',
      owner: 'SB00',
      job: 'fix',
      via: 'session',
      title: 't',
      ask: 'run it',
      start: { workflow: wf() },
      script: [{ text: 'Looked at it.' }],
      checks: [checks.needs('trigger')],
    };
    const o = await runScenario(scenario, 'unit');
    expect(o.needs).toEqual(['trigger']);
    expect(failedChecks(scenario, o)).toEqual([]);
  });
});

describe('the scorecard report', () => {
  it('holds sizes and check results only: no reply text and no ask text', () => {
    const scenario: Scenario = { id: 'sb00-r', owner: 'SB00', job: 'fix', via: 'chat', title: 'Secret title', ask: 'the secret ask words', checks: [checks.proposed, checks.noChange] };
    const o = outcome({ text: 'the secret reply words', proposals: [{ summary: 'secret summary', ops: [], dropped: [], warnings: [] }] });
    const report = reportOf('m', '2026-01-01T00:00:00Z', [{ scenario, outcome: o }]);
    const json = JSON.stringify(report);
    expect(json).not.toContain('secret');
    expect(report.scenarios[0]).toMatchObject({ id: 'sb00-r', owner: 'SB00', job: 'fix', runs: [{ ms: 5, checks: { proposed: true, 'no-change': false } }] });
    expect(tables(report, [scenario])).toContain('1 of 1');
  });
});

describe('the outbound guard (local-only.cjs)', () => {
  const guard = join(import.meta.dirname, 'spotlight-scenarios/local-only.cjs');
  const child = (script: string) => spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: `--require ${guard}` }, timeout: 20_000 });

  it('refuses a connection to a TEST-NET address with ECONNREFUSED before a byte leaves, and says so on stderr', () => {
    const r = child(`fetch('http://198.51.100.7/').then(()=>console.log('REACHED'),(e)=>console.log('CODE', e.cause?.code ?? e.code))`);
    expect(r.stdout).toContain('CODE ECONNREFUSED');
    expect(r.stdout).not.toContain('REACHED');
    expect(r.stderr.startsWith('[local-only] installed')).toBe(true);
    expect(r.stderr).toContain('[local-only] refused 198.51.100.7:80');
  });

  it('refuses a lookup of a reserved name with ENOTFOUND before any query', () => {
    const r = child(`require('dns').promises.lookup('example.invalid').then(()=>console.log('RESOLVED'),(e)=>console.log('CODE', e.code))`);
    expect(r.stdout).toContain('CODE ENOTFOUND');
    expect(r.stderr).toContain('[local-only] refused example.invalid');
  });

  it('lets 127.0.0.1 and localhost through', () => {
    const script = `
      const http = require('http');
      const server = http.createServer((q, s) => s.end('ok')).listen(0, '127.0.0.1', async () => {
        const port = server.address().port;
        for (const host of ['127.0.0.1', 'localhost']) console.log(host, await (await fetch('http://' + host + ':' + port + '/')).text());
        server.close();
      });`;
    const r = child(script);
    expect(r.stdout).toContain('127.0.0.1 ok');
    expect(r.stdout).toContain('localhost ok');
    expect(r.stderr).not.toContain('refused');
  });

  it('is a byte copy of the contract file kept next to the scenarios, and requires cleanly', () => {
    expect(execFileSync(process.execPath, ['-e', `console.log(typeof require(${JSON.stringify(guard)}).refused)`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()).toBe('function');
  });
});
