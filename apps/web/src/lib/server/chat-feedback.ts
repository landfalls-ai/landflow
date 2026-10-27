/**
 * Chat feedback: a thumbs up or down, and an optional comment, per answer (migration 1860, `chat_feedback`).
 * Answers are executions of a workflow behind a Chat trigger (the hosted page and widget rate them through
 * /chat/<key>/feedback, the execution view and /api/executions/:id/feedback through the editor) or replies in an
 * agent session (/api/agents/:id/sessions/:sid/feedback). One row per answer: rating it again replaces the
 * rating, clearing it deletes the row. Online evaluations read it with the run they grade.
 */
import type { ChatFeedback, FeedbackRating } from '../shared/chat-feedback';
import { MAX_FEEDBACK_COMMENT } from '../shared/chat-feedback';
import { database } from './db';
import { singleton } from './singleton';

interface Row {
  id: string;
  kind: string;
  workflow_id: string | null;
  execution_id: string | null;
  agent_id: string | null;
  session_id: string | null;
  entry_id: string | null;
  rating: string;
  comment: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

const COLUMNS = 'id, kind, workflow_id, execution_id, agent_id, session_id, entry_id, rating, comment, source, created_at, updated_at';

const toFeedback = (row: Row): ChatFeedback => ({
  id: row.id,
  kind: row.kind === 'agent' ? 'agent' : 'execution',
  rating: row.rating === 'down' ? 'down' : 'up',
  ...(row.comment && { comment: row.comment }),
  source: row.source === 'editor' || row.source === 'api' ? row.source : 'chat',
  ...(row.workflow_id && { workflowId: row.workflow_id }),
  ...(row.execution_id && { executionId: row.execution_id }),
  ...(row.agent_id && { agentId: row.agent_id }),
  ...(row.session_id && { sessionId: row.session_id }),
  ...(row.entry_id && { entryId: row.entry_id }),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const isRating = (value: unknown): value is FeedbackRating => value === 'up' || value === 'down';

export const cleanComment = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_FEEDBACK_COMMENT) : undefined);

type Listener = (feedback: ChatFeedback) => void;
const listeners = singleton('chat-feedback-listeners', () => new Set<Listener>());

/** Called with every rating given (not with ratings taken back): online evaluations grade the answers people mark as bad. */
export function onFeedback(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export type FeedbackTarget =
  | { kind: 'execution'; workflowId: string; executionId: string; sessionId?: string }
  | { kind: 'agent'; agentId: string; sessionId: string; entryId: string };

const idOf = (target: FeedbackTarget) => (target.kind === 'execution' ? `execution:${target.executionId}` : `agent:${target.sessionId}:${target.entryId}`);

/** Rate an answer (replacing an earlier rating of it). `rating: null` takes the rating back. */
export function setFeedback(target: FeedbackTarget, rating: FeedbackRating | null, options: { comment?: string; source?: ChatFeedback['source'] } = {}): ChatFeedback | undefined {
  const db = database();
  const id = idOf(target);
  if (!rating) {
    db.delete('chat_feedback', { id });
    return undefined;
  }
  const now = new Date().toISOString();
  const earlier = db.get<{ created_at: string }>('SELECT created_at FROM chat_feedback WHERE id = ?', id);
  db.upsert('chat_feedback', {
    id,
    kind: target.kind,
    workflow_id: target.kind === 'execution' ? target.workflowId : null,
    execution_id: target.kind === 'execution' ? target.executionId : null,
    agent_id: target.kind === 'agent' ? target.agentId : null,
    session_id: target.sessionId ?? null,
    entry_id: target.kind === 'agent' ? target.entryId : null,
    rating,
    comment: options.comment ?? null,
    source: options.source ?? 'chat',
    created_at: earlier?.created_at ?? now,
    updated_at: now,
  });
  const saved = getFeedback(id);
  if (saved) for (const listener of listeners) listener(saved);
  return saved;
}

export function getFeedback(id: string): ChatFeedback | undefined {
  const row = database().get<Row>(`SELECT ${COLUMNS} FROM chat_feedback WHERE id = ?`, id);
  return row && toFeedback(row);
}

/** The rating of one execution's answer. */
export const executionFeedback = (executionId: string) => getFeedback(`execution:${executionId}`);

/** Ratings of a workflow's answers, newest first. */
export function listWorkflowFeedback(workflowId: string, options: { rating?: FeedbackRating; sessionId?: string; limit?: number } = {}): ChatFeedback[] {
  const where = ['workflow_id = ?'];
  const args: Array<string | number> = [workflowId];
  if (options.rating) (where.push('rating = ?'), args.push(options.rating));
  if (options.sessionId) (where.push('session_id = ?'), args.push(options.sessionId));
  args.push(Math.min(500, Math.max(1, Math.floor(options.limit ?? 100))));
  return database()
    .all<Row>(`SELECT ${COLUMNS} FROM chat_feedback WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`, ...args)
    .map(toFeedback);
}

/** Ratings of an agent session's replies (all of an agent's with no session). */
export function listAgentFeedback(agentId: string, sessionId?: string, limit = 200): ChatFeedback[] {
  const rows = sessionId
    ? database().all<Row>(`SELECT ${COLUMNS} FROM chat_feedback WHERE agent_id = ? AND session_id = ? ORDER BY updated_at DESC LIMIT ?`, agentId, sessionId, limit)
    : database().all<Row>(`SELECT ${COLUMNS} FROM chat_feedback WHERE agent_id = ? ORDER BY updated_at DESC LIMIT ?`, agentId, limit);
  return rows.map(toFeedback);
}

/** Ratings of a workflow's chat by session id: `sessionId` → feedback of its answers (the session list of the hosted chat). */
export function feedbackBySession(workflowId: string, sessionId: string): Map<string, ChatFeedback> {
  return new Map(listWorkflowFeedback(workflowId, { sessionId, limit: 500 }).flatMap((f) => (f.executionId ? [[f.executionId, f] as const] : [])));
}

/** Delete a session's agent ratings (the session was deleted). */
export function deleteAgentSessionFeedback(sessionId: string) {
  database().delete('chat_feedback', { kind: 'agent', session_id: sessionId });
}

/** Delete an execution's rating (the execution was deleted). */
export function deleteExecutionFeedback(executionId: string) {
  database().delete('chat_feedback', { id: `execution:${executionId}` });
}
