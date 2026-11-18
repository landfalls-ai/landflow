/**
 * Changing an agent from Spotlight (docs/assistant.md "Changing an agent"), the calls the editor's card and the agent page's
 * panel share: design the change (`POST /api/agents/design` with `base` and `change`: a proposal, nothing saved), save it to the
 * draft and smoke-test it (Apply), and publish it (only after a pass, through the eval gate, never skipping it: decision D3).
 * No store and no server import: both surfaces keep their own state.
 */
import { useEffect, useState } from 'react'; // AG09:
import { api, ApiError } from '@/lib/client/api';
import { agentChanges } from '@/lib/shared/agent-changes';
import type { AgentNotAdded, AgentPublish, AgentSmoke } from '@/lib/shared/agent-card';

/** What the design route answers for a change. */
export interface ChangeDesign {
  config: Record<string, unknown>;
  changes: string[];
  needs?: Array<{ text: string }>;
  missing?: Array<{ capability: string }>;
  designed?: boolean;
  /** Cases that replace the agent's own when the change gives it a data tool (`Tests: N replaced` on the card). */
  cases?: Array<{ input: string; expected?: string }>;
  /** The agent's cases those replace, by id with their input (the design named them; Apply swaps them in one call). */
  replaceCases?: Array<{ id: string; input: string }>;
  /** Why the model made no design when it failed (a usage limit in the provider's words). */
  failure?: string;
  /** ag1-int: the tools the change named that the agent did not get, and why. */
  notAdded?: AgentNotAdded[];
}

/** The change as a proposal: the config with the change made, and the lines that differ from the base. */
export function designChange(input: { name: string; description?: string; base: { agentId: string } | { config: Record<string, unknown> }; change: string; model?: string; typedAsk?: string }, signal?: AbortSignal): Promise<ChangeDesign> {
  const { model, ...rest } = input;
  return api<ChangeDesign>('/api/agents/design', { method: 'POST', json: { description: '', instructions: '', ...rest, ...(model && { model }), preview: true }, signal }).then((design) => {
    // A design that ran and matched the base has `designed: true` and no changes ("No change"); one the model never proposed is a failure, not "already has it".
    if (design.designed === false) throw new Error(design.failure && /usage limit/.test(design.failure) ? `${design.failure.charAt(0).toUpperCase()}${design.failure.slice(1)}; nothing was changed` : 'the model proposed nothing; nothing was changed');
    return design;
  });
}

/** The agent's saved draft as it is now, or undefined when it cannot be read. */
export async function readDraft(agentId: string): Promise<Record<string, unknown> | undefined> {
  try {
    return (await api<{ agent: Record<string, unknown> }>(`/api/agents/${agentId}`, { background: true })).agent; // AG11's lookup does the same: a background read shows no global progress or error
  } catch {
    return undefined;
  }
}

/** The cases a swap could not replace, and why (shown on the card; never swallowed). */
const STILL_THERE = 'The old tests are still there; Publish checks against them.';
export const CASES_CHANGED = `The tests changed since this was designed; ask again. ${STILL_THERE}`;

type CaseRow = { id: string; input: string; expected?: string };

/**
 * Apply: the config becomes the agent's draft (`PUT /api/agents/:id`: never a publish), the cases the change replaced are swapped in
 * (one all-or-nothing call, after the draft is saved, never undone), then the draft runs once on `sample`. A swap that cannot be
 * done is `casesNote` for the card: a stale id (409) is worked out again from the agent's cases now, matched by input text, and
 * tried once more.
 */
