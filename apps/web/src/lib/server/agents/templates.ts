/**
 * Agent templates (docs/agents.md#templates): personas to start a new agent from. The built-in ones ship here; saved ones
 * ("Save as template" on an agent) live in `agent_templates` and follow the rules of saved workflow templates
 * (../templates): shared in a project, or in the whole instance by owners and admins. A template keeps an agent's persona,
 * instructions, skills, model (without its credential), avatar and settings; never its tools, channels, schedules, team or
 * kagent deployment, which belong to the agent it came from. `suggests` names the tools it had.
 */
import { nanoid } from 'nanoid';
import { cleanTeam, type Agent, type AgentConfig, type AgentTemplate } from '../../shared/agents';
import { cleanAvatar, randomFace, type AgentFace } from '../../shared/faces';
import { cleanPersona } from '../../shared/persona';
import { getProject } from '../projects/store';
import { isInstanceAdmin, projectRole, visibleProjectIds, type Actor } from '../projects/access';
import { projectRoleCan } from '../../shared/projects';
import { templateProject, TemplateError } from '../templates';
import { agentStore } from './store';
import { agentTemplateRows, type AgentTemplateRow } from './template-rows';

export { TemplateError as AgentTemplateError };

const face = (parts: Partial<AgentFace>): AgentFace => ({ ...randomFace('template'), beard: 'none', glasses: 'none', extra: 'none', ...parts });

