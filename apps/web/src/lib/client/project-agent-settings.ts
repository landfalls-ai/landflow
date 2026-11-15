/** Pure helpers for the "Agents in this project" card (docs/projects-and-goals.md#project-settings-for-agents). */
import { api } from './api';
import type { AgentModel } from '../shared/agents';
import type { ProjectAgentList, ProjectKnowledge, ProjectSettingsView, ProjectToolKinds } from '../shared/project-policy';

/** What the card edits: the four fields the settings route's PATCH takes for agents. */
export interface AgentSettingsForm {
  defaultModel?: AgentModel;
  knowledge?: ProjectKnowledge;
  agents: ProjectAgentList;
  agentTools: ProjectToolKinds;
}

export interface AgentSettingsState {
  form: AgentSettingsForm;
  canEdit: boolean;
  available: Array<{ id: string; name: string; home: boolean }>;
}

const url = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/settings`;

export const fetchAgentSettings = (projectId: string) => api<ProjectSettingsView>(url(projectId));

/** The PATCH body: only the four fields; `null` clears one. */
export const patchBody = (form: AgentSettingsForm) => ({
  defaultModel: form.defaultModel ?? null,
  knowledge: form.knowledge ?? null,
  agents: form.agents,
  agentTools: form.agentTools,
});

export const saveAgentSettings = (projectId: string, form: AgentSettingsForm) => api<ProjectSettingsView>(url(projectId), { method: 'PATCH', json: patchBody(form) });

/** The settings route's answer as the card's state; `availableAgents` may be absent on an older route. */
export function parseAgentSettings(view: ProjectSettingsView): AgentSettingsState {
  const s = view.settings;
  return {
    form: {
      defaultModel: s.defaultModel,
      knowledge: s.knowledge,
      agents: s.agents ?? { mode: 'off', ids: [] },
      agentTools: s.agentTools ?? { mode: 'off', kinds: [] },
    },
    canEdit: view.canEdit,
    available: view.availableAgents ?? [],
  };
}

export const sameAgentSettings = (a: AgentSettingsForm, b: AgentSettingsForm): boolean => JSON.stringify(patchBody(a)) === JSON.stringify(patchBody(b));
