/**
 * On read, a brain conversation's links are checked again: a page the person can no longer open (they left the project,
 * or it was removed) loses its link, and the item's `meta.hidden` counts how many went. A proposal part is returned as
 * stored: the client revalidates it when it is shown (docs/assistant.md#conversation-history).
 */
import type { ConversationItem, ConversationPart, ConversationRecord } from '../../shared/conversations';
import { RESOURCE_KINDS, type ResourceKind } from '../../shared/projects';
import { getEntity, canEntity } from '../brain/entities';
import { canResource, type Actor } from '../projects/access';

type Ref = { type: string; id: string };

function canOpen(actor: Actor, ref: Ref, memo: Map<string, boolean>): boolean {
  const key = `${ref.type}/${ref.id}`;
  const known = memo.get(key);
  if (known !== undefined) return known;
  const entity = getEntity(ref.type, ref.id);
  const allowed = entity ? canEntity(actor, entity, 'read') : (RESOURCE_KINDS as readonly string[]).includes(ref.type) && canResource(actor, ref.type as ResourceKind, ref.id, 'read');
  memo.set(key, allowed);
  return allowed;
}

/** `items` with the links `actor` may no longer open dropped (brain conversations only). */
export function sanitizeItems(actor: Actor, conversation: Pick<ConversationRecord, 'surface'>, items: ConversationItem[]): ConversationItem[] {
  if (conversation.surface !== 'brain') return items;
  const memo = new Map<string, boolean>();
  return items.map((item) => {
    let hidden = 0;
    const parts = item.parts.map((part): ConversationPart => {
      if (part.type === 'answer') {
        const links = part.links.filter((link) => canOpen(actor, link, memo));
        hidden += part.links.length - links.length;
        return { ...part, links };
      }
      if (part.type === 'mentions') {
        const refs = part.refs.filter((ref) => canOpen(actor, ref, memo));
        hidden += part.refs.length - refs.length;
        return { ...part, refs };
      }
      return part;
    });
    return hidden ? { ...item, parts, meta: { ...item.meta, hidden } } : item;
  });
}
