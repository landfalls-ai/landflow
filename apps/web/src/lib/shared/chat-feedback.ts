/** Thumbs up/down on an answer (lib/server/chat-feedback.ts): of a hosted chat or widget, the editor's chat, or an agent session. */
export type FeedbackRating = 'up' | 'down';

export interface ChatFeedback {
  id: string;
  kind: 'execution' | 'agent';
  rating: FeedbackRating;
  /** An optional note from the person, at most 2,000 characters. */
  comment?: string;
  /** Where it came from: the hosted page or widget (`chat`), the editor or execution view (`editor`), or the API. */
  source: 'chat' | 'editor' | 'api';
  workflowId?: string;
  executionId?: string;
  agentId?: string;
  sessionId?: string;
  /** Agent sessions: the timeline entry (the assistant message) it rates. */
  entryId?: string;
  createdAt: string;
  updatedAt: string;
}

export const MAX_FEEDBACK_COMMENT = 2_000;
