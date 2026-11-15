/** The "Agents in this project" card (contracts/w9/project-agent-settings-api.md). */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProjectAgentSettingsView } from '../src/components/projects/project-agent-settings';
import { parseAgentSettings, patchBody, sameAgentSettings } from '../src/lib/client/project-agent-settings';
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

const render = (view: ProjectSettingsView) => {
  const state = parseAgentSettings(view);
  return renderToStaticMarkup(createElement(ProjectAgentSettingsView, { state, form: state.form, saved: state.form }));
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

describe('the card', () => {
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
    expect(html).toContain('Skills, memory, a team’s notebook and the tools connected to a workflow’s step are always allowed.');
  });
  it('a viewer reads it, with no Change button', () => {
    const html = render({ ...getExample, canEdit: false });
    expect(html).toContain('The project’s admins change these.');
    expect(html).not.toContain('Change…');
    expect(html).toContain('ollama · qwen3:8b');
  });
  it('without availableAgents: "No agents to list"', () => {
    const { availableAgents: _drop, ...rest } = getExample;
    expect(render(rest)).toContain('No agents to list');
  });
});
