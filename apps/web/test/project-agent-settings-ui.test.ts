/** The "Agents in this project" card (contracts/w9/project-agent-settings-api.md). */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProjectAgentSettingsView } from '../src/components/projects/project-agent-settings';
import { errorFieldOf, parseAgentSettings, patchBody, savePatch, sameAgentSettings } from '../src/lib/client/project-agent-settings';
import type { ProjectSettingsView } from '../src/lib/shared/project-policy';

const getExample: ProjectSettingsView = {
  settings: {
    nodes: { mode: 'off', plugins: [], types: [] },
    approvers: 'default',
    fourEyes: false,
    defaultModel: { provider: 'ollama', model: 'qwen3:8b' },
    knowledge: {
      enabled: true,
      tool: { id: 'project_knowledge', type: 'knowledge', source: 'vector', name: 'Billing handbook', collection: 'billing-handbook', store: 'sqlite', embeddings: { provider: 'ollama', model: 'nomic-embed-text' } } as never,
    },
    agents: { mode: 'allow', ids: ['agt_writer'] },
    agentTools: { mode: 'allow', kinds: ['node', 'knowledge', 'workflow'] },
    updatedAt: '2026-11-15T09:00:00.000Z',
    updatedBy: 'usr_admin',
  },
  canEdit: true,
  plugins: [],
  nodeTypes: [],
  availableAgents: [
    { id: 'agt_billing', name: 'Billing helper', home: true },
    { id: 'agt_writer', name: 'Release writer', home: false },
  ],
};

const render = (view: ProjectSettingsView, extra: Partial<Parameters<typeof ProjectAgentSettingsView>[0]> = {}) => {
  const state = parseAgentSettings(view);
  return renderToStaticMarkup(createElement(ProjectAgentSettingsView, { state, form: state.form, saved: state.form, ...extra }));
};

describe('parseAgentSettings', () => {
  it('reads the contract answer', () => {
    const state = parseAgentSettings(getExample);
    expect(state.canEdit).toBe(true);
    expect(state.form.defaultModel).toEqual({ provider: 'ollama', model: 'qwen3:8b' });
    expect(state.form.agents).toEqual({ mode: 'allow', ids: ['agt_writer'] });
    expect(state.form.agentTools.kinds).toEqual(['node', 'knowledge', 'workflow']);
    expect(state.available).toHaveLength(2);
  });
  it('defaults what the answer leaves out', () => {
    const state = parseAgentSettings({ settings: { nodes: { mode: 'off', plugins: [], types: [] }, approvers: 'default', fourEyes: false }, canEdit: false, plugins: [], nodeTypes: [] });
    expect(state.form).toEqual({ agents: { mode: 'off', ids: [] }, agentTools: { mode: 'off', kinds: [] } });
    expect(state.available).toEqual([]);
  });
});

describe('patchBody', () => {
  it('names only the four fields, null to clear', () => {
    const form = parseAgentSettings(getExample).form;
    expect(Object.keys(patchBody(form)).sort()).toEqual(['agentTools', 'agents', 'defaultModel', 'knowledge']);
    const cleared = patchBody({ ...form, defaultModel: undefined, knowledge: undefined });
    expect(cleared.defaultModel).toBeNull();
    expect(cleared.knowledge).toBeNull();
    expect(sameAgentSettings(form, { ...form })).toBe(true);
    expect(sameAgentSettings(form, { ...form, agents: { mode: 'off', ids: [] } })).toBe(false);
  });
});

describe('savePatch', () => {
  it('names only what changed', () => {
    const form = parseAgentSettings(getExample).form;
    expect(savePatch(form, form)).toEqual({});
    expect(savePatch({ ...form, agentTools: { mode: 'off', kinds: [] } }, form)).toEqual({ agentTools: { mode: 'off', kinds: [] } });
  });
  it('drops allowed ids that are no longer available', () => {
    const form = parseAgentSettings(getExample).form;
    const stale = { ...form, agents: { mode: 'allow' as const, ids: ['agt_gone', 'agt_writer'] } };
    const next = { ...stale, agents: { ...stale.agents, mode: 'off' as const } };
    const body = savePatch(next, stale, [{ id: 'agt_writer', name: 'Writer', home: false }]);
    expect(body.agents).toEqual({ mode: 'off', ids: ['agt_writer'] });
    expect(savePatch({ ...stale, agentTools: { mode: 'off', kinds: [] } }, stale, [{ id: 'agt_writer', name: 'Writer', home: false }])).not.toHaveProperty('agents');
  });
});