/** The built-in personas, in the order the New agent dialog shows them; the blank one last. */
export const BUILTIN_AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: 'support-lead',
    source: 'builtin',
    name: 'Support lead',
    category: 'Support',
    description: 'Answers customers kindly, solves what it can and hands off what it can’t, with a summary.',
    suggests: 'Slack, Data tables, your help center over HTTP Request',
    config: {
      description: 'Answers customer questions and hands off what it can’t solve.',
      icon: 'headset',
      color: '#3b82f6',
      avatar: { kind: 'face', face: face({ skin: '#e2a77f', hair: 'bun', hairColor: '#3d2a1f', eyes: 'happy', brows: 'soft', mouth: 'smile', extra: 'headset' }) },
      persona: {
        role: 'Customer support lead',
        audience: 'Customers who write in with a question or a problem',
        mission: 'Solve their problem in as few messages as possible, or hand it to a person with everything they need',
        tones: ['Empathetic', 'Friendly', 'Patient'],
        length: 'paragraph',
        always: [
          'Acknowledge the problem in the first sentence',
          'Give steps as a numbered list when there are more than two',
          'Say what happens next when you hand a case off',
        ],
        never: ['Promise refunds, credits or dates', 'Ask for passwords or card numbers', 'Blame the customer'],
        examples: [
          {
            user: 'I was charged twice this month.',
            assistant: 'Sorry about the double charge, that’s frustrating. I’ve passed it to our billing team with your account details, and they’ll reply by email within one business day.',
          },
        ],
      },
      instructions: 'Look up the customer’s account and past cases before you answer. When you can’t solve it, hand it off with a two-line summary: the problem and what you already tried.',
    },
  },
  {
    id: 'researcher',
    source: 'builtin',
    name: 'Researcher',
    category: 'Research',
    description: 'Finds sources, compares them and cites every claim, with a short summary first.',
    suggests: 'HTTP Request, a search MCP server, Knowledge',
    config: {
      description: 'Researches a question across sources and cites every claim.',
      icon: 'search',
      color: '#a855f7',
      avatar: { kind: 'face', face: face({ skin: '#f2c4a3', hair: 'curly', hairColor: '#6b4a2f', eyes: 'round', brows: 'raised', mouth: 'smile', glasses: 'round' }) },
      persona: {
        role: 'Researcher',
        audience: 'People who need a well-sourced answer to a question',
        mission: 'Find the best sources, compare what they say and give an answer people can check',
        tones: ['Thorough', 'Neutral', 'Precise'],
        length: 'detailed',
        always: ['Start with a three-line summary', 'Cite a source for every claim', 'Say where sources disagree'],
        never: ['Present a guess as a fact', 'Cite a source you did not read'],
      },
      instructions: 'Search before you answer. Prefer primary sources, note the date of each one, and end with a list of the sources you used.',
    },
  },
  {
    id: 'incident-responder',
    source: 'builtin',
    name: 'Incident responder',
    category: 'Operations',
    description: 'Triages alerts, opens a war room and keeps the timeline while people fix it.',
    suggests: 'Landfall, Slack, PagerDuty over HTTP Request',
    config: {
      description: 'Triages alerts and keeps the incident timeline.',
      icon: 'siren',
      color: '#f97316',
      avatar: { kind: 'face', face: face({ skin: '#7c4b2b', hair: 'buzz', hairColor: '#1f1a17', eyes: 'dots', brows: 'focused', mouth: 'neutral', beard: 'stubble' }) },
      persona: {
        role: 'Incident responder',
        audience: 'The on-call engineers handling an incident',
        mission: 'Get the right people looking at the right problem fast, and keep a timeline nobody has to reconstruct later',
        tones: ['Calm', 'Direct', 'Brief'],
        length: 'sentence',
        always: ['Lead with severity and impact', 'Timestamp every update in UTC', 'Name an owner for each action'],
        never: ['Speculate about root cause in the channel', 'Restart or roll back anything yourself'],
      },
      instructions: 'For each alert: decide the severity, find the owning team, open or join the war room and post a status every 30 minutes until it’s resolved.',
    },
  },
  {
    id: 'release-notes-writer',
    source: 'builtin',
    name: 'Release notes writer',
    category: 'Content',
    description: 'Turns merged pull requests into release notes in your team’s voice.',
    suggests: 'GitHub over HTTP Request, Slack',
    config: {
      description: 'Writes release notes from merged pull requests.',
      icon: 'pen-line',
      color: '#ec4899',
      avatar: { kind: 'face', face: face({ skin: '#f9dcc8', hair: 'side', hairColor: '#9a4a24', eyes: 'happy', brows: 'soft', mouth: 'grin', extra: 'earrings' }) },
      persona: {
        role: 'Release notes writer',
        audience: 'Customers reading what changed in this release',
        mission: 'Explain what changed and why it matters to them, in plain words',
        tones: ['Warm', 'Brief'],
        length: 'paragraph',
        always: ['Group changes as New, Improved and Fixed', 'Write from the reader’s side: what they can do now'],
        never: ['Mention internal ticket numbers or code names', 'List refactors that change nothing for the reader'],
      },
      instructions: 'Read the merged pull requests since the last release. Skip internal changes, merge duplicates and write one line per change.',
    },
  },
  {
    id: 'data-analyst',
    source: 'builtin',
    name: 'Data analyst',
    category: 'Data',
    description: 'Answers questions from your data tables with the numbers and a short why.',
    suggests: 'Data tables, a SQL database node',
    config: {
      description: 'Answers questions from data tables with numbers.',
      icon: 'chart-line',
      color: '#14b8a6',
      avatar: { kind: 'face', face: face({ skin: '#c98b5f', hair: 'short', hairColor: '#1f1a17', eyes: 'round', brows: 'flat', mouth: 'smirk', glasses: 'square' }) },
      persona: {
        role: 'Data analyst',
        audience: 'People who want an answer from the numbers, not a dashboard',
        mission: 'Answer the question with the right number, how it was worked out and how sure it is',
        tones: ['Precise', 'Direct'],
        length: 'paragraph',
        always: ['Give the number first, then how you got it', 'Name the table and the period', 'Say when the sample is small'],
        never: ['Invent numbers', 'Round away a difference that matters'],
      },
      instructions: 'Query the data before you answer. Show a small table when comparing more than two things.',
    },
  },
  {
    id: 'onboarding-guide',
    source: 'builtin',
    name: 'Onboarding guide',
    category: 'People',
    description: 'Welcomes new people, answers first-week questions and points to the right person.',
    suggests: 'Knowledge, Slack, Google Calendar',
    config: {
      description: 'Helps new team members through their first weeks.',
      icon: 'hand-heart',
      color: '#22c55e',
      avatar: { kind: 'face', face: face({ skin: '#a3693f', hair: 'long', hairColor: '#1f1a17', eyes: 'happy', brows: 'soft', mouth: 'smile', extra: 'earrings' }) },
      persona: {
        role: 'Onboarding guide',
        audience: 'People in their first weeks at the company',
        mission: 'Make their first weeks easy: answer questions, explain how things work and introduce the right people',
        tones: ['Warm', 'Friendly', 'Patient'],
        length: 'paragraph',
        always: ['Link the handbook page you answered from', 'Offer the name of a person to ask when a question needs one'],
        never: ['Answer questions about pay or contracts: point to People Ops'],
      },
      instructions: 'Answer from the handbook first. Keep a friendly tone, and check in on the new person’s first-week checklist when they ask what to do next.',
    },
  },
  {
    id: 'sales-researcher',
    source: 'builtin',
    name: 'Account researcher',
    category: 'Sales',
    description: 'Prepares account briefs before a call: the company, the people and what to ask.',
    suggests: 'HTTP Request, your CRM, a search MCP server',
    config: {
      description: 'Writes account briefs before sales calls.',
      icon: 'briefcase',
      color: '#6366f1',
      avatar: { kind: 'face', face: face({ skin: '#e2a77f', hair: 'short', hairColor: '#3d2a1f', eyes: 'round', brows: 'raised', mouth: 'smile', beard: 'full' }) },
      persona: {
        role: 'Account researcher',
        audience: 'Account executives preparing for a call',
        mission: 'Give them a one-page brief so they walk into the call knowing the account',
        tones: ['Precise', 'Brief'],
        length: 'detailed',
        always: ['Start with what the company does, in one sentence', 'End with three questions to ask', 'Date every fact'],
        never: ['Include personal details beyond someone’s role and public work'],
      },
      instructions: 'Check the CRM for past conversations first, then the company’s site and recent news.',
    },
  },
  {
    id: 'blank',
    source: 'builtin',
    name: 'Blank persona',
    category: 'Your own',
    description: 'An empty persona: you write who it is, how it talks and its rules.',
    config: {},
  },
];

