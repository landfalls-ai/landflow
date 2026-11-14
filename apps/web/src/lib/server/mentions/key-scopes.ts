/**
 * What an API key's scopes let it tag (docs/assistant.md#tagging-with-). `/api/brain/ask` needs only `brain:read`, but a
 * tag reads a digest of the thing it points at, so a key may tag a kind only when its scopes cover reading that kind
 * anywhere else: brain pages, people, node types and plugins with `brain:read`; workflows, nodes, agents, teams, data
 * tables and templates with `workflows:read`; runs with `executions:read`; credentials with `admin`.
 */
import { hasScope, type ApiKeyScope } from '../../shared/auth';
import type { MentionType } from '../../shared/mentions';

export const MENTION_KEY_SCOPE: Record<MentionType, ApiKeyScope> = {
  brainPage: 'brain:read',
  person: 'brain:read',
  nodeType: 'brain:read',
  plugin: 'brain:read',
  workflow: 'workflows:read',
  node: 'workflows:read',
  agent: 'workflows:read',
  team: 'workflows:read',
  dataTable: 'workflows:read',
  template: 'workflows:read',
  run: 'executions:read',
  credential: 'admin',
};

/** Splits tags into what `scopes` cover and what they do not. */
export function splitByScopes<T extends { type: MentionType }>(refs: readonly T[], scopes: readonly ApiKeyScope[]): { allowed: T[]; denied: T[] } {
  const allowed: T[] = [];
  const denied: T[] = [];
  for (const ref of refs) (hasScope(scopes, MENTION_KEY_SCOPE[ref.type]) ? allowed : denied).push(ref);
  return { allowed, denied };
}