describe('errorFieldOf', () => {
  it('names the one checked field the PATCH sent, else none', () => {
    expect(errorFieldOf({ defaultModel: { provider: 'ollama', model: 'm', credential: { id: 'c', name: 'c' } } })).toBe('defaultModel');
    expect(errorFieldOf({ defaultModel: { provider: 'ollama', model: 'm' }, agentTools: { mode: 'off', kinds: [] } })).toBe('defaultModel');
    expect(errorFieldOf({ knowledge: { enabled: true, tool: {} as never } })).toBe('knowledge');
    expect(errorFieldOf({ agents: { mode: 'allow', ids: ['agt_x'] } })).toBe('agents');
    expect(errorFieldOf({ agents: { mode: 'off', ids: [] }, defaultModel: null })).toBeUndefined();
    expect(errorFieldOf({ defaultModel: { provider: 'ollama', model: 'm' }, agents: { mode: 'allow', ids: ['agt_x'] } })).toBeUndefined();
    expect(errorFieldOf({})).toBeUndefined();
  });
});

describe('the card', () => {
  it('puts a 400 under the field the PATCH sent, or at the bottom', () => {
    const message = 'That credential isn’t available in this project';
    const underAgents = render(getExample, { error: message, errorField: 'agents' });
    expect(underAgents.indexOf(message)).toBeGreaterThan(underAgents.indexOf('Allowed agents'));
    expect(underAgents.indexOf(message)).toBeLessThan(underAgents.indexOf('Allowed tools'));
    const underModel = render(getExample, { error: message, errorField: 'defaultModel' });
    expect(underModel.indexOf(message)).toBeLessThan(underModel.indexOf('Knowledge base'));
    const bottom = render(getExample, { error: message });
    expect(bottom.indexOf(message)).toBeGreaterThan(bottom.indexOf('Allowed tools'));
    expect(bottom.split(message)).toHaveLength(2);
  });
  it('Save disabled with a provider and no model says "Choose a model"', () => {
    const state = parseAgentSettings(getExample);
    const html = renderToStaticMarkup(createElement(ProjectAgentSettingsView, { state, form: { ...state.form, defaultModel: { provider: 'ollama', model: '' } }, saved: state.form }));
    expect(html).toContain('Choose a model');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Save/);
  });
  it('an admin: model, knowledge, own agents disabled, tool kinds', () => {
    const html = render(getExample);
    expect(html).toContain('id="agents"');
    expect(html).toContain('Agents in this project');
    expect(html).toContain('Used when neither the workflow’s step nor the agent names a model.');
    expect(html).toContain('Every agent that runs in this project can search it, as project_knowledge.');
    expect(html).toContain('Billing handbook (billing-handbook)');
    expect(html).toContain('Change…');
    expect(html).toContain('Always allowed (this project’s own)');
    expect(html).toMatch(/<input[^>]*checked=""[^>]*disabled=""|<input[^>]*disabled=""[^>]*checked=""/);
    expect(html).toContain('Release writer');
    expect(html).toContain('MCP servers');
    expect(html).toContain('Skills, memory, a team’s own tools and the tools connected to a workflow’s step are always allowed.');
  });
  it('a viewer reads it, with no Change button', () => {
    const html = render({ ...getExample, canEdit: false });
    expect(html).toContain('The project’s admins change these.');
    expect(html).not.toContain('Change…');
    expect(html).toContain('ollama · qwen3:8b');
    // The modes are text for a viewer, not choices that look enabled.
    expect(html).not.toContain('role="tablist"');
    expect(render(getExample)).toContain('role="tablist"');
    expect(html).toContain('>Only these</p>');
    const off = render({ ...getExample, canEdit: false, settings: { ...getExample.settings, agents: { mode: 'off', ids: [] }, agentTools: { mode: 'off', kinds: [] } } });
    expect(off).toContain('>Everything available</p>');
    expect(off).toContain('>Every kind</p>');
  });
  it('without availableAgents: "No agents to list"', () => {
    const { availableAgents: _drop, ...rest } = getExample;
    expect(render(rest)).toContain('No agents to list');
  });
});
