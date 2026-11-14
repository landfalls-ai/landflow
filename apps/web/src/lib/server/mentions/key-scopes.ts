/**
 * What an API key's scopes let it tag (docs/assistant.md#tagging-with-): the one table `/api/mentions`,
 * `/api/assistant/chat` and `/api/brain/ask` all read. A tag reads a digest of the thing it points at, so a key may tag
 * a kind only when its scopes cover the routes that serve that kind (`lib/server/auth/policy.ts`): people and
 * credentials need `admin` (as `/api/users` and `/api/credentials`), runs `executions:read` (as `/api/executions`),
 * workflows, nodes, agents, teams, data tables, templates, node types and plugins `workflows:read` (as `/api/workflows`,
 * `/api/node-types` and `/api/plugins`); a brain page is reached by `brain:read` or `workflows:read`. A session tags every
 * kind (and is then checked per item, as the caller).
 */
import { hasScope, type ApiKeyScope } from '../../shared/auth';
import type { MentionType } from '../../shared/mentions';

/** Per kind, the scopes any one of which lets a key tag it. */
export const MENTION_KEY_SCOPE: Record<MentionType, readonly ApiKeyScope[]> = {
  brainPage: ['brain:read', 'workflows:read'],
  person: ['admin'],
  credential: ['admin'],
  run: ['executions:read'],
  nodeType: ['workflows:read'],
  plugin: ['workflows:read'],
  workflow: ['workflows:read'],
  node: ['workflows:read'],
  agent: ['workflows:read'],
  team: ['workflows:read'],
  dataTable: ['workflows:read'],
  template: ['workflows:read'],
};

/** Whether a key with `scopes` may tag `type` (no key, as for a session: always). */
export function keyMayTag(scopes: readonly ApiKeyScope[] | undefined, type: MentionType): boolean {
  return !scopes || MENTION_KEY_SCOPE[type].some((scope) => hasScope(scopes, scope));
}

/** Splits tags into what `scopes` cover and what they do not (no key: all allowed). */
export function splitByScopes<T extends { type: MentionType }>(refs: readonly T[], scopes: readonly ApiKeyScope[] | undefined): { allowed: T[]; denied: T[] } {
  const allowed: T[] = [];
  const denied: T[] = [];
  for (const ref of refs) (keyMayTag(scopes, ref.type) ? allowed : denied).push(ref);
  return { allowed, denied };
}
