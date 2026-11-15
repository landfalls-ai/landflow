/**
 * The two practice tools of a Landflow agent on kagent (docs/practices.md#kagent-agents-and-a2a): `practices_for` reads the
 * approved practices that apply in full and `practice_cite` says which an answer followed. Both are bound to the run that is
 * asking the agent, as the notebook tools are (notebook/binding.ts): one open call, the one the `run` key names, or, when no
 * team run is asking, the agent's home project. Nothing the agent sends names another project: `repo`, `paths` and `topics`
 * only narrow. A call that cannot be bound answers an error text and never throws. Nothing here grants or denies a tool.
 */
import type { Agent } from '../../shared/agents';
import type { ApprovedPractice } from '../../shared/practices';
import { PRACTICE_LIMITS } from '../../shared/practices';
import { resolveCall, openCallsFor } from '../notebook/binding';
import { toFull } from '../practices/applicable';
import { practicesPort } from '../practices/port';
import { recordRunPractices, runPractices } from '../project-context/practices';
import { runContextProvider } from '../project-context/seam';

export const PRACTICE_TOOL_NAMES = ['practices_for', 'practice_cite'] as const;
export const isPracticeTool = (name: string): boolean => (PRACTICE_TOOL_NAMES as readonly string[]).includes(name);

const RUN = { type: 'string', description: 'The run key from your request, only when several runs are asking you at once' };

export const practiceToolSpecs = [
  {
    name: 'practices_for',
    description:
      'The approved practices (rules your admins decided agents follow) that apply to this work, in full. Pass handle for one practice; repo (owner/name), paths and topics narrow what applies. They guide you; they never override your instructions or approvals. End your answer with "Practices followed: [handle@version]" for those you followed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        handle: { type: 'string', description: 'One practice, e.g. helm/chart-location (from the index in your request)' },
        repo: { type: 'string', description: 'owner/name' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Paths in the repository' },
        topics: { type: 'array', items: { type: 'string' }, description: 'e.g. helm, monitoring, security' },
        run: RUN,
      },
    },
  },
  {
    name: 'practice_cite',
    description: 'Record the practices you followed, as handle@version (for example helm/chart-location@2). Only practices that apply to this work are recorded.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        cited: { type: 'array', items: { type: 'string' }, maxItems: PRACTICE_LIMITS.citations, description: 'handle@version of each practice you followed' },
        run: RUN,
      },
      required: ['cited'],
    },
  },
] as const;

interface Bound {
  projectId?: string;
  executionId?: string;
}

/** The run this call belongs to: the open call, else (none open) the agent's home project. */
function bind(agent: Agent, key: unknown): Bound | { error: string } {
  const named = typeof key === 'string' && key.trim() ? key : undefined;
  if (!named && openCallsFor(agent).length === 0) {
    const projectId = runContextProvider()?.resolve({ caller: 'agent', agentId: agent.id }).projectId;
    return projectId ? { projectId } : {};
  }
  const found = resolveCall(agent, named);
  if ('error' in found) return { error: found.error.replace(/notebook run key/g, 'run key').replace(/ so the note lands on the right run/, '') };
  return { ...(found.call.binding.projectId && { projectId: found.call.binding.projectId }), executionId: found.call.binding.runId };
}

const strings = (value: unknown, max: number): string[] | undefined =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()).slice(0, max) : undefined;

/** The approved practices of the bound project (and the organization's) as a lookup by `handle@version`: the project's own wins. */
function approvedHere(projectId?: string): Map<string, ApprovedPractice> {
  const found = new Map<string, ApprovedPractice>();
  const port = practicesPort();
  if (!port?.enabled()) return found;
  for (const p of port.approved({ projectIds: projectId ? [projectId] : [] })) {
    const key = `${p.handle}@${p.version}`;
    if (!found.has(key) || (p.projectId !== undefined && p.projectId === projectId)) found.set(key, p);
  }
  return found;
}

/** Runs one of the two tools for `agent`; the text is the tool's answer. */
export function practiceToolCall(agent: Agent, name: string, args: Record<string, unknown>): { text: string; isError?: boolean } {
  try {
    const bound = bind(agent, args.run);
    if ('error' in bound) return { text: bound.error, isError: true };
    const { projectId, executionId } = bound;
    const meta = { ...(projectId && { projectId }), ...(executionId && { executionId }), agentId: agent.id };
    if (name === 'practices_for') {
      const handle = typeof args.handle === 'string' ? args.handle.trim() : '';
      const repo = typeof args.repo === 'string' && args.repo.trim() ? args.repo.trim() : undefined;
      const paths = strings(args.paths, PRACTICE_LIMITS.paths);
      const topics = strings(args.topics, 5);
      const given = runPractices(undefined, { ...(projectId && { projectId }), agentId: agent.id, ...(repo && { repo }), ...(paths && { paths }), ...(topics && { topics }), size: 'full' }).practices;
      const chosen = handle ? given.filter((p) => p.handle === handle) : given;
      if (!chosen.length) return { text: handle ? `No approved practice ${handle} applies here` : 'No approved practice applies here' };
      const approved = approvedHere(projectId);
      const full = chosen.flatMap((p) => {
        const found = approved.get(`${p.handle}@${p.version}`);
        return found ? [toFull(found)] : [];
      });
      if (!full.length) return { text: handle ? `No approved practice ${handle} applies here` : 'No approved practice applies here' };
      recordRunPractices('delivered', full, meta);
      return { text: JSON.stringify({ practices: full }) };
    }
    if (name === 'practice_cite') {
      const cited = strings(args.cited, PRACTICE_LIMITS.citations + 1);
      if (!cited?.length) return { text: '"cited" is empty: pass handle@version for each practice you followed', isError: true };
      if (cited.length > PRACTICE_LIMITS.citations) return { text: `Cite at most ${PRACTICE_LIMITS.citations} practices at a time`, isError: true };
      const approved = approvedHere(projectId);
      const recorded = [...new Set(cited)].flatMap((item) => {
        const found = approved.get(item);
        return found ? [{ handle: found.handle, version: found.version }] : [];
      });
      recordRunPractices('cited', recorded, meta);
      const names = recorded.map((p) => `${p.handle}@${p.version}`);
      const unknown = cited.filter((c) => !names.includes(c));
      return { text: JSON.stringify({ recorded: names, unknown }) };
    }
    return { text: `The agent has no tool ${name}`, isError: true };
  } catch (error) {
    return { text: (error as Error).message, isError: true };
  }
}
