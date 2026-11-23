import { beforeAll, describe, expect, it } from 'vitest';
import type { LanguageModel, ModelTurn, Workflow } from '@landflow/engine';
import { applyOps, type AssistantOp, type DescriptorLookup, type RunDigest } from '@/lib/shared/assistant-ops';
import type { NodeTypeInfo } from '@/lib/shared/types';
import type { GenerateInput } from '@/lib/server/nodes/models';
import { corePlugin } from '@/lib/server/nodes';
import { registry } from '@/lib/server/plugins/registry';
import { runChat, type ChatEvent } from '@/lib/server/assistant/chat';
import { registryLookup, validateOps } from '@/lib/server/assistant/ops';
import { authHeaderProblems, cronProblems, destinationChanges, expressionMisses, retryProblems } from '@/lib/server/assistant/change-checks';

let types: NodeTypeInfo[];
beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  types = registry.nodeTypes().filter((t) => t.pluginId === 'core');
});

/** Start → Triage (Code) → Open status incident (HTTP), and a schedule. */
function flow(): Workflow {
  return {
    id: 'wf_checks',
    name: 'Checks',
    nodes: [
      { id: 'a', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'b', name: 'Triage', type: 'core.code', typeVersion: 1, position: [280, 0], parameters: { mode: 'each', codeEach: 'return $json;' } },
      { id: 'h', name: 'Open status incident', type: 'core.httpRequest', typeVersion: 1, position: [560, 0], parameters: { method: 'POST', url: 'http://127.0.0.1:3399/incidents', authentication: 'none', headers: {} } },
      { id: 's', name: 'Weekdays at 8', type: 'core.schedule', typeVersion: 1, position: [0, 200], parameters: { unit: 'rules', rule: { interval: [{ field: 'cronExpression', expression: '0 8 * * 1-5' }] } } },
    ],
    connections: [
      { id: 'e1', type: 'main', source: 'a', sourceIndex: 0, target: 'b', targetIndex: 0 },
      { id: 'e2', type: 'main', source: 'b', sourceIndex: 0, target: 'h', targetIndex: 0 },
    ],
  };
}
const runs: Record<string, RunDigest> = { b: { status: 'success', durationMs: 1, inputs: [], outputs: [{ count: 1, sample: [{ title: 'Checkout is down', priority: 'P0' }] }] } };
const set = (parameters: Record<string, unknown>, node = 'Open status incident'): AssistantOp => ({ op: 'setParameters', node, parameters });
const lookup = () => registryLookup(types);
const apply = (ops: AssistantOp[], wf = flow()) => applyOps(wf, ops, lookup());

