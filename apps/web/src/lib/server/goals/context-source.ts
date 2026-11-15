/**
 * The goals store's side of the project-context seam (docs/projects-and-goals.md#what-an-agent-sees): the mission, a project's
 * brief and its goals, and a goal's chain of parents, for the block the agents runtime builds. Set at module load through
 * `setContextDataSource` (imported by lib/server/runtime.ts). Reads are cached for a second per key.
 */
import { CONTEXT_LIMITS, type ContextDataSource, type ContextGoalData, type ContextProjectData } from '../../shared/project-context';
import { getUser } from '../auth/users';
import { getProject } from '../projects/store';
import { setContextDataSource } from '../project-context/seam';
import { companyProfile } from '../settings';
import { singleton } from '../singleton';
import { chain, projectGoalIds } from './store';

const CACHE_MS = 1000;
interface Cached<T> {
  at: number;
  value: T;
}
const caches = () =>
  singleton('goals-context-cache', () => ({
    mission: undefined as Cached<string | undefined> | undefined,
    projects: new Map<string, Cached<ContextProjectData | undefined>>(),
    chains: new Map<string, Cached<ContextGoalData[]>>(),
  }));

function cached<T>(map: Map<string, Cached<T>>, key: string, load: () => T): T {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = load();
  map.set(key, { at: Date.now(), value });
  if (map.size > 500) map.delete(map.keys().next().value as string);
  return value;
}

function loadProject(id: string): ContextProjectData | undefined {
  const project = getProject(id);
  if (!project) return undefined;
  const leadName = project.leadId ? getUser(project.leadId)?.name : undefined;
  return {
    id: project.id,
    name: project.name,
    ...(project.brief && { brief: project.brief }),
    ...(project.briefConstraints && { constraints: project.briefConstraints }),
    ...(project.doneWhen && { doneWhen: project.doneWhen }),
    ...(project.glossary && { glossary: project.glossary }),
    ...(project.status && { status: project.status }),
    ...(project.targetDate && { targetDate: project.targetDate }),
    ...(leadName && { leadName }),
    goalIds: projectGoalIds(id, { withoutCancelled: true }),
  };
}

function loadChain(id: string): ContextGoalData[] {
  return chain(id, CONTEXT_LIMITS.chain).map((goal) => {
    const ownerName = goal.ownerId ? getUser(goal.ownerId)?.name : undefined;
    return { id: goal.id, title: goal.title, level: goal.level, status: goal.status, ...(ownerName && { ownerName }), ...(goal.targetDate && { targetDate: goal.targetDate }), ...(goal.why && { why: goal.why }) };
  });
}

export const goalsContextSource: ContextDataSource = {
  mission() {
    const state = caches();
    if (!state.mission || Date.now() - state.mission.at >= CACHE_MS) state.mission = { at: Date.now(), value: companyProfile().mission };
    return state.mission.value;
  },
  project: (id) => cached(caches().projects, id, () => loadProject(id)),
  goalChain: (id) => cached(caches().chains, id, () => loadChain(id)),
};

setContextDataSource(goalsContextSource);
