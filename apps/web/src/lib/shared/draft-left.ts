/**
 * What a first draft leaves for the person: the empty fields the model did not fill after one send-back (SB01), the
 * ids, channels and addresses nobody gave that were cleared, and the credentials to pick (SB02). Wave sb3's build
 * summary (SB15) shows them as buttons that open the node.
 *
 * Contract file: backbone/contracts/sb1/draft-left.ts, copied byte for byte to apps/web/src/lib/shared/draft-left.ts by
 * SB01 (owner) and SB02. Change it in the contracts folder first. `FlowDraft.left?: DraftLeft[]` is added by SB01 only;
 * SB02 merges its own items with `mergeLeft` and never edits the FlowDraft interface.
 */

export type DraftLeftKind =
  /** A list or value the step needs is still empty (an If with no condition, a Set with no fields, a schedule rule). */
  | 'empty'
  /** An id, channel, table, repository, owner, address or URL nobody gave was cleared. */
  | 'made-up'
  /** The step needs a credential the person picks (Spotlight never picks one). */
  | 'credential'
  /** A part of the draft that could not be kept (an unknown type, a second trigger, an empty step). */
  | 'dropped';

export interface DraftLeft {
  /** The draft node's name ("Post to Slack"); empty when it is about the whole flow. */
  node: string;
  /** The parameter it is about ("channel", "conditions"), when it is about one. */
  field?: string;
  kind: DraftLeftKind;
  /** One line for the person, sentence case, no ids: "“Post to Slack”: pick the channel (none was given)". */
  text: string;
}

/** At most this many items travel with a draft. */
export const DRAFT_LEFT_LIMIT = 20;

/** Lists of left items joined in order, each node/field/kind once, cut to DRAFT_LEFT_LIMIT. */
export function mergeLeft(...lists: Array<readonly DraftLeft[] | undefined>): DraftLeft[] {
  const seen = new Set<string>();
  const out: DraftLeft[] = [];
  for (const list of lists) {
    for (const item of list ?? []) {
      const key = `${item.node}\u0000${item.field ?? ''}\u0000${item.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out.slice(0, DRAFT_LEFT_LIMIT);
}
