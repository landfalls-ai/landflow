/**
 * On read, a brain conversation's links are checked again: a page the person can no longer open (they left the project,
 * or it was removed) loses its link, and the item's `meta.hidden` counts how many went. A proposal part is returned as
 * stored: the client revalidates it when it is shown (docs/assistant.md#conversation-history). A `mentions` part's tags
 * are checked the way the @ picker checked them, so a tag of a brain page, a person or a run survives a read.
 */
import type { ConversationItem, ConversationPart, ConversationRecord } from '../../shared/conversations';
import { isMentionType } from '../../shared/mentions';
import { RESOURCE_KINDS, type ResourceKind } from '../../shared/projects';
import { getUser } from '../auth/users';
import { getEntity, canEntity } from '../brain/entities';
import { canResource, type Actor } from '../projects/access';
import { store } from '../store';
import { getTemplate, templateAccess } from '../templates';
import { REMOTE_PREFIX } from '../templates/remote';

type Ref = { type: string; id: string; workflowId?: string };

/** An answer's link: a brain page (`type`/`id` of the entity) or one of the resource kinds. */
function canOpenLink(actor: Actor, ref: Ref): boolean {
  const entity = getEntity(ref.type, ref.id);
  return entity ? canEntity(actor, entity, 'read') : (RESOURCE_KINDS as readonly string[]).includes(ref.type) && canResource(actor, ref.type as ResourceKind, ref.id, 'read');
}

/**
 * A tag (docs/assistant.md#tagging-with-): the same question `GET /api/mentions` asked when it was offered. A brain
 * page's id is `<type>/<id>`, a team is an agent team, a node and a run are seen through their workflow, and a node
 * type or a plugin is open to everyone signed in.
 */
async function canOpenMention(actor: Actor, ref: Ref): Promise<boolean> {
  if (!isMentionType(ref.type)) return canOpenLink(actor, ref);
  switch (ref.type) {
    case 'workflow':
    case 'credential':
    case 'dataTable':
    case 'agent':
      return canResource(actor, ref.type, ref.id, 'read');
    case 'team':
      return canResource(actor, 'agentTeam', ref.id, 'read');
    case 'node':
      return Boolean(ref.workflowId && store.getWorkflow(ref.workflowId)?.nodes.some((n) => n.id === ref.id) && canResource(actor, 'workflow', ref.workflowId, 'read'));
    case 'run': {
      const record = await store.loadExecution(ref.id);
      return Boolean(record && canResource(actor, 'workflow', record.workflowId, 'read'));
    }
    case 'brainPage': {
      const cut = ref.id.indexOf('/');
      const entity = cut > 0 ? getEntity(ref.id.slice(0, cut), ref.id.slice(cut + 1)) : undefined;
      return Boolean(entity && canEntity(actor, entity, 'read'));
    }
    case 'person': {
      const user = getUser(ref.id);
      return Boolean(user && !user.disabledAt);
    }
    case 'template': {
      if (ref.id.startsWith(REMOTE_PREFIX)) return false;
      const found = await getTemplate(ref.id, actor);
      return Boolean(found && found.source !== 'remote' && templateAccess(actor, found).read);
    }
    case 'nodeType':
    case 'plugin':
      return true;
  }
}

async function canOpen(actor: Actor, ref: Ref, kind: 'link' | 'mention', memo: Map<string, boolean>): Promise<boolean> {
  const key = `${kind}:${ref.type}/${ref.workflowId ?? ''}/${ref.id}`;
  const known = memo.get(key);
  if (known !== undefined) return known;
  const allowed = kind === 'link' ? canOpenLink(actor, ref) : await canOpenMention(actor, ref).catch(() => false);
  memo.set(key, allowed);
  return allowed;
}

async function keep<T extends Ref>(actor: Actor, refs: T[], kind: 'link' | 'mention', memo: Map<string, boolean>): Promise<T[]> {
  const allowed = await Promise.all(refs.map((ref) => canOpen(actor, ref, kind, memo)));
  return refs.filter((_, i) => allowed[i]);
}

/** `items` with the links `actor` may no longer open dropped (brain conversations only). */
export async function sanitizeItems(actor: Actor, conversation: Pick<ConversationRecord, 'surface'>, items: ConversationItem[]): Promise<ConversationItem[]> {
  if (conversation.surface !== 'brain') return items;
  const memo = new Map<string, boolean>();
  const out: ConversationItem[] = [];
  for (const item of items) {
    let hidden = 0;
    const parts: ConversationPart[] = [];
    for (const part of item.parts) {
      if (part.type === 'answer') {
        const links = await keep(actor, part.links, 'link', memo);
        hidden += part.links.length - links.length;
        parts.push({ ...part, links });
      } else if (part.type === 'mentions') {
        const refs = await keep(actor, part.refs, 'mention', memo);
        hidden += part.refs.length - refs.length;
        parts.push({ ...part, refs });
      } else parts.push(part);
    }
    out.push(hidden ? { ...item, parts, meta: { ...item.meta, hidden } } : item);
  }
  return out;
}
