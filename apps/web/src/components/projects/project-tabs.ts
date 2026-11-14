import type { ResourceKind } from '@/lib/shared/projects';

/** The project page's four tabs. */
export type ProjectTab = 'overview' | 'members' | 'settings' | 'audit';
export const PROJECT_TABS: Array<{ id: ProjectTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'members', label: 'Members' },
  { id: 'settings', label: 'Settings' },
  // Project admins (and owners and admins) read the project's audit events.
  { id: 'audit', label: 'Audit log' },
];

/** `?tab=` of the page's earlier seven tabs: the four lists become the Overview, Variables moves into Settings. */
const OLD_TAB: Record<string, ProjectTab> = {
  workflows: 'overview',
  credentials: 'overview',
  dataTables: 'overview',
  agents: 'overview',
  variables: 'settings',
};

/** The tab a `?tab=` value names: one of the four, an old link's new home, else the Overview. */
export function projectTab(value: string | null | undefined): ProjectTab {
  if (!value) return 'overview';
  return PROJECT_TABS.find((t) => t.id === value)?.id ?? OLD_TAB[value] ?? 'overview';
}

/** What the Overview counts, and the global page each count opens filtered to the project. */
export const OVERVIEW_KINDS: Array<{ kind: ResourceKind; label: string; href: (projectId: string) => string }> = [
  { kind: 'workflow', label: 'Workflows', href: (id) => `/workflows?project=${encodeURIComponent(id)}` },
  { kind: 'credential', label: 'Credentials', href: (id) => `/credentials?project=${encodeURIComponent(id)}` },
  { kind: 'dataTable', label: 'Data tables', href: (id) => `/data-tables?project=${encodeURIComponent(id)}` },
  { kind: 'agent', label: 'Agents', href: (id) => `/agents?project=${encodeURIComponent(id)}` },
];
