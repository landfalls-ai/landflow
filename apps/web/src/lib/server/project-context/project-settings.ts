/**
 * A project's settings for the agents that run in it (docs/projects-and-goals.md#project-settings-for-agents): the
 * runtime's one read per run (`projectAgentRules`), which tool kind a built tool is, and the checks a save makes
 * (a credential the project can use, an agent available in it). Each setting only narrows or fills a gap; with none
 * set a run is as it was. Plain server module.
 */
import { agentAllowedBy, toolKindAllowedBy, type ProjectSettings, type ProjectToolKind } from '../../shared/project-policy';
import { MCP_CLIENT_TOOL, type BuiltTool } from '../agents/tools';
import { HttpError } from '../errors';
import { getProjectSettings, type projectSettingsPatchSchema } from '../governance/scopes';
import { agentAvailableIn, availableAgentIds, credentialUsableBy } from '../projects/access';
import { getProject, homeProjectId } from '../projects/store';
import { credentials } from '../credentials/vault';
import type { z } from 'zod';

type Patch = z.infer<typeof projectSettingsPatchSchema>;

/** What a run in a project must obey. Undefined when the project has no agent settings on (the common case). */
export interface ProjectAgentRules {
  projectId: string;
  projectName: string;
  settings: ProjectSettings;
  /** Whether the agent may run here (the project's own agents always may). */
  agentAllowed(agentId: string): boolean;
  /** Whether a built tool may be offered here. */
  toolAllowed(tool: BuiltTool): boolean;
}

/** What a run says when the project doesn't allow the agent. */
export const agentNotAllowedMessage = (agentName: string, projectName: string) => `“${agentName}” isn't allowed in project “${projectName}” (Project settings → Agents)`;

/** The settings are cached for a second by `getProjectSettings`; nothing here reads per model call. */
export function projectAgentRules(projectId: string | undefined): ProjectAgentRules | undefined {
  if (!projectId) return undefined;
  const settings = getProjectSettings(projectId);
  const active = settings.defaultModel || settings.knowledge?.enabled || settings.agents?.mode === 'allow' || settings.agentTools?.mode === 'allow';
  if (!active) return undefined;
  return {
    projectId,
    projectName: getProject(projectId)?.name ?? 'this project',
    settings,
    agentAllowed: (agentId) => agentAllowedBy(settings, agentId, homeProjectId('agent', agentId) === projectId),
    toolAllowed: (tool) => toolKindAllowedBy(settings, projectToolKind(tool)),
  };
}

/**
 * The kind a project can allow or withhold for a tool (undefined: never withheld: skills, memory, a team's tools and a
 * workflow's own connected tools). Pure.
 */
export function projectToolKind(tool: Pick<BuiltTool, 'kind' | 'nodeType' | 'knowledge'>): ProjectToolKind | undefined {
  if (tool.knowledge) return 'knowledge';
  if (tool.nodeType === MCP_CLIENT_TOOL) return 'mcp';
  return tool.kind === 'node' || tool.kind === 'workflow' || tool.kind === 'agent' || tool.kind === 'a2a' ? tool.kind : undefined;
}

const bad = (message: string) => new HttpError(message, 400);

/**
 * Throws a 400 when a patch names a credential the project can't use (or of the wrong type) or an agent that isn't
 * available in the project. Called by the settings route before it saves.
 */
export function assertAgentSettingsPatch(projectId: string, patch: Patch): void {
  const unusable = 'That credential isn’t available in this project';
  const checkRef = (ref: { id: string } | undefined, type?: string) => {
    if (!ref?.id) return;
    if (!credentialUsableBy(ref.id, projectId)) throw bad(unusable);
    if (type && credentials.get(ref.id)?.type !== type) throw bad('That credential is not the right type for this model');
  };
  const model = patch.defaultModel;
  if (model) {
    if (model.provider === 'ollama' && model.credential) throw bad('An Ollama model takes no credential');
    if (model.provider !== 'ollama' && model.baseUrl) throw bad('Only an Ollama model takes a base URL');
    checkRef(model.credential, model.provider === 'anthropic' ? 'core.anthropicApi' : model.provider === 'openai' ? 'core.openAiApi' : undefined);
    if (model.provider === 'openai' && !model.credential) throw bad('Choose an OpenAI API credential for the model');
  }
  const tool = patch.knowledge?.tool;
  if (tool) {
    if (tool.source === 'notion-brain') {
      // NB06: names no credential; the runtime builds it for the project's own link
    } else if (tool.source === 'node') for (const ref of Object.values(tool.credentials ?? {})) checkRef(ref);
    else {
      checkRef(tool.credential);
      checkRef(tool.embeddings.credential);
    }
  }
  for (const id of patch.agents?.ids ?? []) if (!agentAvailableIn(id, projectId)) throw bad(`“${id}” isn’t available in this project`);
}

/** The agents available in a project, sorted by name, for the settings view. */
export function availableAgentsView(projectId: string, agents: Array<{ id: string; name: string }>): Array<{ id: string; name: string; home: boolean }> {
  const available = availableAgentIds(projectId, agents.map((agent) => agent.id));
  return agents
    .filter((agent) => available.has(agent.id))
    .map((agent) => ({ id: agent.id, name: agent.name, home: homeProjectId('agent', agent.id) === projectId }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