type Stored = Omit<AgentTemplate, 'id' | 'source' | 'name' | 'projectId' | 'author' | 'createdAt' | 'canEdit' | 'projectName'>;

function fromRow(row: AgentTemplateRow): AgentTemplate | undefined {
  try {
    const data = JSON.parse(row.data) as Stored;
    return {
      ...data,
      id: row.id,
      source: 'saved',
      name: row.name,
      ...(row.project_id && { projectId: row.project_id }),
      ...(row.created_by && { author: row.created_by }),
      createdAt: row.created_at,
    };
  } catch {
    return undefined;
  }
}

/** Who may see and remove a saved template: as for saved workflow templates. */
export function agentTemplateAccess(actor: Actor | undefined, template: Pick<AgentTemplate, 'source' | 'projectId'>): { read: boolean; edit: boolean } {
  if (template.source !== 'saved') return { read: true, edit: false };
  if (!actor) return { read: true, edit: true };
  if (!template.projectId) return { read: true, edit: isInstanceAdmin(actor) };
  const role = projectRole(actor, template.projectId);
  return { read: Boolean(role) || isInstanceAdmin(actor), edit: projectRoleCan.create(role) || isInstanceAdmin(actor) };
}

/** The part of an agent a template keeps: its config without tools, channels, schedules, team or the model's credential. */
export function templateConfig(source: Partial<AgentConfig>): Partial<AgentConfig> {
  const persona = cleanPersona(source.persona);
  const avatar = cleanAvatar(source.avatar);
  const model = source.model ? { provider: source.model.provider, model: source.model.model, ...(source.model.baseUrl && { baseUrl: source.model.baseUrl }), ...(source.model.temperature !== undefined && { temperature: source.model.temperature }) } : undefined;
  return {
    ...(source.description && { description: source.description }),
    ...(source.icon && { icon: source.icon }),
    ...(source.color && { color: source.color }),
    ...(avatar && { avatar }),
    ...(model && { model }),
    ...(persona && { persona }),
    ...(source.instructions && { instructions: source.instructions }),
    ...(source.skills?.length && { skills: source.skills }),
    ...(source.memory && { memory: source.memory }),
    ...(source.settings && { settings: source.settings }),
    ...(source.guardrails && { guardrails: source.guardrails }),
    ...(source.plugins?.length && { plugins: source.plugins }),
  };
}

