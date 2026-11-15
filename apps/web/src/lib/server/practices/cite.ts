/**
 * Citing (docs/practices.md#citing): an answer ends with "Practices followed: [handle@version], …" and a commit may carry
 * `Practice: handle@version` lines. Each citation is recorded as a `cited` row, but only for a practice version the caller
 * may get.
 */
import { PRACTICE_HANDLE, PRACTICE_LIMITS, PRACTICES_TRAILER, type ApprovedPractice } from '../../shared/practices';
import { canResource, executionWorkflowId } from '../projects/access';
import { HttpError } from '../errors';
import { practicesCitable, type PracticeCaller } from './applicable';
import { practicesPort } from './port';

const ITEM = /^([^\s@]+)@(\d{1,6})$/;

/** `handle@version` of each citation in a text: the trailer line's `[handle@version]` items and `Practice: handle@version` lines. In order, each once. */
export function parseCitations(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.replace(/^[\s>*_-]+/, '');
    if (trimmed.toLowerCase().startsWith(PRACTICES_TRAILER.toLowerCase())) {
      for (const m of trimmed.slice(PRACTICES_TRAILER.length).matchAll(/\[([^\]\s@]+@\d+)\]/g)) found.push(m[1]!);
    } else {
      const m = /^Practice:\s*([^\s@]+@\d+)\s*$/i.exec(trimmed);
      if (m) found.push(m[1]!);
    }
  }
  return [...new Set(found)];
}

export interface CiteInput {
  text?: string;
  citations?: string[];
  executionId?: string;
  repo?: string;
}

/**
 * Records a `cited` row for each citation that names an approved version (the current one or an earlier one) of a practice
 * the caller may get; the rest are `unknown`. Throws 404 for an execution the caller may not read.
 */
export function recordCitations(caller: PracticeCaller, input: CiteInput): { recorded: string[]; unknown: string[] } {
  const wanted = [...new Set([...(input.citations ?? []), ...(input.text ? parseCitations(input.text) : [])])].slice(0, PRACTICE_LIMITS.citations);
  if (input.executionId) {
    const workflowId = executionWorkflowId(input.executionId);
    if (!workflowId || (caller.actor && !canResource(caller.actor, 'workflow', workflowId, 'read'))) throw new HttpError('Execution not found', 404);
  }
  const port = practicesPort();
  const allowed = new Map<string, ApprovedPractice>();
  // The project's practice stands in for the organization's with the same handle, as in selection.
  for (const p of practicesCitable(caller)) if (!allowed.has(p.handle) || p.level === 'project') allowed.set(p.handle, p);
  const recorded: string[] = [];
  const unknown: string[] = [];
  for (const citation of wanted) {
    const m = ITEM.exec(citation);
    const practice = m && PRACTICE_HANDLE.test(m[1]!) ? allowed.get(m[1]!) : undefined;
    const version = m ? Number(m[2]) : 0;
    if (!port || !practice || version < 1 || version > practice.version) {
      unknown.push(citation);
      continue;
    }
    port.record({
      practiceId: practice.id,
      version,
      kind: 'cited',
      ...(caller.actor && { userId: caller.actor.id }),
      ...(input.executionId && { executionId: input.executionId }),
      ...(input.repo && { repo: input.repo }),
    });
    recorded.push(citation);
  }
  return { recorded, unknown };
}
