/**
 * A run's practices (docs/practices.md#following): the one gate every Landflow path goes through before a run, a
 * preview or a remote request is given approved practices. It reads the seam's practices slot (./seam.ts), which
 * lib/server/practices/context-source.ts sets at boot (a side-effect import in lib/server/runtime.ts). Unset (a test, a
 * script that never boots the runtime), with LANDFLOW_PRACTICES=off, or with the switch off, a run gets nothing and its
 * prompt and cache key stay exactly as they were. It also writes what a run was given and what it cited
 * (`practice_applications`), the one way every path records them. Written by the plan for wave 8: PR06 owns it; PC07 and
 * PR07 add this file byte for byte; change it only in a later wave.
 */
import { createHash } from 'node:crypto';
import type { PracticesQuery, PracticesSelection, RunContext, RunPractice } from '../../shared/project-context';
import { parseCitations } from '../practices/cite';
import { practicesPort } from '../practices/port';
import { practicesSource } from './seam';

/** An agent's switch (`AgentConfig.practices`), or an A2A node's, capability's or remote member's option. Absent = on. */
export type PracticesSwitch = 'on' | 'off';

/** Nothing to follow. */
export const noPractices = (): PracticesSelection => ({ text: '', practices: [] });

/**
 * The approved practices a run would get for `query` (whose project the server resolved; repo, paths, topics and task
 * only narrow and rank). Reads only: it writes no `delivered` row, so a preview may call it. Never throws.
 */
export function runPractices(on: PracticesSwitch | undefined, query: PracticesQuery): PracticesSelection {
  if (on === 'off') return noPractices();
  try {
    return practicesSource()?.select(query) ?? noPractices();
  } catch {
    return noPractices();
  }
}

/** sha256 of a run's text, hex, first 16 characters ('' for ''): the same hash the provider gives `RunContext.hash`. */
export const runTextHash = (text: string): string => (text ? createHash('sha256').update(text).digest('hex').slice(0, 16) : '');

/**
 * The run's context with its practices: the practices block after the "Where this work fits" block (one blank line
 * between; alone when there is no project block), `hash` over the whole text, `practices` set. The context comes back
 * unchanged when the selection is empty, so a run without practices keeps its prompt and cache keys byte for byte.
 */
export function withPractices(ctx: RunContext, selection: PracticesSelection): RunContext {
  if (!selection.text) return ctx;
  const text = ctx.text ? `${ctx.text}\n\n${selection.text}` : selection.text;
  return { ...ctx, text, hash: runTextHash(text), practices: selection.practices, practicesText: selection.text }; // SP03:
}

/** Who a recorded row belongs to. `projectId` is the run's (the server resolved it), never a caller's. */
export interface RunPracticeMeta {
  projectId?: string;
  executionId?: string;
  agentId?: string;
  userId?: string;
  repo?: string;
}

/**
 * Writes one `delivered` or `cited` row per practice. Each `handle@version` is resolved to its id among the approved
 * practices the run's project may use (the project's own wins over an org practice with the same handle); one it can't
 * resolve is skipped. Never throws.
 */
export function recordRunPractices(kind: 'delivered' | 'cited', practices: readonly RunPractice[], meta: RunPracticeMeta): void {
  try {
    const port = practicesPort();
    if (!port?.enabled() || !practices.length) return;
    const approved = port.approved({ projectIds: meta.projectId ? [meta.projectId] : [] });
    for (const p of practices) {
      const matches = approved.filter((a) => a.handle === p.handle && a.version === p.version);
      const match = matches.find((a) => a.projectId !== undefined && a.projectId === meta.projectId) ?? matches[0];
      if (!match) continue;
      port.record({
        practiceId: match.id,
        version: match.version,
        kind,
        ...(meta.executionId && { executionId: meta.executionId }),
        ...(meta.agentId && { agentId: meta.agentId }),
        ...(meta.userId && { userId: meta.userId }),
        ...(meta.repo && { repo: meta.repo }),
      });
    }
  } catch {
    // Recording never breaks a run.
  }
}

/** The practices an answer cites ("Practices followed: [handle@version]" or `Practice:` lines) that the run was given; any other citation is ignored. */
export function citedIn(reply: string, given: readonly RunPractice[]): RunPractice[] {
  const cited = new Set(parseCitations(reply));
  return given.filter((p) => cited.has(`${p.handle}@${p.version}`));
}
