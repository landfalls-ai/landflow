/**
 * The persona an agent is built with (docs/agents.md, "The persona"; lib/shared/persona.ts): its parts compile into the
 * system prompt ahead of the instructions, agents without them keep the prompt they had, blank parts aren't stored, and a
 * persona alone is enough to publish.
 */
import { describe, expect, it } from 'vitest';
import type { Agent, AgentConfig, AgentPersona } from '@/lib/shared/agents';

const { agentStore } = await import('@/lib/server/agents/store');
const { cleanPersona, hasPrompt, personaPrompt } = await import('@/lib/shared/persona');
const agentRoute = await import('@/app/api/agents/[id]/route');
const publishRoute = await import('@/app/api/agents/[id]/publish/route');

type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;
const call = async <T,>(handler: unknown, id: string, method: string, body?: unknown): Promise<{ status: number; data: T }> => {
  const init = { method, ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) };
  const response = await (handler as Handler)(new Request(`http://localhost/api/agents/${id}`, init), { params: Promise.resolve({ id }) });
  return { status: response.status, data: (await response.json()) as T };
};

const PERSONA: AgentPersona = {
  role: 'Editor for the docs team',
  audience: 'Technical writers with rough drafts',
  mission: 'Turns notes into clean Markdown and keeps the author’s meaning',
  tones: ['Precise', 'Warm'],
  length: 'paragraph',
  language: 'English',
  signoff: '— your Docs editor',
  always: ['Keep the author’s meaning'],
  never: ['Invent facts or quotes', 'Change code blocks'],
  examples: [
    { user: 'tidy this: teh release is friday', assistant: 'The release is on Friday.' },
    { user: 'half an example', assistant: '' },
  ],
};

const config = (patch: Partial<AgentConfig> = {}): AgentConfig =>
  agentStore.create({ name: 'Docs editor', description: 'Tidies drafts for the docs team', model: { provider: 'ollama', model: 'llama3.2' }, ...patch });

describe('the persona prompt', () => {
  it('writes each part in its section, the instructions after them, and ends with who the agent is', () => {
    const prompt = personaPrompt(config({ persona: PERSONA, instructions: 'When a draft has no title, suggest three.' }));
    expect(prompt).toBe(
      [
        '## Who you are\nRole: Editor for the docs team.\nWho you help: Technical writers with rough drafts.\nWhat you do: Turns notes into clean Markdown and keeps the author’s meaning.',
        '## How you talk\nTone: Precise, Warm.\nKeep answers to a short paragraph.\nAnswer in English.\nEnd every answer with this line: — your Docs editor',
        '## Rules\nAlways:\n- Keep the author’s meaning\nNever:\n- Invent facts or quotes\n- Change code blocks',
        // Only the complete example.
        '## Example\n\nUser: tidy this: teh release is friday\nYou: The release is on Friday.',
        '## Instructions\nWhen a draft has no title, suggest three.',
        'You are “Docs editor”: Tidies drafts for the docs team.',
      ].join('\n\n'),
    );
  });

  it('is unchanged for an agent without persona parts, so agents written before keep their prompt', () => {
    expect(personaPrompt(config({ instructions: 'Be brief.' }))).toBe('Be brief.\n\nYou are “Docs editor”: Tidies drafts for the docs team.');
    expect(personaPrompt(config({ persona: { role: '  ', tones: [] }, instructions: 'Be brief.' }))).toBe('Be brief.\n\nYou are “Docs editor”: Tidies drafts for the docs team.');
    expect(personaPrompt(config())).toBe('You are a helpful assistant.\n\nYou are “Docs editor”: Tidies drafts for the docs team.');
  });

  it('keeps the skills index and a run’s memory and time after the persona', () => {
    const agent = config({ persona: { role: 'Editor' }, skills: [{ id: 's', name: 'Titles', whenToUse: 'Use when asked for a title', instructions: 'Suggest three.' }] });
    const run = personaPrompt(agent, { memory: '## What you remember about this user\n(nothing yet)', now: new Date('2026-10-31T09:00:00Z') });
    expect(run.split('\n\n').map((part) => part.split('\n')[0])).toEqual([
      '## Who you are',
      '## Skills',
      '## What you remember about this user',
      'You are “Docs editor”: Tidies drafts for the docs team. Current date and time: 2026-10-31T09:00:00.000Z.',
    ]);
  });
});