export async function saveChangeWithCases(agentId: string, config: Record<string, unknown>, sample: string, cases: Array<{ input: string; expected?: string }> = [], replaceCases: Array<{ id: string; input: string }> = []): Promise<{ smoke: AgentSmoke; casesNote?: string }> {
  await api(`/api/agents/${agentId}`, { method: 'PUT', json: config });
  announceChange(agentId); // the agent's page shows the saved draft while the test runs
  let casesNote: string | undefined;
  if (cases.length && replaceCases.length) {
    const swap = (remove: string[]) => api(`/api/agents/${agentId}/eval-gate`, { method: 'PATCH', json: { remove, add: cases } });
    try {
      await swap(replaceCases.map((c) => c.id));
    } catch (first) {
      if (first instanceof ApiError && first.status === 409) {
        try {
          const now = (await api<{ cases?: CaseRow[] }>(`/api/agents/${agentId}/eval-gate`)).cases ?? [];
          const inputs = new Set(replaceCases.map((c) => c.input.trim()));
          await swap(now.filter((c) => inputs.has(c.input.trim())).map((c) => c.id));
        } catch (second) {
          casesNote = second instanceof ApiError && second.status === 409 ? CASES_CHANGED : `The tests could not be replaced: ${(second as Error).message}. ${STILL_THERE}`;
        }
      } else casesNote = `The tests could not be replaced: ${(first as Error).message}. ${STILL_THERE}`;
    }
  }
  const smoke = await smokeOf(agentId, sample);
  return { smoke, ...(casesNote && { casesNote }) };
}

const smokeOf = async (agentId: string, sample: string): Promise<AgentSmoke> => {
  try {
    const { smoke } = await api<{ smoke: AgentSmoke }>(`/api/agents/${agentId}/smoke-test`, { method: 'POST', json: { message: sample.slice(0, 4000) } });
    return smoke;
  } catch (e) {
    return { state: 'failed', reason: (e as Error).message };
  }
};

/** Apply without cases to swap (an edit from the agent's page): the smoke result alone. */
export async function saveChange(agentId: string, config: Record<string, unknown>, sample: string): Promise<AgentSmoke> {
  return (await saveChangeWithCases(agentId, config, sample)).smoke;
}

/** Publish after a pass: the eval gate runs the agent's cases; a hold is the answer (never skipped), not an error. */
export async function publishChange(agentId: string): Promise<AgentPublish> {
  try {
    await api(`/api/agents/${agentId}/publish`, { method: 'POST' });
    return { state: 'published' };
  } catch (e) {
    const verdict = e instanceof ApiError && e.status === 409 ? (e.body as { gate?: { verdict?: { average?: number; reason?: string } } } | undefined)?.gate?.verdict : undefined;
    if (verdict) return { state: 'held', ...(verdict.average !== undefined && { score: verdict.average }), ...(verdict.reason && { reason: verdict.reason }) };
    return { state: 'failed', reason: (e as Error).message };
  }
}

/** The agent's page reloads its draft on this window event (one listener in the builder). */
export const AGENT_CHANGED = 'landflow:agent-changed';
export function announceChange(agentId: string): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(AGENT_CHANGED, { detail: { agentId } }));
  tellOtherTabs(AGENT_CHANGED, agentId); // AG12
}

/** The draft without what the server stamps on it (times, versions, the kagent deployment). */
const settings = ({ updatedAt: _u, createdAt: _c, published: _p, history: _h, kagent: _k, ...rest }: Record<string, unknown>) => rest;

/** Equal as data: the same keys and values whatever order the server wrote them in (a save moves model, persona and guardrails to the end). */
const canonical = (value: unknown): unknown => (Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, canonical(v)])) : value);
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * Before Apply saves `config`: has the draft moved since the change was designed (`snapshot` is the draft's JSON then)? If so
 * nothing is saved and the card must show what applying does against the draft as it is now (`changes`, `snapshot`), then wait
 * for Apply again. The Changes row is the promise of what Apply does (lesson 22).
 */
export async function draftMoved(agentId: string, snapshot: string | undefined, config: Record<string, unknown>): Promise<{ snapshot: string; changes: string[] } | undefined> {
  if (!snapshot) return undefined;
  const current = await readDraft(agentId);
  // The draft's own settings are what Apply overwrites: a bumped updatedAt (the page opening, a smoke test) or a new published version is not a move, and never costs a first click.
  if (!current || same(settings(current), settings(JSON.parse(snapshot) as Record<string, unknown>))) return undefined;
  return { snapshot: JSON.stringify(current), changes: agentChanges(current, config) };
}

// AG09: the change card follows the agent's draft: what is left is what its draft still lacks, and Test again runs the draft as it is.

/** The agent page saved its draft (a credential picked in a tool dialog, say): `AGENT_CHANGED` makes the page reload itself, this one only tells the cards. */
export const AGENT_SAVED = 'landflow:agent-saved';
export function announceSaved(agentId: string): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(AGENT_SAVED, { detail: { agentId } }));
  tellOtherTabs(AGENT_SAVED, agentId); // AG12
}

