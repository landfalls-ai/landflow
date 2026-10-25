'use client';
/**
 * Tags in the editor's top bar: pills with a remove button and an inline
 * field to add one (suggesting tags used by other workflows). Tags are saved
 * with the workflow (`workflow.tags`) and filter the workflows list.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Plus, Tag, X } from 'lucide-react';
import { api } from '@/lib/client/api';
import type { WorkflowSummary } from '@/lib/shared/types';
import { useEditor } from './store';

const MAX_SHOWN = 3;

export function TagsEditor() {
  const tags = useEditor((s) => s.tags);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [known, setKnown] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!adding) return;
    input.current?.focus();
    api<{ workflows: WorkflowSummary[] }>('/api/workflows')
      .then(({ workflows }) => setKnown([...new Set(workflows.flatMap((w) => w.tags))].sort((a, b) => a.localeCompare(b))))
      .catch(() => {});
  }, [adding]);

  const setTags = (next: string[]) => useEditor.getState().setMeta({ tags: next });
  const add = () => {
    const tag = draft.trim().replace(/\s+/g, ' ').slice(0, 40);
    if (tag && !tags.some((t) => t.toLowerCase() === tag.toLowerCase())) setTags([...tags, tag]);
    setDraft('');
  };
  const shown = expanded ? tags : tags.slice(0, MAX_SHOWN);

  return (
    <div className="flex min-w-0 items-center gap-1">
      {shown.map((tag) => (
        <span key={tag} className="group/tag flex h-6 max-w-[140px] shrink-0 items-center gap-1 rounded-full border border-hair bg-sf2 pl-2 pr-1 text-[12px] text-t2">
          <span className="truncate">{tag}</span>
          <button
            onClick={() => setTags(tags.filter((t) => t !== tag))}
            aria-label={`Remove tag ${tag}`}
            title="Remove tag"
            className="grid size-4 place-items-center rounded-full text-t3 opacity-60 transition hover:bg-acdim hover:text-t1 group-hover/tag:opacity-100"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      {!expanded && tags.length > MAX_SHOWN && (
        <button onClick={() => setExpanded(true)} className="h-6 shrink-0 rounded-full px-1.5 text-[12px] text-t3 hover:text-t1" title={tags.slice(MAX_SHOWN).join(', ')}>
          +{tags.length - MAX_SHOWN}
        </button>
      )}
      {adding ? (
        <>
          <input
            ref={input}
            value={draft}
            list={listId}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                add();
              } else if (e.key === 'Escape') {
                setDraft('');
                setAdding(false);
              } else if (e.key === 'Backspace' && !draft && tags.length) {
                setTags(tags.slice(0, -1));
              }
            }}
            onBlur={() => {
              add();
              setAdding(false);
            }}
            placeholder="Tag name"
            aria-label="New tag"
            className="h-6 w-[110px] shrink-0 rounded-full border border-acbd bg-wl px-2 text-[12px] text-t1 outline-none placeholder:text-t3"
          />
          <datalist id={listId}>
            {known
              .filter((t) => !tags.includes(t))
              .map((t) => (
                <option key={t} value={t} />
              ))}
          </datalist>
        </>
      ) : (
        <button
          onClick={() => setAdding(true)}
          title="Add a tag"
          aria-label="Add a tag"
          className="flex h-6 shrink-0 items-center gap-1 rounded-full border border-dashed border-bd px-2 text-[12px] text-t3 transition-colors hover:border-ac hover:text-t1"
        >
          {tags.length ? <Plus className="size-3" /> : <Tag className="size-3" />}
          {!tags.length && 'Add tag'}
        </button>
      )}
    </div>
  );
}