describe('retry settings', () => {
  it('maxTries above 1 turns retryOnFail on, and says so in the applied op', () => {
    const r = apply([{ op: 'setNodeSettings', node: 'Open status incident', settings: { maxTries: 3 } }]);
    expect(r.workflow.nodes.find((n) => n.id === 'h')).toMatchObject({ retryOnFail: true, maxTries: 3 });
    expect(r.applied).toEqual([{ op: 'setNodeSettings', node: 'Open status incident', settings: { maxTries: 3, retryOnFail: true } }]);
  });

  it('a backoff or a wait alone turns it on; one try does not', () => {
    expect(apply([{ op: 'setNodeSettings', node: 'Triage', settings: { retryBackoff: 'exponential' } }]).workflow.nodes[1]).toMatchObject({ retryOnFail: true });
    expect(apply([{ op: 'setNodeSettings', node: 'Triage', settings: { maxTries: 1 } }]).workflow.nodes[1].retryOnFail).toBeUndefined();
  });

  it('drops maxTries 50 and names it', () => {
    const r = apply([{ op: 'setNodeSettings', node: 'Open status incident', settings: { maxTries: 50 } }]);
    expect(r.applied).toEqual([]);
    expect(r.dropped.join()).toMatch(/maxTries 50 is out of range/);
    expect(r.workflow.nodes.find((n) => n.id === 'h')?.maxTries).toBeUndefined();
  });

  it('keeps retryOnFail false and drops the tries beside it', () => {
    const r = apply([{ op: 'setNodeSettings', node: 'Open status incident', settings: { retryOnFail: false, maxTries: 3 } }]);
    expect(r.workflow.nodes.find((n) => n.id === 'h')).toMatchObject({ retryOnFail: false });
    expect(r.workflow.nodes.find((n) => n.id === 'h')?.maxTries).toBeUndefined();
    expect(r.dropped.join()).toMatch(/contradict/);
  });

  it('retryProblems names a wait too long, a contradiction and a setting nobody asked for', () => {
    const ops: AssistantOp[] = [{ op: 'setNodeSettings', node: 'Triage', settings: { waitBetweenTriesMs: 90_000, retryOnFail: false, maxTries: 3, onError: 'continue', disabled: true } }];
    const lines = retryProblems(ops, flow(), flow(), { latest: 'retry 3 times' });
    expect(lines).toHaveLength(4);
    expect(retryProblems(ops, flow(), flow(), { latest: 'retry 3 times and continue on error, then disable it' })).toHaveLength(2);
  });

  it('retry asked "with exponential backoff" without retryBackoff goes back, naming the field and its values (carryover sb3)', () => {
    const tries: AssistantOp[] = [{ op: 'setNodeSettings', node: 'Open status incident', settings: { maxTries: 3, retryOnFail: true } }];
    const lines = retryProblems(tries, flow(), apply(tries).workflow, { latest: 'Retry the incident call 3 times with exponential backoff' });
    expect(lines).toEqual(['“Open status incident” retries without the exponential backoff the request asked for: set retryBackoff to "exponential" (its values: "fixed", "exponential") in the same setNodeSettings']);
    expect(retryProblems(tries, flow(), flow(), { latest: 'retry it with a back-off' })).toHaveLength(1);
    const right: AssistantOp[] = [{ op: 'setNodeSettings', node: 'Open status incident', settings: { maxTries: 3, retryOnFail: true, retryBackoff: 'exponential' } }];
    expect(retryProblems(right, flow(), apply(right).workflow, { latest: 'retry 3 times with exponential backoff' })).toEqual([]);
    expect(retryProblems(tries, flow(), flow(), { latest: 'retry 3 times' })).toEqual([]);
    expect(retryProblems(tries, flow(), flow(), { latest: 'retry 3 times with a fixed backoff' })).toEqual([]);
    const kept = flow();
    kept.nodes[2].retryBackoff = 'exponential';
    expect(retryProblems(tries, kept, kept, { latest: 'retry 3 times with exponential backoff' })).toEqual([]);
  });
});

