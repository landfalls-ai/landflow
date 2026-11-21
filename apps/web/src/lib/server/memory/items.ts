/**
 * The current state of memories a run was given (C11 D5): live or forgotten since, its version and, for a live one, its text
 * now. What the caller may not see is left out, so no "forgotten" hint leaks. Reads only.
 */
import { getFact } from '../brain/facts';
import { canFact } from '../brain/scope';
import { noteStore } from '../notebook/store';
import { canResource, type Actor } from '../projects/access';

/** Ids one call reads; the inspector asks in batches of this many. */
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
      const change = canFact(actor, fact, 'update');
      // A forgotten fact is for people who may change it: a reader sees the item as it was recorded, with no hint and no reason.
      if (lapsed && !change) continue;
      const forgottenAt = fact.forgottenAt ?? (lapsed ? fact.forgetAfter : undefined);
      out.push({ id, live: !lapsed, ...(change && { canChange: true }), version: fact.version ?? 1, ...(!lapsed && { text: fact.statement }), ...(forgottenAt && { forgottenAt }), ...(lapsed && fact.forgetReason && { reason: fact.forgetReason }) });
      continue;
    }
    const note = noteStore.get(id, { withForget: true });
    if (!note || !canResource(actor, 'agentTeam', note.teamId, 'read')) continue;
    const change = canResource(actor, 'agentTeam', note.teamId, 'update');
    // A note forgotten "after" a time is forgotten once that time has passed, whether or not the sweep has run.
    const lapsed = Boolean(note.forgottenAt || (note.forgetReason && note.expiresAt && note.expiresAt <= now()));
    if (lapsed && !change) continue;
    const forgottenAt = note.forgottenAt ?? (lapsed ? note.expiresAt : undefined);
    out.push({ id, live: !lapsed, teamId: note.teamId, ...(change && { canChange: true }), ...(!lapsed && { text: note.text }), ...(forgottenAt && { forgottenAt, ...(note.forgetReason && { reason: note.forgetReason }) }) });
  }
  return out;
}
