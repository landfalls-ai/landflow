/**
 * What an agent works with, as the Run Trace shows it (lib/server/agents/connections.ts): its model, memory, tools,
 * knowledge and skills from the published settings, a kagent deployment's runtime, plugins and network, the agent behind
 * an A2A URL; and the brand marks they're drawn with (lib/shared/brand-icons.ts).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BRANDS, brandIcon, brandOf, brandOfProvider, isBrand } from '@/lib/shared/brand-icons';
import { mergeConnections } from '@/lib/shared/run-trace';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-connections-'));
const previous = process.env.LANDFLOW_DATA_DIR;
process.env.LANDFLOW_DATA_DIR = dataDir;

const { agentStore } = await import('@/lib/server/agents/store');
const { agentConnections, deployedAgentAt, kagentConnections, nodeConnections, remoteConnections } = await import('@/lib/server/agents/connections');

afterAll(() => {
  if (previous === undefined) delete process.env.LANDFLOW_DATA_DIR;
  else process.env.LANDFLOW_DATA_DIR = previous;
});

const helper = agentStore.publish(agentStore.create({ name: 'Formatter' }).id)!;
const lead = agentStore.publish(
  agentStore.create({
    name: 'Tech Lead',
    model: { provider: 'ollama', model: 'qwen3-coder:30b', baseUrl: 'http://host.docker.internal:11434' },
    memory: { crossSession: true },
    skills: [{ id: 'sk1', name: 'Review a PR', whenToUse: 'Use when reviewing', instructions: '…' }],
    tools: [
      { id: 't1', type: 'node', name: 'check_branch', description: 'Check a branch', nodeType: 'github.github', parameters: { resource: 'branch', operation: 'get', branch: "{{ $fromAI('b') }}" } },
      { id: 't2', type: 'knowledge', name: 'search_handbook', description: 'The handbook', store: 'pgvector', collection: 'handbook', embeddings: { provider: 'ollama', model: 'nomic-embed-text' } },
      { id: 't3', type: 'mcp', name: 'Grafana', parameters: { endpointUrl: 'http://grafana-mcp:8000/mcp' } },
      { id: 't4', type: 'agent', agentId: helper.id },
      { id: 't5', type: 'a2a', name: 'Planner', parameters: { agentUrl: 'http://kagent:8083/agents/kagent/landflow-planner' } },
      { id: 't6', type: 'workflow', workflowId: 'wf_1', name: 'open_ticket', description: 'Open a ticket' },
    ],
  }).id,
)!;

describe('an agent’s connections', () => {
  it('lists its model with the provider’s mark, memory, tools by kind, knowledge and skills', () => {
    expect(agentConnections(lead)).toEqual([
      { kind: 'model', name: 'qwen3-coder:30b', detail: 'Ollama · host.docker.internal:11434', icon: 'brand:ollama', from: 'agent' },
      { kind: 'memory', name: 'Remembers across sessions', icon: 'lucide:brain', from: 'agent' },
      { kind: 'tool', name: 'check_branch', detail: 'branch · get', nodeType: 'github.github', from: 'agent' },
      { kind: 'knowledge', name: 'handbook', detail: 'Postgres pgvector · Ollama nomic-embed-text', icon: 'brand:postgresql', from: 'agent' },
      { kind: 'tool', name: 'Grafana', detail: 'MCP server · grafana-mcp:8000', icon: 'brand:mcp', from: 'agent' },
      { kind: 'agent', name: 'Formatter', detail: 'a Landflow agent', icon: 'lucide:bot', from: 'agent' },
      { kind: 'agent', name: 'Planner', detail: 'A2A · kagent:8083', icon: 'lucide:radio-tower', from: 'agent' },
      { kind: 'tool', name: 'open_ticket', detail: 'a workflow', icon: 'lucide:workflow', from: 'agent' },
      { kind: 'skill', name: 'Review a PR', icon: 'lucide:graduation-cap', from: 'agent' },
    ]);
  });

  it('leaves out what the flow gives instead', () => {
    const kinds = agentConnections(lead, { model: true, memory: true, tools: true }).map((c) => c.kind);
    expect(kinds).toEqual(['skill']);
    expect(nodeConnections({ id: 'n', name: 'Lead', type: 'core.messageAgent', typeVersion: 1, position: [0, 0], parameters: { agentId: lead.id } }, { model: true, memory: false })?.[0]).toMatchObject({ kind: 'memory' });
    expect(nodeConnections({ id: 'n', name: 'Lead', type: 'core.messageAgent', typeVersion: 1, position: [0, 0], parameters: { agentId: '{{ $json.agent }}' } }, { model: false, memory: false })).toBeUndefined();
  });
});

describe('a kagent deployment’s connections', () => {
  const reviewer = agentStore.publish(agentStore.create({ name: 'Reviewer', model: { provider: 'ollama', model: 'qwen3-coder:30b' } }).id)!;
  agentStore.write({
    ...reviewer,
    kagent: {
      credential: { id: 'cred_k', name: 'kagent' },
      name: 'landflow-reviewer',
      harness: 'claude-harness-dev',
      plugins: [
        { id: 'code-review@claude-plugins-official', url: 'https://github.com/anthropics/claude-plugins-official', commit: 'abc' },
        { id: 'landflow-harness@landflow', url: 'http://landflow/plugins', commit: 'def' },
      ],
      egressPolicies: ['landflow-dev-packages', 'landflow-github'],
      trace: { url: 'http://landflow-host:3000/api/agent-trace', a2aUrl: 'http://kagent:8083/agents/kagent/landflow-reviewer/' },
    },
  });
  const deployed = agentStore.get(reviewer.id)!;

  it('tells Claude Code on kagent, its plugins and what its sandbox may reach', () => {
    expect(kagentConnections(deployed)).toEqual([
      { kind: 'runtime', name: 'Claude Code', detail: 'harness claude-harness-dev', icon: 'brand:claude', from: 'kagent' },
      { kind: 'runtime', name: 'kagent', detail: 'landflow-reviewer · sandbox, hot start', icon: 'brand:kagent', from: 'kagent' },
      { kind: 'plugin', name: 'code-review', detail: 'claude-plugins-official', icon: 'brand:claude', from: 'kagent' },
      { kind: 'plugin', name: 'landflow-harness', detail: 'Landflow’s mod: usage, guardrails, redaction', icon: 'lucide:shield-check', from: 'kagent' },
      { kind: 'network', name: 'Package cache', detail: 'landflow-dev-packages · npm, Go, PyPI, Alpine through landflow-cache', icon: 'lucide:package', from: 'kagent' },
      { kind: 'network', name: 'GitHub', detail: 'landflow-github: the gateway adds the token', icon: 'brand:github', from: 'kagent' },
      { kind: 'network', name: 'Landflow', detail: 'its run reports and tools', icon: 'lucide:radio', from: 'kagent' },
    ]);
    expect(kagentConnections(lead)).toEqual([]);
  });

  it('finds the agent behind an A2A URL, by the recorded URL or the kagent name', () => {
    expect(deployedAgentAt('http://kagent:8083/agents/kagent/landflow-reviewer')?.id).toBe(reviewer.id);
    expect(deployedAgentAt('http://host.docker.internal:58083/agents/kagent/landflow-reviewer')?.id).toBe(reviewer.id);
    expect(deployedAgentAt('http://elsewhere/agents/kagent/someone')).toBeUndefined();
    const remote = remoteConnections('http://host.docker.internal:58083/agents/kagent/landflow-reviewer');
    expect(remote.map((c) => `${c.kind}:${c.name}`)).toEqual(expect.arrayContaining(['runtime:Claude Code', 'model:qwen3-coder:30b', 'network:GitHub']));
    expect(remoteConnections('https://agents.example.com/a2a')).toEqual([{ kind: 'runtime', name: 'A2A agent', detail: 'agents.example.com', icon: 'lucide:radio-tower' }]);
    expect(remoteConnections(undefined)).toEqual([]);
  });
});

describe('merging connections', () => {
  it('keeps each once, the first one’s details, in kind order', () => {
    const merged = mergeConnections(
      [{ kind: 'tool', name: 'Check branch', detail: 'from the flow' }, { kind: 'model', name: 'qwen' }],
      [{ kind: 'tool', name: 'Check branch', detail: 'from the agent' }, { kind: 'runtime', name: 'kagent' }],
      undefined,
    );
    expect(merged).toEqual([{ kind: 'runtime', name: 'kagent' }, { kind: 'model', name: 'qwen' }, { kind: 'tool', name: 'Check branch', detail: 'from the flow' }]);
  });
});

describe('brand marks', () => {
  it('names the brand behind a provider or icon', () => {
    expect(brandOfProvider('ollama')).toBe('ollama');
    expect(brandOfProvider('Anthropic')).toBe('anthropic');
    expect(brandOfProvider('azure-openai')).toBe('openai');
    expect(brandOfProvider('pgvector')).toBe('postgresql');
    expect(brandOfProvider('someone')).toBeUndefined();
    expect(brandOf('brand:github')).toBe('github');
    expect(brandOf('brand:nope')).toBeUndefined();
    expect(brandOf('lucide:github')).toBeUndefined();
    expect(isBrand('toString')).toBe(false);
    expect(brandIcon('kagent')).toBe('brand:kagent');
  });

  it('has a drawable mark for each brand', () => {
    for (const [slug, mark] of Object.entries(BRANDS)) {
      expect(mark.viewBox.split(' ').map(Number).every(Number.isFinite), slug).toBe(true);
      expect(mark.paths.length, slug).toBeGreaterThan(0);
      for (const d of mark.paths) expect(d, slug).toMatch(/^[Mm][\d\s.,\-+eEMmLlHhVvCcSsQqTtAaZz]+$/);
      if ('color' in mark && mark.color) expect(mark.color, slug).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});