describe('expressions against the step input', () => {
  it('names $json.api_token against a run sample of title and priority', () => {
    const wf = flow();
    const ops = [set({ headers: { header: [{ name: 'X-Token', value: '{{ $json.api_token }}' }] } })];
    const after = apply(ops, wf).workflow;
    expect(expressionMisses(ops, wf, after, { runs })).toEqual(['“Open status incident” reads $json.api_token, which its input has no field of (it has: title, priority)']);
  });

  it('passes a field the sample has, and nested reads under a field that is not an object', () => {
    const wf = flow();
    const ops = [set({ body: '{"t":"{{ $json.title }}","p":"{{ $json.priority.level }}"}' })];
    expect(expressionMisses(ops, wf, apply(ops, wf).workflow, { runs })).toEqual([]);
  });

  it('is silent with no run, no pin and no schema', () => {
    const wf = flow();
    const ops = [set({ body: '{{ $json.api_token }}' })];
    expect(expressionMisses(ops, wf, apply(ops, wf).workflow, { runs: {} })).toEqual([]);
  });

  it('reads pinned data', () => {
    const wf = { ...flow(), pinData: { b: [{ json: { id: 7 } }] } } as Workflow;
    const ops = [set({ body: '{{ $json.title }}' })];
    expect(expressionMisses(ops, wf, apply(ops, wf).workflow, { runs: {} })[0]).toMatch(/\$json\.title.*it has: id/);
  });

  it('reads an operation-level output schema', () => {
    const wf = flow();
    wf.nodes[1] = { ...wf.nodes[1], parameters: { operation: 'getIssue' } };
    const schemaLookup: DescriptorLookup = (type) =>
      type === 'core.code'
        ? ({ properties: [{ name: 'operation', type: 'options', options: [{ name: 'Get', value: 'getIssue', outputSchema: { type: 'object', properties: { title: {}, url: {} } } }] }], outputSchema: { type: 'object', properties: { other: {} } } } as never)
        : lookup()(type);
    const ops = [set({ body: '{{ $json.priority }} {{ $json.url }}' })];
    const after = apply(ops, wf).workflow;
    expect(expressionMisses(ops, wf, after, { runs: {}, lookup: schemaLookup })).toEqual(['“Open status incident” reads $json.priority, which its input has no field of (it has: title, url)']);
  });

  it('is silent when the proposal inserts a step that makes the field the step then reads', () => {
    const wf = flow();
    wf.nodes[1] = { ...wf.nodes[1], name: 'Triage' };
    const ops: AssistantOp[] = [
      { op: 'addNode', type: 'core.set', name: 'Shape', after: 'Triage', parameters: { summary: '{{ $json.title }}' } } as AssistantOp,
      { op: 'disconnect', from: 'Triage', to: 'Open status incident' },
      { op: 'connect', from: 'Shape', to: 'Open status incident' },
      set({ body: '{{ $json.summary }}' }),
    ];
    const after = apply(ops, wf).workflow;
    expect(after.nodes.some((n) => n.name === 'Shape')).toBe(true);
    const own = { h: { status: 'success', durationMs: 1, inputs: [{ count: 1, sample: [{ title: 'x', priority: 'P0' }] }], outputs: [] } } as Record<string, RunDigest>;
    expect(expressionMisses(ops, wf, after, { runs: own })).toEqual([]);
  });

  it('is silent when a feeder is edited in the same proposal', () => {
    const wf = flow();
    const ops = [set({ fields: { summary: '{{ $json.title }}' } }, 'Triage'), set({ body: '{{ $json.summary }}' })];
    expect(expressionMisses(ops, wf, apply(ops, wf).workflow, { runs })).toEqual([]);
  });

  it('is silent when a step edited in the same proposal makes the field another step reads by name', () => {
    const wf = flow();
    const ops = [set({ codeEach: 'return { summary: $json.title };' }, 'Triage'), set({ body: "{{ $('Triage').item.json.summary }}" })];
    expect(expressionMisses(ops, wf, apply(ops, wf).workflow, { runs })).toEqual([]);
  });

  it('is silent when a feeder is renamed in the same proposal: the op names the old name, the workflow the new one (SB09-N2)', () => {
    const wf = flow();
    const ops: AssistantOp[] = [{ op: 'renameNode', node: 'Triage', name: 'Shape' } as AssistantOp, set({ body: '{{ $json.summary }}' })];
    const after = apply(ops, wf).workflow;
    expect(after.nodes.some((n) => n.name === 'Shape')).toBe(true);
    expect(expressionMisses(ops, wf, after, { runs })).toEqual([]);
  });

  it('checks $(\'Name\').item.json reads against that step', () => {
    const wf = flow();
    const ops = [set({ body: "{{ $('Triage').item.json.owner }}" })];
    expect(expressionMisses(ops, wf, apply(ops, wf).workflow, { runs })[0]).toMatch(/\$\('Triage'\)\.item\.json\.owner.*title, priority/);
  });
});

