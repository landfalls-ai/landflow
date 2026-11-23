/**
 * Custom instance roles (C32): the shapes the API and Settings → Users share, and the words the role editor uses for
 * each action. No zod and no runtime imports, so the client can load it (the schemas are in lib/server/auth/roles-schema.ts).
 */
import { parseStoredActions, type Action } from './auth';

/** One rule of a role. Only `allow` exists: a custom role adds to what `member` may do (deny rules are deferred). */
export interface RoleRule {
  action: Action;
  effect: 'allow';
}

/** A role as Settings → Users shows it (GET /api/users/roles). */
export interface CustomRoleView {
  id: string;
  name: string;
  description?: string;
  rules: RoleRule[];
  /** How many members hold it. */
  holders: number;
  createdAt: string;
  updatedAt: string;
}

/** The editor's words for each action; `note` says what else the action opens, so nobody grants it by accident. */
export const ACTION_LABELS: Record<Action, { label: string; note?: string }> = {
  'users:manage': { label: 'Manage users', note: 'Invite, remove and change roles. Only the owner can grant it.' },
  'settings:manage': { label: 'Manage settings', note: 'Instance settings, security, source control and environments, which reach every project. Only the owner can grant it.' },
  'credentials:share': { label: 'Share credentials' },
  'mcp:manage': { label: 'Manage MCP', note: 'The instance MCP server, its tokens’ grants and the gateway.' },
  'plugins:manage': { label: 'Manage plugins', note: 'Installs third-party code that runs on the host, with the host’s access to the data directory. Only the owner can grant it.' },
  'variables:manage': { label: 'Manage variables' },
  'workflows:takeover': { label: 'Take over workflows', note: 'Take a workflow someone else has open in the editor.' },
  'apiKeys:admin': { label: 'Create admin API keys', note: 'Only the owner can grant it.' },
  'projects:manage': { label: 'Manage projects', note: 'Sees every project. Can’t be granted through a custom role.' },
  'scim:manage': { label: 'Manage SCIM tokens', note: 'A SCIM token creates, changes and removes users and groups. Only the owner can grant it.' },
  'audit:read': { label: 'Read the audit log', note: 'The events of the projects the person is a member of, not every event.' },
};

/** The names a custom role can't take: they are the built-in roles. */
export const RESERVED_ROLE_NAMES: readonly string[] = ['owner', 'admin', 'member'];

/** A stored `rules` text as rules (the actions come from `parseStoredActions`, which lives with `can` so the server's user read needs no second module). */
export function parseStoredRules(text: string | null | undefined): RoleRule[] {
  return parseStoredActions(text).map((action) => ({ action, effect: 'allow' as const }));
}
