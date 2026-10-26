'use client';
/**
 * The allow-list a project (its Settings tab) or a workflow (its settings dialog) sets below the instance's governance
 * policy: off (everything the level above allows) or only the listed node types and plugins. Controlled: the parent
 * keeps the value and saves it (lib/shared/project-policy.ts).
 */
import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ScopedNodePolicy } from '@/lib/shared/project-policy';
import { FieldLabel, Textarea } from '@/components/ui/inputs';

export interface NodeCatalog {
  plugins: Array<{ id: string; name: string }>;
  nodeTypes: Array<{ type: string; displayName: string; pluginId: string }>;
}

const lines = (text: string) => [...new Set(text.split(/[\n,]/).map((l) => l.trim()).filter(Boolean))];

/** Whether `type` (of `pluginId`) is on `policy`'s list: the same globs as the server's (`*` matches anything). */
export function onScopedList(policy: ScopedNodePolicy, type: string, pluginId: string): boolean {
  if (policy.mode !== 'allow') return true;
  const glob = (pattern: string, value: string) => new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i').test(value);
  return policy.types.some((p) => glob(p, type)) || policy.plugins.some((p) => glob(p, pluginId));
}

/** Text for the list's draft: types one per line (the textarea keeps what's typed until it loses focus). */
export const typesText = (policy: ScopedNodePolicy) => policy.types.join('\n');

export function ScopedNodeList({
  value,
  onChange,
  catalog,
  disabled,
  offLabel = 'No list',
  allowLabel = 'Allow only these',
}: {
  value: ScopedNodePolicy;
  onChange: (next: ScopedNodePolicy) => void;
  catalog?: NodeCatalog;
  disabled?: boolean;
  offLabel?: string;
  allowLabel?: string;
}) {
  const [draft, setDraft] = useState(typesText(value));
  const [query, setQuery] = useState('');
  const listed = useMemo(() => new Set(value.types), [value.types]);
  const shown = (catalog?.nodeTypes ?? []).filter((t) => query.trim() && `${t.type} ${t.displayName}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 12);
  const allowed = catalog ? catalog.nodeTypes.filter((t) => onScopedList(value, t.type, t.pluginId)).length : undefined;
  const setTypes = (text: string) => {
    setDraft(text);
    onChange({ ...value, types: lines(text) });
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-0.5 rounded-[10px] border border-hair bg-wl p-0.5" role="radiogroup" aria-label="Node allow-list">
        {(['off', 'allow'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={value.mode === mode}
            disabled={disabled}
            onClick={() => onChange({ ...value, mode })}
            className={cn('h-7 flex-1 rounded-[8px] text-[12px] transition-colors disabled:cursor-not-allowed', value.mode === mode ? 'bg-acdim font-semibold text-t1' : 'text-t2 hover:text-ac')}
          >
            {mode === 'off' ? offLabel : allowLabel}
          </button>
        ))}
      </div>
      {value.mode === 'allow' && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <FieldLabel>Node types</FieldLabel>
            <Textarea rows={5} value={draft} onChange={(e) => setTypes(e.target.value)} disabled={disabled} placeholder={'core.httpRequest\nmessaging.*'} className="font-mono text-[12px]" aria-label="Allowed node types" />
            <p className="mt-1 text-[11px] text-t3">One per line; * matches anything (messaging.*).</p>
            {!disabled && catalog && (
              <div className="mt-2 rounded-[10px] border border-hair bg-wl">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-t3" />
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a node type to add" className="h-8 w-full bg-transparent pl-8 pr-3 text-[12px] text-t1 outline-none placeholder:text-t3" />
                </div>
                {shown.length > 0 && (
                  <div className="max-h-40 overflow-y-auto border-t border-hair py-1">
                    {shown.map((t) => (
                      <button
                        key={t.type}
                        type="button"
                        disabled={listed.has(t.type)}
                        onClick={() => setTypes([...lines(draft), t.type].join('\n'))}
                        className="flex w-full items-center gap-2 px-3 py-1 text-left text-[12px] text-t1 hover:bg-acdim disabled:opacity-50"
                      >
                        <span className="truncate">{t.displayName}</span>
                        <span className="truncate font-mono text-[11px] text-t3">{t.type}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <div>
            <FieldLabel>Plugins (every node type of the plugin)</FieldLabel>
            <div className="max-h-[180px] overflow-y-auto rounded-[10px] border border-hair bg-wl py-1">
              {(catalog?.plugins ?? []).map((p) => (
                <label key={p.id} className="flex cursor-pointer items-center gap-2 px-3 py-1 text-[12px] text-t1 hover:bg-acdim">
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={value.plugins.includes(p.id)}
                    onChange={(e) => onChange({ ...value, plugins: e.target.checked ? [...value.plugins, p.id] : value.plugins.filter((id) => id !== p.id) })}
                  />
                  <span className="truncate">{p.name}</span>
                  <span className="truncate font-mono text-[11px] text-t3">{p.id}</span>
                </label>
              ))}
              {!catalog?.plugins.length && <div className="px-3 py-2 text-[12px] text-t3">{catalog ? 'No plugins registered' : 'Loading…'}</div>}
            </div>
          </div>
        </div>
      )}
      {value.mode === 'allow' && allowed !== undefined && (
        <p className="text-[12px] text-t3">
          {allowed} of {catalog!.nodeTypes.length} node types on the list{allowed === 0 ? ': nothing could run. Add node types or plugins.' : '.'} The instance’s own rules still apply.
        </p>
      )}
    </div>
  );
}