describe('schedules', () => {
  const schedule = (expression: string): AssistantOp[] => [set({ unit: 'rules', rule: { interval: [{ field: 'cronExpression', expression }] } }, 'Weekdays at 8')];
  const check = (expression: string, latest: string, wf = flow()) => cronProblems(schedule(expression), wf, apply(schedule(expression), wf).workflow, { latest });

  it('names an expression that does not parse', () => {
    expect(check('61 * * * *', 'run it hourly')[0]).toMatch(/“61 \* \* \* \*” does not work/);
  });

  it('names a day limit the request did not ask for', () => {
    const wf = flow();
    wf.nodes[3].parameters = { unit: 'rules', rule: { interval: [{ field: 'cronExpression', expression: '0 9 * * *' }] } };
    expect(check('0 8 * * 1-5', 'run it every morning at 8', wf)[0]).toMatch(/runs only on Mon–Fri; the request named no days/);
    expect(check('0 8 * * 1-5', 'run it every weekday at 8', wf)).toEqual([]);
    expect(check('0 8 * * *', 'run it every morning at 8', wf)).toEqual([]);
  });

  it('a day limit the schedule already had stays unless the request says every day', () => {
    expect(check('0 9 * * 1-5', 'move it to 9')).toEqual([]);
    expect(check('0 8 * * 1-5', 'run it every morning at 8')).toHaveLength(1);
  });
});

