/**
 * "Chat with a team" fixes found showcasing it: a roster-picked specialist gets the visitor's message, the page's face
 * for an answering agent (roster emoji, avatar, letter), the "asked <Agent>: <reason>" line (Run an Agent delegates),
 * a template layout whose nodes do not overlap, and the agents' default model.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { NodeDescriptor, Workflow } from '@landflow/engine';
import { deriveToolSchema, withReason } from '@landflow/engine';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-chat-team-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

// The model is out of the picture: an agent answers with the message it was given.
const asked: Array<{ agent: string; message: string }> = [];
vi.mock('@/lib/server/agents/runtime', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/server/agents/runtime')>();
  return {
    ...real,
    runAgent: async (request: { agent: { name: string }; session: unknown; message: string }) => {
      asked.push({ agent: request.agent.name, message: request.message });
      return { session: request.session, reason: 'completed', reply: `${request.agent.name} heard: ${request.message}`, usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
});

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { publishDraft } = await import('@/lib/server/publish');
const templates = await import('@/lib/server/templates');
const { BUILTIN_TEMPLATES } = await import('@/lib/server/templates/builtin');
const { speakerFace, CHAT_CLIENT_JS } = await import('@/lib/server/chat-client');
const chatRoute = await import('@/app/chat/[...path]/route');
registry.registerBuiltin(corePlugin);

const template = BUILTIN_TEMPLATES.find((t) => t.id === 'chat-with-a-team')!;
const messageAgent = () => (registry.resolve('core.messageAgent') as { descriptor: NodeDescriptor }).descriptor;

describe('a roster-picked specialist in the template', () => {
  const ask = async (path: string, body: Record<string, unknown>) => {
    const response = await chatRoute.POST(new Request(`http://chat.test/chat/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' }, body: JSON.stringify({ sessionId: 's1', ...body }) }), { params: Promise.resolve({ path: [path] }) });
    return (await response.text()).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  };

  it('receives the visitor message (no "The message is empty")', async () => {
    const used = await templates.useTemplate('chat-with-a-team', {});
    const id = used.workflow!.id;
    await publishDraft(id, 'tester', 'chat');
    for (const [agentKey, name, question] of [['technical', 'Technical', 'My app will not start'], ['billing', 'Billing', 'Why was I charged twice?']] as const) {
      asked.length = 0;
      const lines = await ask(id, { message: question, agentKey });
      expect(JSON.stringify(lines)).not.toContain('The message is empty');
      expect(lines.find((l) => l.type === 'done')).toMatchObject({ status: 'success' });
      expect(asked).toEqual([{ agent: name, message: question }]);
    }
  });

  it('the lead still gets the message when nobody is picked', async () => {
    const used = await templates.useTemplate('chat-with-a-team', {});
    await publishDraft(used.workflow!.id, 'tester', 'chat');
    asked.length = 0;
    await ask(used.workflow!.id, { message: 'Hello there' });
    expect(asked).toEqual([{ agent: 'Lead', message: 'Hello there' }]);
  });

  it('Run an Agent falls back to the chat input when its message comes out empty', async () => {
    const used = await templates.useTemplate('chat-with-a-team', {});
    const lead = used.agents!.find((a) => a.name === 'Lead')!;
    const flow: Workflow = {
      id: 'wf_fallback',
      name: 'fallback',
      nodes: [
        { id: 'Chat', name: 'Chat', type: 'core.chatTrigger', typeVersion: 1, position: [0, 0], parameters: { public: true } },
        { id: 'Run', name: 'Run', type: 'core.messageAgent', typeVersion: 1, position: [300, 0], parameters: { agentId: lead.id, message: "{{ $fromAI('message', 'x', 'string') }}" } },
      ],
      connections: [{ id: 'c', type: 'main', source: 'Chat', target: 'Run', sourceIndex: 0, targetIndex: 0 }],
    };
    store.saveWorkflow(flow);
    await publishDraft(flow.id, 'tester', 'chat');
    asked.length = 0;
    await ask(flow.id, { message: 'Typed by the visitor' });
    expect(asked).toEqual([{ agent: 'Lead', message: 'Typed by the visitor' }]);
  });

  it('the specialist message parameter falls back to the chat input, and as a tool it still asks for a message', () => {
    for (const name of ['Billing', 'Technical']) {
      const n = template.workflow.nodes.find((x) => x.name === name)!;
      expect(String(n.parameters.message)).toContain('$json.chatInput');
      expect(deriveToolSchema(messageAgent(), n.parameters)).toMatchObject({ required: ['message'] });
    }
  });
});

describe('the "asked <Agent>: <reason>" line', () => {
  it('Run an Agent is a delegating tool, so its schema requires a reason', () => {
    expect(messageAgent().delegates).toBe(true);
    const billing = template.workflow.nodes.find((n) => n.name === 'Billing')!;
    const schema = withReason(deriveToolSchema(messageAgent(), billing.parameters)) as { required: string[]; properties: Record<string, unknown> };
    expect(schema.required).toEqual(['message', 'reason']);
    expect(schema.properties).toHaveProperty('reason');
  });

  it('the page turns a tool call with a reason into the line', () => {
    expect(CHAT_CLIENT_JS).toContain('chunk.tool.input.reason');
    expect(CHAT_CLIENT_JS).toContain("'asked '");
  });
});

describe('the face beside an answer', () => {
  const roster = [{ key: 'billing', label: 'Billing', face: '\u{1F9FE}' }, { key: 'technical', label: 'Technical', face: '\u{1F6E0}️' }];
  const avatar = { kind: 'face', face: { skin: '#c68642' } };

  it('uses the roster entry emoji, found by name or key, even when the node sent an avatar object', () => {
    expect(speakerFace({ id: 'ag_1', name: 'Billing', face: avatar }, roster)).toEqual({ text: '\u{1F9FE}' });
    expect(speakerFace({ id: 'technical', name: 'Whoever' }, roster)).toEqual({ text: '\u{1F6E0}️' });
    expect(speakerFace({ name: 'technical' }, roster)).toEqual({ text: '\u{1F6E0}️' });
  });

  it('an emoji on the label wins; otherwise the avatar (image, initials, skin tone) and the letter last', () => {
    expect(speakerFace({ name: 'Billing', face: '\u{1F4B8}' }, roster)).toEqual({ text: '\u{1F4B8}' });
    expect(speakerFace({ name: 'Lead', face: avatar }, roster)).toEqual({ text: 'L', bg: '#c68642' });
    expect(speakerFace({ name: 'Lead', face: { kind: 'initials', initials: 'ld' } }, roster)).toEqual({ text: 'LD' });
    const image = 'data:image/png;base64,AAAA';
    expect(speakerFace({ name: 'Lead', face: { kind: 'image', image } })).toEqual({ text: 'L', image });
    expect(speakerFace({ name: 'Lead', face: { kind: 'image', image: 'https://evil.test/x.png' } })).toEqual({ text: 'L' });
    expect(speakerFace({ name: 'Lead' })).toEqual({ text: 'L' });
  });

  it('the page script is valid JavaScript and calls it with the roster', () => {
    expect(() => new Function(CHAT_CLIENT_JS)).not.toThrow();
    expect(CHAT_CLIENT_JS).toContain('speakerFace(agent, config && config.agents)');
  });
});

describe('the template canvas and model', () => {
  it('lays its nodes out without overlap', () => {
    const nodes = template.workflow.nodes;
    for (const [i, a] of nodes.entries()) {
      for (const b of nodes.slice(i + 1)) {
        const clear = Math.abs(a.position[0] - b.position[0]) >= 220 || Math.abs(a.position[1] - b.position[1]) >= 110;
        expect(clear, `${a.name} and ${b.name} overlap`).toBe(true);
        // Run an Agent nodes draw about 280 px wide with their ports: two on one row need more room.
        if (a.type === 'core.messageAgent' && b.type === 'core.messageAgent' && Math.abs(a.position[1] - b.position[1]) < 110) expect(Math.abs(a.position[0] - b.position[0])).toBeGreaterThanOrEqual(300);
      }
    }
  });

  it('the agents run on the Ollama model the local templates document, which the setup steps tell the user to pull', () => {
    const models = template.bundle!.agents.map((a) => (a.config as unknown as { model: { provider: string; model: string } }).model);
    for (const m of models) {
      expect(m).toMatchObject({ provider: 'ollama', model: 'qwen3-coder:30b' });
      // No fixed address: it follows OLLAMA_URL, so it works on a host and in a container.
      expect(m).not.toHaveProperty('baseUrl');
    }
    expect(template.setup.join('\n')).toContain('ollama pull qwen3-coder:30b');
  });
});
