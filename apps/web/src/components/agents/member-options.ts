/**
 * Which agents a team's member picker offers (docs/agent-teams.md#picking-members). With the team's project known, the picker
 * lists the agents available in it (`GET /api/agents?availableIn=<projectId>`: home agents, shared ones, and those shared
 * with every project). On an error, or without a project, it lists every agent it knows, as before. An agent already on
 * the team stays in the list even when it is no longer available, labelled as such: saving never removes a member.
 */
import type { AgentSummary } from '@/lib/shared/agents';

/** The part of an `?availableIn=` agent the picker reads. */
export interface AvailableAgent {
  id: string;
  name: string;
  role?: string;
  ownership?: { projectName?: string; shared?: boolean };
}

export interface MemberOption {
  id: string;
  name: string;
  role?: string;
  /** Shown after the name: "Shared from <project>" or "Not available in this project". */
  note?: string;
}

export const NOT_AVAILABLE = 'Not available in this project';

const optionOf = (a: { id: string; name: string; role?: string }, note?: string): MemberOption => ({ id: a.id, name: a.name, ...(a.role && { role: a.role }), ...(note && { note }) });

/**
 * `available`: the answer, or undefined when it failed or no project is known (then `all` is offered whole).
 * `current`: agent ids already on the team (and the one being edited); they are kept.
 */
export function memberOptions(all: AgentSummary[], available: AvailableAgent[] | undefined, current: string[] = []): MemberOption[] {
  if (!available) return all.map((a) => optionOf(a));
  const options = available.map((a) => optionOf(a, a.ownership?.shared && a.ownership.projectName ? `Shared from ${a.ownership.projectName}` : undefined));
  const seen = new Set(options.map((o) => o.id));
  for (const id of new Set(current)) {
    if (!id || seen.has(id)) continue;
    const known = all.find((a) => a.id === id);
    // An agent that was deleted is not in `all` either: keep its id so the select still shows a value.
    options.push(optionOf(known ?? { id, name: id }, NOT_AVAILABLE));
  }
  return options;
}

/** The text of one `<option>`. */
export const optionLabel = (o: MemberOption) => `${o.name}${o.role ? `, ${o.role}` : ''}${o.note ? `  ·  ${o.note}` : ''}`;
