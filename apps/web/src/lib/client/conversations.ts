'use client';
/**
 * A chat's kept conversation (docs/assistant.md#conversation-history). `useConversation` follows one conversation of a
 * surface: the first thing a person says creates it, every message after is appended, and `open`, `startNew` and
 * `resumeLatest` move between conversations. When the person keeps nothing (`kept: false`) the items stay in the chat
 * only: nothing is sent to be stored.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationItem, ConversationItemInput, ConversationRecord, ConversationSurface } from '../shared/conversations';
import { createBody } from '../shared/conversations';
import { api } from './api';

export interface ConversationScope {
  surface: ConversationSurface;
  subjectType?: string;
  subjectId?: string;
}

export interface UseConversation {
  id: string | undefined;
  items: ConversationItem[];
  /** False once the server said nothing is kept (the person's setting). */
  kept: boolean;
  append: (items: ConversationItemInput[]) => Promise<void>;
  open: (id: string) => Promise<void>;
  startNew: () => void;
  /** Open the newest conversation of this surface and subject, if there is one. */
  resumeLatest: () => Promise<boolean>;
}

const query = (scope: ConversationScope) => {
  const params = new URLSearchParams({ surface: scope.surface });
  if (scope.subjectType) params.set('subjectType', scope.subjectType);
  if (scope.subjectId) params.set('subjectId', scope.subjectId);
  return params;
};

export function useConversation(scope: ConversationScope): UseConversation {
  const [id, setId] = useState<string>();
  const [items, setItems] = useState<ConversationItem[]>([]);
  const [kept, setKept] = useState(true);
  // The conversation being created: a second message sent before the first returns waits for it.
  const creating = useRef<Promise<string | undefined>>(undefined);
  const idRef = useRef<string>(undefined);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  // Moving to another conversation (open, startNew, another scope) bumps this: a create still in flight then no longer selects itself.
  const generation = useRef(0);

  const select = (next: string | undefined) => {
    idRef.current = next;
    setId(next);
  };

  const ensure = useCallback(async (firstText: string | undefined): Promise<string | undefined> => {
    if (idRef.current) return idRef.current;
    const started = generation.current;
    const promise: Promise<string | undefined> = creating.current ??= api<{ conversation: ConversationRecord | null; kept?: boolean }>('/api/conversations', {
      method: 'POST',
      json: createBody(scopeRef.current, firstText),
    })
      .then((body) => {
        if (!body.conversation) {
          setKept(false);
          return undefined;
        }
        setKept(true);
        // The message that made it still goes to it, but the chat has moved on: don't select it.
        if (started === generation.current) select(body.conversation.id);
        return body.conversation.id;
      })
      .finally(() => {
        if (creating.current === promise) creating.current = undefined;
      });
    return promise;
  }, []);

  const append = useCallback(
    async (added: ConversationItemInput[]) => {
      const at = new Date().toISOString();
      setItems((before) => [...before, ...added.map((item, i) => ({ seq: before.length + i + 1, role: item.role, parts: item.parts, meta: item.meta, at }))]);
      const firstUser = added.find((item) => item.role === 'user')?.parts.find((part) => part.type === 'text');
      const target = await ensure(firstUser?.type === 'text' ? firstUser.text : undefined);
      if (!target) return;
      await api(`/api/conversations/${target}/items`, { method: 'POST', json: { items: added } });
    },
    [ensure],
  );

  const open = useCallback(async (target: string) => {
    const body = await api<{ conversation: ConversationRecord; items: ConversationItem[] }>(`/api/conversations/${target}`);
    generation.current += 1;
    creating.current = undefined;
    select(body.conversation.id);
    setItems(body.items);
  }, []);

  const startNew = useCallback(() => {
    generation.current += 1;
    creating.current = undefined;
    select(undefined);
    setItems([]);
  }, []);

  // Another workflow or page is another subject: start clean rather than keep writing to the old conversation.
  const scopeKey = `${scope.surface}|${scope.subjectType ?? ''}|${scope.subjectId ?? ''}`;
  const lastScope = useRef(scopeKey);
  useEffect(() => {
    if (lastScope.current === scopeKey) return;
    lastScope.current = scopeKey;
    startNew();
  }, [scopeKey, startNew]);

  const resumeLatest = useCallback(async () => {
    const params = query(scopeRef.current);
    params.set('limit', '1');
    const { conversations } = await api<{ conversations: ConversationRecord[] }>(`/api/conversations?${params}`, { background: true });
    if (!conversations[0]) return false;
    await open(conversations[0].id);
    return true;
  }, [open]);

  return { id, items, kept, append, open, startNew, resumeLatest };
}
