'use client';
/**
 * Line comments on diffs, per run: the Run Trace view provides them, a diff reads and adds them, and the gate's Send back
 * sends them as its note. Kept in this browser (localStorage) so a page reload keeps a review in progress; a private window
 * or blocked storage keeps them only until the page closes.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { LineComment } from '@/lib/shared/line-comments';

interface LineComments {
  comments: LineComment[];
  add(comment: Omit<LineComment, 'id' | 'at'>): void;
  remove(id: string): void;
  clear(): void;
}

const Context = createContext<LineComments | undefined>(undefined);

const keyOf = (executionId: string) => `landflow-line-comments:${executionId}`;

function load(executionId: string): LineComment[] {
  try {
    const saved = JSON.parse(localStorage.getItem(keyOf(executionId)) ?? '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

export function LineCommentsProvider({ executionId, children }: { executionId: string; children: ReactNode }) {
  const [comments, setComments] = useState<LineComment[]>([]);
  useEffect(() => setComments(load(executionId)), [executionId]);
  const save = useCallback(
    (next: LineComment[]) => {
      setComments(next);
      try {
        if (next.length) localStorage.setItem(keyOf(executionId), JSON.stringify(next));
        else localStorage.removeItem(keyOf(executionId));
      } catch {
        // Kept in memory only.
      }
    },
    [executionId],
  );
  const value = useMemo<LineComments>(
    () => ({
      comments,
      add: (c) => save([...comments, { ...c, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: new Date().toISOString() }]),
      remove: (id) => save(comments.filter((c) => c.id !== id)),
      clear: () => save([]),
    }),
    [comments, save],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** The run's line comments, or undefined outside a Run Trace view (a diff then has no comments). */
export const useLineComments = () => useContext(Context);
