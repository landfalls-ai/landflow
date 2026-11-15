/**
 * Pure helpers for where an agent is available (docs/projects-and-goals.md#testing-an-agent-in-a-project). They take the
 * shapes `GET /api/agents/:id/shares` and `GET /api/agents?availableIn=` answer (the contract agent-availability-api),
 * declared here on purpose: this file imports none of the route's types.
 */

export interface ProjectRef {
  id: string;
  name: string;
}

/** `GET /api/agents/:id/shares` → `availability` (only projects the caller has a role in; `all` and then `projects` is []). */
export interface AvailabilityAnswer {
  home: ProjectRef;
  all: boolean;
  projects: ProjectRef[];
}

/** The part of an item's `ownership` the cards read. */
export interface OwnershipLike {
  projectName: string;
  shared: boolean;
}

export const ALL_PROJECTS_LABEL = 'All projects';

/**
 * The "Available in" line: "All projects", or the home project then the others by name, at most two names and "+N".
 * `undefined` while the answer is not there.
 */
export function availabilityLabel(availability: AvailabilityAnswer | undefined): string | undefined {
  if (!availability) return undefined;
  if (availability.all) return ALL_PROJECTS_LABEL;
  const names = [availability.home.name, ...availability.projects.filter((p) => p.id !== availability.home.id).map((p) => p.name)];
  if (names.length <= 2) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}

/** "Shared from <project>" for an agent that reached the caller through a share (else undefined). */
export function sharedFromLabel(ownership: OwnershipLike | undefined): string | undefined {
  return ownership?.shared ? `Shared from ${ownership.projectName}` : undefined;
}

/**
 * The projects "Test in project" offers: the home project first, then the others the agent is available in, by name.
 * With an "All projects" share the others are every project the caller sees (`callerProjects`).
 */
export function testProjectOptions(availability: AvailabilityAnswer | undefined, callerProjects: readonly ProjectRef[] = []): ProjectRef[] {
  if (!availability) return [];
  const others = (availability.all ? callerProjects : availability.projects).filter((p) => p.id !== availability.home.id);
  const unique = [...new Map(others.map((p) => [p.id, p])).values()].sort((a, b) => a.name.localeCompare(b.name));
  return [availability.home, ...unique];
}

/** The ids the dialog starts with: every share of the agent (also those in projects the caller can't see, so saving keeps them) but its home. */
export function sharedIds(shares: ReadonlyArray<{ projectId: string }>, home: string): string[] {
  return [...new Set(shares.map((s) => s.projectId))].filter((id) => id !== home);
}

/** What "Make available" sends: the home project is left out; the ids the caller can't see stay, so saving keeps hidden shares. With All on, the individual ids are dropped. */
export function availabilityBody(selected: readonly string[], all: boolean, home: string): { projectIds: string[]; all: boolean } {
  return { projectIds: all ? [] : [...new Set(selected)].filter((id) => id !== home), all };
}

/** "Test in project" refused: the 403 the chat route answers (PC06) names the project the agent isn't available in. */
export const NOT_AVAILABLE_MESSAGE = "This agent isn't available in that project";

/** Whether the viewer may change where the agent is available: admins of its home project (undefined: unknown, the server decides). */
export function canMakeAvailable(ownership: { access: { role: string; home: boolean } } | undefined): boolean {
  return ownership ? ownership.access.home && ownership.access.role === 'admin' : true;
}

/** The `ownership` GET /api/agents attaches to each summary (the shared AgentSummary type doesn't name it). */
export function ownershipOfSummary(summary: unknown): (OwnershipLike & { access: { role: string; home: boolean } }) | undefined {
  return (summary as { ownership?: OwnershipLike & { access: { role: string; home: boolean } } } | undefined)?.ownership;
}

/** The answer of `GET /api/agents/:id/context-preview`. */
export interface ContextPreviewAnswer {
  projectId?: string;
  mode: 'full' | 'compact' | 'off';
  text: string;
  compact: string;
  practices: { text: string; list: Array<{ handle: string; version: number }> };
}

export const previewUrl = (agentId: string, projectId?: string): string => `/api/agents/${agentId}/context-preview${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`;

/** Exactly what a run is given: the project block, then the practices block after it (one blank line between; either alone). */
export function injectedText(preview: Pick<ContextPreviewAnswer, 'text' | 'practices'> | undefined): string {
  if (!preview) return '';
  return [preview.text, preview.practices.text].filter(Boolean).join('\n\n');
}
