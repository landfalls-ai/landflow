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

/** The PATCH body: the four fields (`null` clears one). */
export const patchBody = (form: AgentSettingsForm) => ({
  defaultModel: form.defaultModel ?? null,
  knowledge: form.knowledge ?? null,
  agents: form.agents,
  agentTools: form.agentTools,
});

/**
 * The PATCH body for a save: only the fields that differ from `saved` (the route keeps the rest), and the allowed-agent ids
 * limited to `available` when it is known, so an agent that was deleted or unshared never makes the save a 400.
 */
export function savePatch(form: AgentSettingsForm, saved: AgentSettingsForm, available: AgentSettingsState['available'] = []): Partial<ReturnType<typeof patchBody>> {
  const next = patchBody(form);
  const prev = patchBody(saved);
  const out: Partial<typeof next> = {};
  for (const key of Object.keys(next) as Array<keyof typeof next>) {
    if (JSON.stringify(next[key]) !== JSON.stringify(prev[key])) (out as Record<string, unknown>)[key] = next[key];
  }
  if (out.agents && available.length > 0) {
    const known = new Set(available.map((a) => a.id));
    out.agents = { ...out.agents, ids: out.agents.ids.filter((id) => known.has(id)) };
  }
  return out;
}

export const saveAgentSettings = (projectId: string, form: AgentSettingsForm, saved: AgentSettingsForm, available: AgentSettingsState['available'] = []) =>
  api<ProjectSettingsView>(url(projectId), { method: 'PATCH', json: savePatch(form, saved, available) });

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
