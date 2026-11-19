'use client';
/**
 * The approval inbox as the browser reads it (wave ap1, docs/approval-inbox.md): the requests waiting for a person in Needs you,
 * Approve and Deny, and one request by id. One store for every screen that shows it (Home's panel, the Run Trace card, the agent
 * page), so a request asked for in the same tick is one GET. A decision on a request that is no longer waiting (409 Already
 * approved by …, 410 expired) is an answer, not an error: it comes back as `{ closed }` with the server's words.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { api, ApiError } from './api';
import { refreshNeedsYou } from './run-trace';
import { settledLine, waitingLine, type InboxItemFields, type InboxRequestView } from '@/lib/shared/approval-inbox';
import type { NeedsYouRow } from './run-trace';

/** "14:05" in the viewer's zone, the `clock` every inbox line takes. */
export const inboxClock = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour12: false });
};

/** The list answer, whichever envelope the route gives it (an array, or `{ requests }` / `{ items }`). */
export function viewsOf(body: unknown): InboxRequestView[] {
  if (Array.isArray(body)) return body as InboxRequestView[];
  const record = body as { requests?: unknown; items?: unknown } | undefined;
  const list = record?.requests ?? record?.items;
  return Array.isArray(list) ? (list as InboxRequestView[]) : [];
}

/** One request's answer, bare or wrapped (`{ request }`). */
export function viewOf(body: unknown): InboxRequestView | undefined {
  const record = body as { request?: InboxRequestView } & Partial<InboxRequestView>;
  return record?.request ?? (record?.id ? (record as InboxRequestView) : undefined);
}

const store = { items: undefined as InboxRequestView[] | undefined, listeners: new Set<() => void>(), scheduled: false, seq: 0 };

/** Reload the waiting requests (and Needs you's list, which carries the same rows). One GET for every caller in a tick. */
export function refreshApprovalInbox() {
  if (store.scheduled) return;
  store.scheduled = true;
  setTimeout(() => {
    store.scheduled = false;
    const mine = ++store.seq;
    const settle = (items: InboxRequestView[]) => {
      if (mine !== store.seq) return;
      store.items = items;
      for (const listener of store.listeners) listener();
    };
    api<unknown>('/api/approval-inbox?status=waiting', { background: true })
      .then((body) => settle(viewsOf(body).filter((v) => v.status === 'waiting')))
      .catch(() => settle(store.items ?? []));
  }, 0);
}

const POLL_MS = 15_000;

/**
 * The requests waiting for the caller, refreshed on focus, every 15 s while one waits, and after a decision.
 * `undefined` until the first answer.
 */
export function useApprovalInbox(): { requests: InboxRequestView[] | undefined; refresh: () => void } {
  const requests = useSyncExternalStore(
    (listener) => {
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    },
    () => store.items,
    () => undefined,
  );
  useEffect(() => {
    refreshApprovalInbox();
    const onFocus = () => {
      refreshApprovalInbox();
      refreshNeedsYou();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, []);
  const waiting = Boolean(requests?.length);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') refreshApprovalInbox();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting]);
  return { requests, refresh: refreshApprovalInbox };
}

/** One request, whatever its state (GET /api/approval-inbox/:id); undefined when the caller cannot see it. */
export async function getRequest(id: string): Promise<InboxRequestView | undefined> {
  try {
    return viewOf(await api<unknown>(`/api/approval-inbox/${encodeURIComponent(id)}`, { background: true }));
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 403)) return undefined;
    throw e;
  }
}

/** A decision's answer: the settled request, or `closed` with the words the server gave when somebody or the clock won first. */
export type Decision = { view?: InboxRequestView; closed?: string };

const inFlight = new Map<string, Promise<Decision>>();

