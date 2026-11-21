/**
 * The current state of memories a run was given (C11 D5): live or forgotten since, its version and, for a live one, its text
 * now. What the caller may not see is left out, so no "forgotten" hint leaks. Reads only.
 */
import { getFact } from '../brain/facts';
import { canFact } from '../brain/scope';
import { noteStore } from '../notebook/store';
import { canResource, type Actor } from '../projects/access';

export const MAX_ITEM_IDS = 50;

export interface MemoryItemState {
  id: string;
  /** Not forgotten and not past its forget-after. */
  live: boolean;
  version?: number;
  /** The text now (live items only). */
  text?: string;
  forgottenAt?: string;
  reason?: string;
  /** The caller may forget or rewrite it (the buttons on the inspector's line). */
  canChange?: boolean;
  /** A note's team (to forget it from the inspector). */
  teamId?: string;
}

const now = () => new Date().toISOString();

/** The state of each id (a fact's chain id, or a note's id) the actor may see; ids that are unknown or hidden are omitted. */
export function memoryItemStates(actor: Actor, ids: readonly string[]): MemoryItemState[] {
  const out: MemoryItemState[] = [];
  for (const id of new Set(ids.slice(0, MAX_ITEM_IDS))) {
    const fact = getFact(id, undefined, { includeForgotten: true });
    if (fact) {
      if (!canFact(actor, fact, 'read')) continue;
      const lapsed = Boolean(fact.forgottenAt || (fact.forgetAfter && fact.forgetAfter <= now()));
      const forgottenAt = fact.forgottenAt ?? (lapsed ? fact.forgetAfter : undefined);
      out.push({ id, live: !lapsed, ...(canFact(actor, fact, 'update') && { canChange: true }), version: fact.version ?? 1, ...(!lapsed && { text: fact.statement }), ...(forgottenAt && { forgottenAt }), ...(lapsed && fact.forgetReason && { reason: fact.forgetReason }) });
      continue;
    }
    const note = noteStore.get(id, { withForget: true });
    if (!note || !canResource(actor, 'agentTeam', note.teamId, 'read')) continue;
    out.push({ id, live: !note.forgottenAt, teamId: note.teamId, ...(canResource(actor, 'agentTeam', note.teamId, 'update') && { canChange: true }), ...(!note.forgottenAt && { text: note.text }), ...(note.forgottenAt && { forgottenAt: note.forgottenAt }), ...(note.forgetReason && { reason: note.forgetReason }) });
  }
  return out;
}
