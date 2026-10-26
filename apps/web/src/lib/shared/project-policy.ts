/**
 * Governance below the instance (lib/server/governance/scopes.ts): a project's settings (which plugins and node types
 * its workflows may use, who approves its publish requests) and a workflow's own policy (four-eyes publishing even
 * when the instance doesn't ask for it, a stricter node allow-list). Each level can only narrow what the one above
 * allows. Shapes shared by the API (/api/projects/<id>/settings, /api/workflows/<id>/policy), the project's Settings
 * tab and the workflow settings dialog. No runtime imports.
 */

/** An allow-list of plugins and node types (`off`: no list, everything the level above allows). */
export interface ScopedNodePolicy {
  mode: 'off' | 'allow';
  /** Plugin ids (`core` is the built-in nodes), `*` matches any characters. */
  plugins: string[];
  /** Node type ids (`core.httpRequest`, `messaging.*`). */
  types: string[];
}

/**
 * Who approves a project's publish requests when four-eyes publishing applies: `default` (the instance's rule),
 * `admins` (the project's admins), `editors` (its admins and editors) or `instance` (instance owners and admins only).
 * Always on top of the instance's approver role, and never the requester.
 */
export type ProjectApprovers = 'default' | 'admins' | 'editors' | 'instance';

export const PROJECT_APPROVER_LABELS: Record<ProjectApprovers, string> = {
  default: 'As the instance says (Settings → Governance)',
  admins: 'The project’s admins',
  editors: 'The project’s admins and editors',
  instance: 'Instance owners and admins only',
};

export interface ProjectSettings {
  nodes: ScopedNodePolicy;
  approvers: ProjectApprovers;
  updatedAt?: string;
  updatedBy?: string;
}

export interface WorkflowPolicy {
  /** Publishing (and unpublishing, when the instance's setting says so) this workflow needs a second person's approval. */
  fourEyes: boolean;
  nodes: ScopedNodePolicy;
  updatedAt?: string;
  updatedBy?: string;
}

export const EMPTY_NODE_POLICY: ScopedNodePolicy = { mode: 'off', plugins: [], types: [] };
export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = { nodes: EMPTY_NODE_POLICY, approvers: 'default' };
export const DEFAULT_WORKFLOW_POLICY: WorkflowPolicy = { fourEyes: false, nodes: EMPTY_NODE_POLICY };

/** GET /api/projects/<id>/settings */
export interface ProjectSettingsView {
  settings: ProjectSettings;
  /** The viewer may change them (the project's admins). */
  canEdit: boolean;
  plugins: Array<{ id: string; name: string }>;
  nodeTypes: Array<{ type: string; displayName: string; pluginId: string }>;
}

/** GET /api/workflows/<id>/policy */
export interface WorkflowPolicyView {
  policy: WorkflowPolicy;
  /** The viewer may change it (admins of the workflow's project). */
  canEdit: boolean;
  /** Four-eyes publishing is on for the whole instance (the workflow's own switch then changes nothing). */
  instanceFourEyes: boolean;
  /** The project's own allow-list, for the dialog to show what applies already. */
  project?: { id: string; name: string; nodes: ScopedNodePolicy };
}