describe('a stored persona', () => {
  it('drops blank parts, repeated tones and empty examples, and is absent when nothing is filled in', () => {
    expect(cleanPersona({ role: ' Editor ', tones: ['Warm', ' ', 'Warm'], always: [''], examples: [{ user: ' ', assistant: '' }, { user: 'hi', assistant: '' }], length: 'long' as never })).toEqual({
      role: 'Editor',
      tones: ['Warm'],
      examples: [{ user: 'hi', assistant: '' }],
    });
    expect(cleanPersona({ role: '', never: [], examples: [] })).toBeUndefined();
    expect(hasPrompt({ instructions: ' ', persona: { mission: 'Helps' } })).toBe(true);
    expect(hasPrompt({ instructions: ' ', persona: { mission: ' ' } })).toBe(false);
  });

  it('is saved by the builder’s autosave without its blank parts, and checked', async () => {
    const agent = config();
    const saved = await call<{ agent: Agent }>(agentRoute.PUT, agent.id, 'PUT', { ...agent, persona: { role: 'Editor', always: ['Cite sources', ''], signoff: '' } });
    expect(saved.status).toBe(200);
    expect(saved.data.agent.persona).toEqual({ role: 'Editor', always: ['Cite sources'] });
    expect(agentStore.get(agent.id)!.persona).toEqual({ role: 'Editor', always: ['Cite sources'] });
    const cleared = await call<{ agent: Agent }>(agentRoute.PUT, agent.id, 'PUT', { ...agent, persona: { role: '' } });
    expect(cleared.data.agent).not.toHaveProperty('persona');
    // The same for the model: null clears it, a body without one leaves it.
    expect((await call<{ agent: Agent }>(agentRoute.PUT, agent.id, 'PUT', { name: 'Docs editor 2' })).data.agent.model).toEqual({ provider: 'ollama', model: 'llama3.2' });
    expect((await call<{ agent: Agent }>(agentRoute.PUT, agent.id, 'PUT', { ...agent, model: null })).data.agent).not.toHaveProperty('model');
    // And for guardrails the builder turned off.
    const guarded = { enabled: true, action: 'block', reply: 'No.', checks: { keywords: ['secret'] } };
    expect((await call<{ agent: Agent }>(agentRoute.PUT, agent.id, 'PUT', { ...agent, guardrails: { input: guarded } })).data.agent.guardrails).toEqual({ input: guarded });
    expect((await call<{ agent: Agent }>(agentRoute.PUT, agent.id, 'PUT', { ...agent, guardrails: {} })).data.agent).not.toHaveProperty('guardrails');
    const bad = await call<{ error: string }>(agentRoute.PUT, agent.id, 'PUT', { persona: { length: 'endless' } });
    expect(bad.status).toBe(400);
  });

  it('is enough to publish without instructions; with neither, publishing says what’s missing', async () => {
    const empty = config();
    const refused = await call<{ error: string }>(publishRoute.POST, empty.id, 'POST');
    expect(refused.status).toBe(400);
    expect(refused.data.error).toBe('Describe the persona or add instructions before publishing');

    const agent = config({ persona: PERSONA });
    const published = await call<{ agent: Agent }>(publishRoute.POST, agent.id, 'POST');
    expect(published.status).toBe(200);
    expect(published.data.agent.published?.config.persona).toEqual(cleanPersona(PERSONA));
    // Editing the persona after publishing is a draft change.
    agentStore.saveDraft(agent.id, { persona: { ...PERSONA, tones: ['Brief'] } });
    expect(agentStore.summaries().find((s) => s.id === agent.id)?.draftChanged).toBe(true);
  });
});
