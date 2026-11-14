'use client';
/**
 * The state behind tagging with @ (docs/assistant.md#tagging-with-): finds the `@query` at the caret, searches
 * `/api/mentions` after 150 ms, walks the options with the arrow keys, and turns a choice into a chip. The host gives it
 * the box's value and `inputRef`, puts `onKeyDown` on the composer, `chips` in its `top` slot (`<MentionChips>`) and
 * `listbox` inside a `relative` wrapper around it. `refs` are what it sends with the message.
 */
import { createElement, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { MentionListbox } from '@/components/ui/mention-picker';
import { api } from './api';
import { usePhone } from './use-phone';
import {
  addChip,
  flatHits,
  mentionQueryAt,
  optionId,
  parseRecents,
  pickerSections,
  pushRecent,
  refOf,
  removeChip,
  removeMentionText,
  stepActive,
  type MentionHit,
  type MentionRef,
  type MentionsResponse,
} from '@/lib/shared/mentions';

const RECENTS_KEY = 'landflow.mentions.recent';
const DEBOUNCE_MS = 150;

const readRecents = (): MentionHit[] => {
  try {
    return parseRecents(window.localStorage.getItem(RECENTS_KEY));
  } catch {
    return [];
  }
};

export interface MentionPicker {
  chips: MentionHit[];
  refs: MentionRef[];
  remove: (ref: MentionRef) => void;
  /** Forget every chip (after a send). */
  clear: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  listbox: ReactNode;
  open: boolean;
}

export function useMentionPicker({
  value,
  onChange,
  inputRef,
  scope,
}: {
  value: string;
  onChange: (value: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  scope: { workflowId?: string; local?: MentionHit[] };
}): MentionPicker {
  const listId = useId();
  const phone = usePhone();
  const [chips, setChips] = useState<MentionHit[]>([]);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState<number | undefined>();
  const [active, setActive] = useState(0);
  const [remote, setRemote] = useState<MentionsResponse['groups']>([]);
  const [loading, setLoading] = useState(false);
  const [recents, setRecents] = useState<MentionHit[]>([]);
  const [keyboardInset, setKeyboardInset] = useState(0);

  const at = useMemo(() => mentionQueryAt(value, Math.min(caret, value.length)), [value, caret]);
  const query = at?.query;
  const wanted = at !== undefined && dismissed !== at.start;
  const workflowId = scope.workflowId;

  // The caret moves without the text changing (a click, an arrow key): read it from the box.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const read = () => setCaret(el.selectionStart ?? 0);
    read();
    el.addEventListener('click', read);
    el.addEventListener('keyup', read);
    el.addEventListener('focus', read);
    return () => {
      el.removeEventListener('click', read);
      el.removeEventListener('keyup', read);
      el.removeEventListener('focus', read);
    };
  }, [inputRef]);
  useEffect(() => setCaret(inputRef.current?.selectionStart ?? value.length), [value, inputRef]);

  // A new `@` after Esc opens it again.
  useEffect(() => {
    if (!at) setDismissed(undefined);
  }, [at]);

  useEffect(() => {
    if (wanted) setRecents(readRecents());
  }, [wanted]);

  // Type-ahead: 150 ms after the last key. The last answer is for another query, so it goes.
  useEffect(() => {
    if (!wanted || query === undefined) return;
    setRemote([]);
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: query });
      if (workflowId) params.set('workflowId', workflowId);
      api<MentionsResponse>(`/api/mentions?${params}`, { signal: controller.signal })
        .then((found) => setRemote(found.groups))
        .catch(() => undefined)
        .finally(() => !controller.signal.aborted && setLoading(false));
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [wanted, query, workflowId]);

  const sections = useMemo(() => pickerSections({ local: scope.local, recents, groups: remote, query: query ?? '', chosen: chips }), [scope.local, recents, remote, query, chips]);
  const hits = useMemo(() => flatHits(sections), [sections]);
  const open = wanted && (hits.length > 0 || loading);

  useEffect(() => setActive(0), [query, hits.length]);

  // On a phone the sheet sits above the on-screen keyboard.
  useEffect(() => {
    if (!open || !phone || !window.visualViewport) return setKeyboardInset(0);
    const vv = window.visualViewport;
    const read = () => setKeyboardInset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    read();
    vv.addEventListener('resize', read);
    vv.addEventListener('scroll', read);
    return () => {
      vv.removeEventListener('resize', read);
      vv.removeEventListener('scroll', read);
    };
  }, [open, phone]);

  // The box names the listbox and its active option for a screen reader.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (!open) {
      for (const name of ['role', 'aria-autocomplete', 'aria-expanded', 'aria-controls', 'aria-activedescendant']) el.removeAttribute(name);
      return;
    }
    el.setAttribute('role', 'combobox');
    el.setAttribute('aria-autocomplete', 'list');
    el.setAttribute('aria-expanded', 'true');
    el.setAttribute('aria-controls', listId);
    if (hits.length) el.setAttribute('aria-activedescendant', optionId(listId, Math.min(active, hits.length - 1)));
    else el.removeAttribute('aria-activedescendant');
    return () => {
      for (const name of ['role', 'aria-autocomplete', 'aria-expanded', 'aria-controls', 'aria-activedescendant']) el.removeAttribute(name);
    };
  }, [inputRef, open, listId, active, hits.length]);

  const choose = useCallback(
    (hit: MentionHit) => {
      if (!at) return;
      const next = removeMentionText(value, at.start, Math.min(caret, value.length));
      onChange(next.value);
      setChips((current) => addChip(current, hit));
      setRecents((current) => {
        const updated = pushRecent(current, hit);
        try {
          window.localStorage.setItem(RECENTS_KEY, JSON.stringify(updated));
        } catch {}
        return updated;
      });
      // The caret goes back where the text was, once the new value is in the box.
      requestAnimationFrame(() => {
        const el = inputRef.current;
        el?.focus();
        el?.setSelectionRange(next.caret, next.caret);
        setCaret(next.caret);
      });
    },
    [at, value, caret, onChange, inputRef],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!open || e.nativeEvent.isComposing) return;
      // Still looking with nothing to choose: Enter must not send the raw @text.
      if (e.key === 'Enter' && !e.shiftKey && !hits.length && loading) {
        e.preventDefault();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => stepActive(a, e.key === 'ArrowDown' ? 1 : -1, hits.length));
      } else if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && hits.length) {
        e.preventDefault();
        choose(hits[Math.min(active, hits.length - 1)]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(at?.start);
      }
    },
    [open, hits, active, choose, at, loading],
  );

  const remove = useCallback((ref: MentionRef) => setChips((current) => removeChip(current, ref)), []);
  const clear = useCallback(() => setChips([]), []);
  const refs = useMemo(() => chips.map(refOf), [chips]);

  const listbox = open ? createElement(MentionListbox, { id: listId, sections, activeIndex: Math.min(active, Math.max(0, hits.length - 1)), onChoose: choose, phone, loading, keyboardInset }) : null;
  return { chips, refs, remove, clear, onKeyDown, listbox, open };
}
