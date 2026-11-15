/**
 * A project → a Claude Code plugin (docs/marketplace.md#export-a-project): `PROJECT.md` with its brief and the goals it
 * serves, next to the agent files and skill files of the agents whose home it is. No people (lead, decision
 * owner, goal owners, members, who made what), no ids, no workspace, budget, settings, variables, credentials,
 * repositories, tasks or sessions. Every free text goes through the secret redaction first.
 */
import { LANDFLOW_PROJECT_KIND, type LandflowProjectData } from '../../shared/marketplace';
import { agentStore, configOf } from '../agents/store';
import { chain, projectGoalIds } from '../goals/store';
import { visibleGoal } from '../goals/views';
import { HttpError } from '../errors';
import { sentence, clean } from '../project-context/build';
import { projectRole, resourceIdsIn, getProject, type Actor } from '../projects';
import { redactPatterns, redactText } from '../secrets/redact';
import { companyProfile } from '../settings';
import { pluginFiles, quote, slugOf, type ExportFile, type ExportOptions, type PluginExport } from './export';

/** What a personal project is called in an export: it is named after its user. */
const PERSONAL_NAME = 'Personal project';

/** What `PROJECT.md` and `.landflow/project.json` are written from: already redacted, free of people and ids. */
export interface ProjectExportData {
  name: string;
  mission?: string;
  project: LandflowProjectData['project'];
  /** Root first within each chain; `parent` is an index in this array. */
  goals: LandflowProjectData['goals'];
  /** The agents whose home is the project: name and file slug. */
  agents: Array<{ name: string; slug: string }>;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
/** A free text with its secrets redacted and its line breaks kept. */
const text = (value: string | undefined) => (value ? redactPatterns(redactText(value)).replace(CONTROL, '').replace(/\r\n?/g, '\n').trim() : '');
const line = (value: string | undefined, cap = 200) => clean(value, cap);
const unstop = (value: string) => value.replace(/[.!?]+$/, '');

/** The first sentence of a text, on one line. */
function firstSentence(value: string): string {
  const flat = value.replace(/\s+/g, ' ').replace(/^(?:[#>\-*+]+\s*)+/, '').trim();
  const end = /(?<!\b(?:e\.g|i\.e|etc|vs))[.!?](\s|$)/i.exec(flat);
  return (end ? flat.slice(0, end.index + 1) : flat).slice(0, 200).trim();
}

/** The goal lines: the goals as a tree, each once, in the wording of the “Where this work fits” block, without owners. */
function goalLines(goals: ProjectExportData['goals']): string[] {
  const out: string[] = [];
  const walk = (index: number, depth: number) => {
    const g = goals[index]!;
    out.push(`${depth === 0 ? '' : `${' '.repeat(2 * (depth - 1))}└ `}Goal (${g.level}): ${unstop(g.title)}${g.targetDate ? `, by ${g.targetDate}` : ''}.`);
    goals.forEach((child, i) => child.parent === index && walk(i, depth + 1));
  };
  goals.forEach((g, i) => g.parent === undefined && walk(i, 0));
  return out;
}

/** `PROJECT.md`: pure. */
export function projectMarkdown(data: ProjectExportData): string {
  const { project } = data;
  const front = [
    `name: ${slugOf(data.name, 'project')}`,
    `title: ${quote(data.name)}`,
    ...(project.status ? [`status: ${quote(project.status)}`] : []),
    ...(project.targetDate ? [`target: ${quote(project.targetDate)}`] : []),
    ...(data.goals.length ? ['goals:', ...data.goals.flatMap((g) => [`  - title: ${quote(g.title)}`, `    level: ${quote(g.level)}`, `    status: ${quote(g.status)}`])] : []),
  ];
  const sections: string[] = [`# ${data.name}`];
  if (project.brief) sections.push(project.brief);
  if (project.constraints) sections.push(`## Constraints\n\n${project.constraints}`);
  if (project.doneWhen) sections.push(`## Done when\n\n${project.doneWhen}`);
  if (project.glossary) sections.push(`## Words we use\n\n${project.glossary}`);
  const fits = [...(data.mission ? [`Company mission: ${sentence(data.mission)}`] : []), ...goalLines(data.goals)];
  if (fits.length) sections.push(`## Fits under\n\n${fits.join('\n')}`);
  if (data.agents.length) sections.push(`## Agents\n\n${data.agents.map((a) => `- [${a.name.replace(/[\[\]\\\r\n]+/g, ' ').trim() || a.slug}](agents/${a.slug}.md)`).join('\n')}`);
  return `---\n${front.join('\n')}\n---\n\n${sections.join('\n\n')}\n`;
}

/** The goals the project serves and their chains to the root that `actor` sees, each once. */
function goalsOf(projectId: string, actor: Actor): ProjectExportData['goals'] {
  const goals: ProjectExportData['goals'] = [];
  const index = new Map<string, number>();
  for (const id of projectGoalIds(projectId, { withoutCancelled: true })) {
    if (!visibleGoal(actor, id)) continue;
    let parent: number | undefined;
    for (const goal of chain(id)) {
      if (!visibleGoal(actor, goal.id)) continue;
      if (!index.has(goal.id)) {
        const why = text(goal.why);
        index.set(goal.id, goals.length);
        goals.push({ title: line(goal.title) || 'Goal', level: goal.level, status: goal.status, ...(goal.targetDate && { targetDate: goal.targetDate }), ...(why && { why }), ...(parent !== undefined && { parent }) });
      }
      parent = index.get(goal.id);
    }
  }
  return goals;
}

/** The project as a plugin; a project `actor` has no role in is a 404. */
export function exportProjectPlugin(projectId: string, actor: Actor, options: ExportOptions = {}): PluginExport {
  const project = getProject(projectId);
  if (!project || !projectRole(actor, project.id)) throw new HttpError('Project not found', 404);
  const home = resourceIdsIn(project.id, 'agent').flatMap((id) => {
    const agent = agentStore.get(id);
    // The id only maps sub-agent tools to slugs; `localIds` keeps it out of the files.
    return agent ? [{ id, config: configOf(agent) }] : [];
  });
  // A personal project is named after its user: the export says no name.
  const personal = project.type === 'personal';
  const brief = text(project.brief);
  const fields: LandflowProjectData['project'] = {
    name: personal ? PERSONAL_NAME : line(project.name, 120) || 'Project',
    ...(brief && { brief }),
    ...(text(project.briefConstraints) && { constraints: text(project.briefConstraints) }),
    ...(text(project.doneWhen) && { doneWhen: text(project.doneWhen) }),
    ...(text(project.glossary) && { glossary: text(project.glossary) }),
    ...(project.status && { status: line(project.status, 40) }),
    ...(project.targetDate && { targetDate: line(project.targetDate, 10) }),
  };
  const goals = goalsOf(project.id, actor);
  const mission = line(companyProfile().mission, 400);
  const name = slugOf(fields.name, 'project');
  const description = (brief && firstSentence(brief)) || `${fields.name}, a Landflow project.`;
  // The exporting person's name is not written: the plugin's author is Landflow.
  return pluginFiles(name, description, home, undefined, { ...options, author: undefined }, {
    localIds: true,
    keywords: ['landflow', 'project'],
    readme: 'Exported from Landflow as a Claude Code plugin. PROJECT.md has its brief and goals, next to the project’s agents in `agents/` and their skills in `skills/`.',
    files: (slugs): ExportFile[] => {
      const agents = home.map((a, i) => ({ name: a.config.name, slug: slugs[i]! }));
      const data: LandflowProjectData = { kind: LANDFLOW_PROJECT_KIND, version: 1, project: fields, goals, agents: slugs };
      return [
        { path: 'PROJECT.md', content: projectMarkdown({ name: fields.name, mission: mission || undefined, project: fields, goals, agents }) },
        { path: '.landflow/project.json', content: `${JSON.stringify(data, null, 2)}\n` },
      ];
    },
  });
}