function decide(id: string, route: 'approve' | 'deny', note?: string): Promise<Decision> {
  // One POST per request at a time, whoever clicks (the row and its Details sheet share it).
  const key = `${id}:${route}`;
  const running = inFlight.get(key);
  if (running) return running;
  const call = api<unknown>(`/api/approval-inbox/${encodeURIComponent(id)}/${route}`, { method: 'POST', json: note ? { note } : {} })
    .then((body): Decision => ({ view: viewOf(body) }))
    .catch((e): Decision => {
      if (e instanceof ApiError && (e.status === 409 || e.status === 410)) return { closed: e.message };
      throw e;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, call);
  return call;
}

/** Approve one request (POST /api/approval-inbox/:id/approve). Session only; the server checks run access. */
export const approveRequest = (id: string, note?: string) => decide(id, 'approve', note);
/** Deny one request: the call does not run (POST /api/approval-inbox/:id/deny). */
export const denyRequest = (id: string, note?: string) => decide(id, 'deny', note);

/** What a row of the inbox shows, from a request (Home) or from a Needs you item (the Runs page). */
export interface InboxRowData {
  id: string;
  tool: string;
  agentName?: string;
  agentVersion?: number | 'draft';
  workflowName: string;
  workflowVersion?: number;
  destination?: string;
  requestedAt: string;
  expiresAt?: string;
  canDecide: boolean;
  executionId: string;
  /** The whole request, when the row came from one (its Details need no second GET). */
  view?: InboxRequestView;
}

export const rowOfView = (view: InboxRequestView): InboxRowData => ({
  id: view.id,
  tool: view.tool,
  agentName: view.agentName,
  agentVersion: view.agentVersion,
  workflowName: view.workflowName,
  workflowVersion: view.workflowVersion,
  destination: view.destination,
  requestedAt: view.requestedAt,
  expiresAt: view.expiresAt,
  canDecide: view.canDecide,
  executionId: view.executionId,
  view,
});

/** A Needs you `approval` item that is an inbox request (AP01 adds the fields); anything else stays a plain link. */
export const isInboxItem = (item: NeedsYouRow & Partial<InboxItemFields>): item is NeedsYouRow & { requestId: string } => item.kind === 'approval' && Boolean(item.requestId);

export const rowOfItem = (item: NeedsYouRow & { requestId: string }): InboxRowData => ({
  id: item.requestId,
  tool: item.tool ?? item.title,
  agentName: item.agentName,
  agentVersion: item.agentVersion,
  workflowName: item.workflowName,
  workflowVersion: item.workflowVersion,
  destination: item.destination,
  requestedAt: item.since,
  expiresAt: item.expiresAt,
  canDecide: item.canDecide === true,
  executionId: item.executionId,
});

/** "Alert mailer v2", "Alert mailer (draft)". */
export const versionName = (name: string, version?: number | 'draft'): string => (version === undefined ? name : version === 'draft' ? `${name} (draft)` : `${name} v${version}`);

/** The line under a waiting row: since and expires when both are known. */
export const waitText = (row: Pick<InboxRowData, 'requestedAt' | 'expiresAt'>): string => (row.expiresAt ? waitingLine(row.requestedAt, row.expiresAt, inboxClock) : `Waiting for your approval since ${inboxClock(row.requestedAt)}`);

/** A decision in flight or just made on a row: shared by the row and its Details sheet, and kept for a few seconds after the list loses the request. */
export interface RowState {
  data: InboxRowData;
  index: number;
  busy?: 'approve' | 'deny';
  /** Approved by …, Denied by …: the settled line, shown for 4 s. */
  settled?: string;
  /** The server's words when somebody or the clock decided first. */
  closed?: string;
}

const SETTLED_MS = 4_000;
const CLOSED_MS = 6_000;
const rows = { map: new Map<string, RowState>(), listeners: new Set<() => void>() };
const emit = () => {
  rows.map = new Map(rows.map);
  for (const listener of rows.listeners) listener();
};

/** The decisions in flight or just made, by request id (a new Map each change). */
export function useRowStates(): ReadonlyMap<string, RowState> {
  return useSyncExternalStore(
    (listener) => {
      rows.listeners.add(listener);
      return () => rows.listeners.delete(listener);
    },
    () => rows.map,
    () => rows.map,
  );
}

/** The rows the list gives, plus the ones just decided that the list already lost, each where it was. */
export function withDecided(list: InboxRowData[], states: ReadonlyMap<string, RowState>): InboxRowData[] {
  const out = [...list];
  const ghosts = [...states.values()].filter((s) => (s.settled || s.closed) && !out.some((r) => r.id === s.data.id)).sort((a, b) => a.index - b.index);
  for (const g of ghosts) out.splice(Math.min(g.index, out.length), 0, g.data);
  return out;
}

/**
 * Approve or deny from a row or its sheet. One POST per request (a second click while it is in flight joins it); the row then
 * says what happened for 4 s (the settled line) or 6 s (the server's closed answer), and the lists reload.
 */
export async function decideRow(data: InboxRowData, index: number, decision: 'approve' | 'deny'): Promise<void> {
  const prior = rows.map.get(data.id);
  if (prior?.busy || prior?.settled || prior?.closed) return;
  rows.map.set(data.id, { data, index, busy: decision });
  emit();
  const done = (patch: Partial<RowState>, ms: number) => {
    rows.map.set(data.id, { data, index, ...patch });
    emit();
    setTimeout(() => {
      rows.map.delete(data.id);
      emit();
    }, ms);
    refreshApprovalInbox();
    refreshNeedsYou();
  };
  try {
    const answer = await (decision === 'approve' ? approveRequest : denyRequest)(data.id);
    if (answer.closed) return done({ closed: answer.closed }, CLOSED_MS);
    const view = answer.view;
    done({ settled: view ? settledLine(view, inboxClock) : decision === 'approve' ? 'Approved' : 'Denied' }, SETTLED_MS);
  } catch (e) {
    rows.map.delete(data.id);
    emit();
    throw e;
  }
}

/** The requests of one run (the Run Trace card finds the one its wait is for); empty where the host has no inbox. */
export function useExecutionRequests(executionId: string, refreshKey?: string): InboxRequestView[] {
  const [requests, setRequests] = useState<InboxRequestView[]>([]);
  useEffect(() => {
    if (!executionId) return;
    let live = true;
    api<unknown>(`/api/approval-inbox?executionId=${encodeURIComponent(executionId)}&status=all`, { background: true })
      .then((body) => live && setRequests(viewsOf(body)))
      .catch(() => live && setRequests([]));
    return () => {
      live = false;
    };
  }, [executionId, refreshKey]);
  return requests;
}

/** Tests only: forget every decision in flight or just made, and the loaded list. */
export function resetApprovalInboxClient() {
  rows.map = new Map();
  inFlight.clear();
  store.items = undefined;
}