describe('Authorization headers', () => {
  const bearer = { header: [{ name: 'Authorization', value: 'Bearer {{ $json.api_token }}' }] };
  it('a credential with a hand-written Authorization header is a caution', () => {
    const wf = flow();
    const ops = [set({ authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth', headers: { header: [{ name: 'Authorization', value: 'Bearer abc' }] } })];
    expect(authHeaderProblems(ops, wf, apply(ops, wf).workflow)).toEqual(['“Open status incident” has a credential and a hand-written Authorization header: the header wins, so the credential is not used']);
    expect(validateOps(wf, ops, lookup()).cautions.join()).toMatch(/hand-written Authorization header/);
  });

  it('an existing hand-written header with a newly set credential is a caution', () => {
    const wf = flow();
    wf.nodes[2].parameters = { ...wf.nodes[2].parameters, headers: { header: [{ name: 'Authorization', value: 'Bearer old' }] } };
    const ops = [set({ authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth' })];
    expect(authHeaderProblems(ops, wf, apply(ops, wf).workflow, {}, 'credential')).toHaveLength(1);
    expect(validateOps(wf, ops, lookup()).cautions.join()).toMatch(/hand-written Authorization header/);
    const other = [set({ timeout: 5 })];
    expect(authHeaderProblems(other, wf, apply(other, wf).workflow, {}, 'credential')).toEqual([]);
  });

  it('a header read from the data is named', () => {
    const wf = flow();
    const ops = [set({ headers: bearer })];
    const lines = authHeaderProblems(ops, wf, apply(ops, wf).workflow, {}, 'data');
    expect(lines[0]).toMatch(/builds its Authorization header from the data/);
    expect(authHeaderProblems(ops, wf, apply(ops, wf).workflow, {}, 'credential')).toEqual([]);
  });

  it('a token header calling $cred(…), $secret or $env is made up and names the credential slot (carryover sb3)', () => {
    const wf = flow();
    const ops = [set({ headers: { header: [{ name: 'Authorization', value: "Bearer {{ $cred('my-api-key') }}" }] } })];
    expect(authHeaderProblems(ops, wf, apply(ops, wf).workflow, {}, 'data')).toEqual([
      '“Open status incident” builds a token header with $cred, which expressions here do not have (it is made up): drop that header and set authentication to "genericCredentialType" with genericAuthType "httpBearerAuth" or "httpHeaderAuth" and leave the credential to the person',
    ]);
    expect(authHeaderProblems(ops, wf, apply(ops, wf).workflow, {}, 'credential')).toEqual([]);
    const key = [set({ headers: { header: [{ name: 'X-API-Key', value: '{{ $env.API_KEY }}{{ $secret("k") }}' }] } })];
    expect(authHeaderProblems(key, wf, apply(key, wf).workflow, {}, 'data')[0]).toMatch(/with \$env, \$secret, which expressions here do not have/);
    const fine = [set({ headers: { header: [{ name: 'Authorization', value: 'Bearer {{ $vars.STATUS_TOKEN }}' }, { name: 'X-Trace', value: '{{ $cred(1) }}' }] } })];
    expect(authHeaderProblems(fine, wf, apply(fine, wf).workflow, {}, 'data')).toEqual([]);
  });
});

describe('destinations', () => {
  it('names a host, a channel and a table that change; not a path or a first value', () => {
    const wf = flow();
    expect(destinationChanges([set({ url: 'https://httpbin.org/post' })], wf)).toEqual(['“Open status incident” url: 127.0.0.1:3399 → httpbin.org']);
    expect(destinationChanges([set({ url: 'http://127.0.0.1:3399/v2' })], wf)).toEqual([]);
    expect(destinationChanges([set({ headers: { header: [] } })], wf)).toEqual([]);
  });
});

function scripted(turns: Array<Partial<ModelTurn>>) {
  const calls: GenerateInput[] = [];
  const model: LanguageModel = {
    provider: 'test',
    model: 'scripted',
    async generate(input) {
      calls.push({ ...input, messages: [...input.messages] });
      const next = turns.shift();
      if (!next) throw new Error('No scripted turn left');
      return { text: '', toolCalls: [], stopReason: 'stop', ...next };
    },
  };
  return { model, calls };
}

describe('the chat', () => {
  it('sends back a 401 fix that reads $json.api_token, once, with the fields; the second goes through', async () => {
    const header = (value: string): AssistantOp[] => [set({ headers: { header: [{ name: 'Authorization', value }] } })];
    const { model, calls } = scripted([
      { toolCalls: [{ id: 'c1', name: 'propose_changes', input: { summary: 'Send the token', ops: header('Bearer {{ $json.api_token }}') } }] },
      { toolCalls: [{ id: 'c2', name: 'propose_changes', input: { summary: 'Authenticate', ops: [set({ authentication: 'genericCredentialType', genericAuthType: 'httpBearerAuth' })] } }] },
      { text: 'Pick the credential on the card.' },
    ]);
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: 'this HTTP step fails with 401, fix it' }], workflow: flow(), selectedNodeId: 'h', runs, model, types, onEvent: (e) => events.push(e) });
    const back = (calls[1].messages.at(-1) as { results: Array<{ content: string }> }).results[0].content;
    expect(back).toContain('Not shown yet:');
    expect(back).toContain('$json.api_token');
    expect(back).toContain('it has: title, priority');
    const proposals = events.filter((e) => e.type === 'proposal');
    expect(proposals).toHaveLength(1);
    expect(JSON.stringify(proposals[0])).not.toContain('api_token');
  });

  it('shows the card with the lines once the model sends the same thing again', async () => {
    const ops = [set({ headers: { header: [{ name: 'Authorization', value: 'Bearer {{ $json.api_token }}' }] } })];
    const { model } = scripted([
      { toolCalls: [{ id: 'c1', name: 'propose_changes', input: { summary: 'Send the token', ops } }] },
      { toolCalls: [{ id: 'c2', name: 'propose_changes', input: { summary: 'Send the token, again', ops: [set({ headers: { header: [{ name: 'Authorization', value: 'Bearer {{ $json.api_token }} ' }] } })] } }] },
      { text: 'Done.' },
    ]);
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: 'fix the 401' }], workflow: flow(), selectedNodeId: 'h', runs, model, types, onEvent: (e) => events.push(e) });
    const proposal = events.find((e) => e.type === 'proposal') as { warnings: string[] } | undefined;
    expect(proposal?.warnings.join()).toMatch(/api_token/);
  });
});
