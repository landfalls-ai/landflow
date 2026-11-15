/**
 * Practices for remote agents (docs/practices.md#kagent-agents-and-a2a): a Landflow agent on kagent gets a short index of the
 * approved practices that apply with each new request, and reads one in full with `practices_for` on its MCP server
 * (kagent/practice-tools.ts). The index goes to the first message of a new conversation only, after the project block and
 * before the task; any other A2A agent gets nothing new. It is not recorded as delivered: `practices_for` records what the
 * agent read in full, and its answer's citations are recorded as cited.
 */
import type { RunPractice } from '../../shared/project-context';
import { PRACTICES_TRAILER } from '../../shared/practices';
import { agentAtEndpoint } from '../notebook/binding';
import { currentRunContext } from '../project-context/seam';
import { citedIn, recordRunPractices, runPractices, type PracticesSwitch } from '../project-context/practices';

/** The line after the index: how the agent reads a practice in full and says which it followed. */
export const PRACTICES_INDEX_LINE = `Call practices_for for a practice's full rules, and end your answer with "${PRACTICES_TRAILER} [handle@version]" for those you followed.`;

export interface PracticesIndex {
  /** The index block (the practices source's `index` text). */
  text: string;
  practices: RunPractice[];
  /** The Landflow agent on kagent the request goes to. */
  agentId: string;
  projectId?: string;
}

/**
 * The index for a new request to `endpoint`: undefined when the endpoint is not a Landflow agent on kagent, the option is
 * Off or no approved practice applies. `projectId` is the run's (the server resolved it); it defaults to the run in progress.
 */
export function practicesIndexFor(endpoint: string, option: PracticesSwitch | undefined, task: string, projectId?: string): PracticesIndex | undefined {
  if (option === 'off') return undefined;
  const agent = agentAtEndpoint(endpoint);
  if (!agent) return undefined;
  const project = projectId ?? currentRunContext()?.projectId;
  const selection = runPractices(option, { ...(project && { projectId: project }), agentId: agent.id, task: task.slice(0, 500), size: 'index' });
  if (!selection.text) return undefined;
  return { text: selection.text, practices: selection.practices, agentId: agent.id, ...(project && { projectId: project }) };
}

/**
 * The request's text with the index in front of the task, after the project block when the text begins with `block`. An
 * empty index, or a text that already carries one, comes back unchanged.
 */
export function withPracticesIndex(text: string, index: string, block?: string): string {
  if (!index || text.includes(PRACTICES_INDEX_LINE)) return text;
  const added = `${index}\n\n${PRACTICES_INDEX_LINE}`;
  if (block && text.startsWith(block)) {
    const rest = text.slice(block.length).replace(/^\n+/, '');
    return rest ? `${block}\n\n${added}\n\n${rest}` : `${block}\n\n${added}`;
  }
  return `${added}\n\n${text}`;
}

/** Whether a request already carries an index (a team put it there): the capability under it adds none and records nothing. */
export const carriesPracticesIndex = (text: string): boolean => text.includes(PRACTICES_INDEX_LINE);

/** Records the indexed practices a remote answer cites, against the run. Never throws. */
export function recordRemoteCitations(index: PracticesIndex | undefined, answer: string, executionId?: string): void {
  if (!index) return;
  recordRunPractices('cited', citedIn(answer, index.practices), { ...(index.projectId && { projectId: index.projectId }), ...(executionId && { executionId }), agentId: index.agentId });
}