// AG12: the events are window-local, so a change made in another tab (the agent page opened by "Pick it") reached no card, band
// or page here. Both announcements also post `{ type, agentId }` on a BroadcastChannel; the one listener below turns another
// tab's message into the same window event. It never posts, so two tabs cannot echo each other.
const CHANNEL = 'landflow-agents';
let channel: BroadcastChannel | undefined;
function bridge(): BroadcastChannel | undefined {
  if (channel || typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return channel;
  channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (message: MessageEvent<{ type?: unknown; agentId?: unknown }>) => {
    const { type, agentId } = message.data ?? {};
    if ((type === AGENT_CHANGED || type === AGENT_SAVED) && typeof agentId === 'string') window.dispatchEvent(new CustomEvent(type, { detail: { agentId } }));
  };
  return channel;
}
function tellOtherTabs(type: string, agentId: string): void {
  try {
    bridge()?.postMessage({ type, agentId });
  } catch {
    /* a closed channel: this tab's own listeners already heard it */
  }
}
bridge();

/**
 * The Left row's lines as the agent's draft leaves them: a "<tool>: pick a <slot> credential" line is dropped when that tool of
 * the draft has the slot set. Every other line stays (a credential is the person's pick; nothing here sets one).
 */
export function stillLeft(lines: string[], draft: Record<string, unknown> | undefined): string[] {
  if (!draft) return lines;
  const tools = (Array.isArray(draft.tools) ? draft.tools : []) as Array<Record<string, unknown>>;
  return lines.filter((line) => {
    // ag3 carryover: "send_email: fill in From Email" goes once the draft's tool has that field (a Spotlight change set it).
    const field = /^(.+?): (?:fill in|set) (.+?)(?: \(the request gives none\))?$/.exec(line);
    if (field) {
      const parameters = tools.find((t) => t.name === field[1])?.parameters;
      const key = field[2].replace(/\s+/g, '').toLowerCase();
      const value = parameters && typeof parameters === 'object' ? Object.entries(parameters as Record<string, unknown>).find(([k]) => k.toLowerCase() === key)?.[1] : undefined;
      return !(typeof value === 'string' ? value.trim() : value !== undefined && value !== null && !(Array.isArray(value) && !value.length));
    }
    const m = /^(.+?): pick an? (.+?) credential/.exec(line);
    if (!m) return true;
    const tool = tools.find((t) => t.name === m[1]);
    const given = tool?.credentials;
    return !(given && typeof given === 'object' && (given as Record<string, unknown>)[m[2]]);
  });
}

/** The draft the card reads its Left row against: read when the card shows, and again on `AGENT_CHANGED` and `AGENT_SAVED` for this agent. */
export function useAgentDraft(agentId: string | undefined, reload = 0): Record<string, unknown> | undefined {
  const [draft, setDraft] = useState<Record<string, unknown>>();
  useEffect(() => {
    if (!agentId) return;
    let live = true;
    const read = () => void readDraft(agentId).then((d) => live && d && setDraft(d));
    read();
    const onEvent = (e: Event) => {
      if ((e as CustomEvent<{ agentId?: string }>).detail?.agentId === agentId) read();
    };
    window.addEventListener(AGENT_CHANGED, onEvent);
    window.addEventListener(AGENT_SAVED, onEvent);
    return () => {
      live = false;
      window.removeEventListener(AGENT_CHANGED, onEvent);
      window.removeEventListener(AGENT_SAVED, onEvent);
    };
  }, [agentId, reload]);
  return draft;
}

/** Test again: the smoke test on the draft as it is now (no save, no publish). */
export async function testDraft(agentId: string, sample: string): Promise<AgentSmoke> {
  try {
    const { smoke } = await api<{ smoke: AgentSmoke }>(`/api/agents/${agentId}/smoke-test`, { method: 'POST', json: { message: sample.slice(0, 4000) } });
    return smoke;
  } catch (e) {
    return { state: 'failed', reason: (e as Error).message };
  }
}