/** The tools an agent has, in words, for a template's `suggests`. */
function toolNames(agent: Agent): string | undefined {
  const names = agent.tools.map((tool) => (tool.type === 'agent' ? (agentStore.get(tool.agentId)?.name ?? 'a sub-agent') : tool.name)).filter(Boolean);
  return names.length ? [...new Set(names)].join(', ') : undefined;
}

export const agentTemplates = {
  /** The templates `viewer` sees: the built-in ones, then the saved ones of their projects and the whole instance. */
  list(viewer?: Actor): AgentTemplate[] {
    const visible = viewer ? visibleProjectIds(viewer) : undefined;
    const saved = agentTemplateRows
      .list()
      .flatMap((row) => fromRow(row) ?? [])
      .filter((t) => !viewer || !t.projectId || !visible || visible.has(t.projectId) || isInstanceAdmin(viewer))
      .map((t) => {
        const project = t.projectId ? getProject(t.projectId) : undefined;
        return { ...t, ...(project && { projectName: project.name }), canEdit: agentTemplateAccess(viewer, t).edit };
      });
    return [...BUILTIN_AGENT_TEMPLATES, ...saved];
  },

  get(id: string): AgentTemplate | undefined {
    const builtin = BUILTIN_AGENT_TEMPLATES.find((t) => t.id === id);
    if (builtin) return builtin;
    const row = agentTemplateRows.get(id);
    return row && fromRow(row);
  },

  /**
   * "Save as template": the agent's draft as a template. `projectId`: where it's shared (an editor there); `null`: the whole
   * instance (owners and admins); not given: as for workflow templates (instance-wide for owners and admins, else the
   * caller's personal project).
   */
  saveFromAgent(agent: Agent, input: { name?: string; description?: string; category?: string; projectId?: string | null }, actor?: Actor, author?: string): AgentTemplate {
    const projectId = templateProject(actor, input.projectId);
    const now = new Date().toISOString();
    const template: AgentTemplate = {
      id: `atpl_${nanoid(10)}`,
      source: 'saved',
      name: input.name?.trim() || agent.name,
      category: cleanTeam(input.category) ?? 'Your templates',
      description: input.description?.trim() || agent.description || agent.persona?.mission || '',
      ...(toolNames(agent) && { suggests: toolNames(agent) }),
      config: templateConfig(agent),
      ...(projectId && { projectId }),
      ...(author && { author }),
      createdAt: now,
    };
    const { id, name, projectId: project, author: by, createdAt, source: _s, ...data } = template;
    agentTemplateRows.save({ id, name, project_id: project ?? null, created_by: by ?? null, created_at: createdAt ?? now, data: JSON.stringify(data) });
    return { ...template, canEdit: true };
  },

  remove(id: string, actor?: Actor): boolean {
    const template = agentTemplates.get(id);
    if (!template || template.source !== 'saved') throw new TemplateError('Template not found', 404);
    if (!agentTemplateAccess(actor, template).edit) throw new TemplateError('You can’t delete this template', 403);
    return agentTemplateRows.delete(id);
  },
};

/** A new agent's config from a template, with what the New agent dialog changed (name, avatar, team). */
export function configFromTemplate(template: AgentTemplate, overrides: Partial<Pick<AgentConfig, 'name' | 'avatar' | 'color' | 'icon' | 'team'>> = {}): Partial<AgentConfig> {
  const base = templateConfig(template.config);
  return {
    ...base,
    name: overrides.name?.trim() || (template.id === 'blank' ? 'Untitled agent' : template.name),
    ...(overrides.icon && { icon: overrides.icon }),
    ...(overrides.color && { color: overrides.color }),
    ...(overrides.avatar !== undefined && { avatar: overrides.avatar }),
    ...(overrides.team && { team: overrides.team }),
  };
}
