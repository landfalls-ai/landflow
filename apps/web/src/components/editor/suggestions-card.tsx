'use client';
/**
 * "✨ Suggestions" in the node panel's output pane: after a node runs in the
 * editor, the assistant looks at it and its data and offers fixes, parameter
 * tweaks, data notes and next nodes, each applied with one click.
 */
import { useEffect, useState } from 'react';
import { Check, Loader2, RotateCcw, Sparkles, TriangleAlert, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { describeOps } from '@/lib/shared/assistant-ops';
import type { NodeRun } from '@/lib/shared/types';
import { Badge, type Tone } from '../ui/badge';
import { Button } from '../ui/button';
import { Switch } from '../ui/inputs';
import { applyChanges, editorLookup, readAutoSuggest, suggestionKey, useSuggestions, writeAutoSuggest, type Suggestion, type SuggestionKind } from './assistant';
import { useEditor } from './store';

export const KIND_META: Record<SuggestionKind, { label: string; tone: Tone }> = {
  fix: { label: 'Fix', tone: 'danger' },
  param: { label: 'Tweak', tone: 'accent' },
  data: { label: 'Data', tone: 'warning' },
  next: { label: 'Next step', tone: 'success' },
};

/** What applying a change would leave dangling. */
export function Warnings({ warnings }: { warnings?: string[] }) {
  if (!warnings?.length) return null;
  return (
    <div className="flex items-start gap-1.5 text-[11px] leading-snug text-warn">
      <TriangleAlert className="mt-px size-3 shrink-0" />
      <span>Leaves {warnings.join('; ')}.</span>
    </div>
  );
}

/** What a change left out, with a "why" that opens the reasons in place (a hover can't be reached by touch or keys). */
export function LeftOut({ reasons, label }: { reasons: string[]; label?: string }) {
  const [open, setOpen] = useState(false);
  if (!reasons.length) return null;
  return (
    <div className="text-[11px] leading-snug text-t3">
      <span>{label ?? `${reasons.length} part${reasons.length === 1 ? '' : 's'} left out`}</span>{' '}
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="font-semibold text-ac hover:underline max-md:min-h-11 max-md:px-1">
        {open ? 'Hide why' : 'Why?'}
      </button>
      {open && (
        <ul className="mt-1 list-disc space-y-0.5 pl-4 [overflow-wrap:anywhere]">
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The ops of a change as diff lines: + node, ~ params, → connection, − removed, ✎ renamed. */
export function OpsDiff({ ops, className }: { ops: Suggestion['ops']; className?: string }) {
  const lines = describeOps(ops, editorLookup());
  return (
    <div className={cn('space-y-0.5 rounded-lg border border-hair bg-sf px-2 py-1.5 font-mono text-[11px] leading-snug', className)}>
      {lines.map((line, i) => (
        <div key={i} className="flex gap-1.5">
          <span className={cn('w-3 shrink-0 text-center font-semibold', line.sign === '+' ? 'text-gn' : line.sign === '−' ? 'text-rd' : line.sign === '~' ? 'text-warn' : 'text-ac')}>{line.sign}</span>
          <span className="min-w-0 [overflow-wrap:anywhere] text-t2">{line.text}</span>
        </div>
      ))}
    </div>
  );
}

function SuggestionRow({ suggestion, state, onApply, onDismiss }: { suggestion: Suggestion; state?: 'applied' | 'dismissed'; onApply: () => void; onDismiss: () => void }) {
  const meta = KIND_META[suggestion.kind];
  return (
    <div className={cn('animate-fade-up space-y-1.5 rounded-[10px] border border-hair bg-wl p-2.5', state === 'applied' && 'border-gnbd')}>
      <div className="flex items-start gap-2">
        <Badge tone={meta.tone} className="mt-px">
          {meta.label}
        </Badge>
        <span className="min-w-0 flex-1 text-[13px] font-semibold leading-snug text-t1">{suggestion.title}</span>
        <span className="whitespace-nowrap text-[11px] text-t3" title="How sure the model is">
          {Math.round(suggestion.confidence * 100)}% sure
        </span>
      </div>
      {suggestion.detail && <p className="text-[12px] leading-relaxed text-t2">{suggestion.detail}</p>}
      {suggestion.ops.length > 0 && <OpsDiff ops={suggestion.ops} />}
      <Warnings warnings={suggestion.warnings} />
      {!suggestion.ops.length && suggestion.dropped?.length ? (
        <LeftOut reasons={suggestion.dropped} label="Advice only: the change the model proposed doesn’t fit this workflow." />
      ) : null}
      <div className="flex items-center gap-1.5 pt-0.5">
        {state === 'applied' ? (
          <span className="flex animate-pop items-center gap-1 text-[12px] font-semibold text-gn">
            <Check className="size-3.5" /> Applied
          </span>
        ) : (
          <>
            {suggestion.ops.length > 0 && (
              <Button size="sm" variant="primary" onClick={onApply}>
                Apply
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              Dismiss
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export function SuggestionsCard({ nodeId, run }: { nodeId: string; run: NodeRun }) {
  const workflowId = useEditor((s) => s.workflowId);
  const running = useEditor((s) => s.running);
  const nodeName = useEditor((s) => s.nodes.find((n) => n.id === nodeId)?.data.wf.name);
  const nodeType = useEditor((s) => s.nodes.find((n) => n.id === nodeId)?.data.wf.type);
  const key = suggestionKey(workflowId, nodeId, run);
  const entry = useSuggestions((s) => s.entries[key]);
  const [auto, setAuto] = useState(readAutoSuggest);

  // Auto mode asks once per run, a moment after the panel shows it (debounced: runs come in bursts).
  useEffect(() => {
    if (!auto || running || entry || run.source !== 'main') return;
    const timer = setTimeout(() => useSuggestions.getState().request(nodeId, run), 600);
    return () => clearTimeout(timer);
  }, [auto, running, entry, nodeId, run]);

  if (run.source !== 'main' || entry?.result?.skipped) return null;
  const request = (force = false) => useSuggestions.getState().request(nodeId, run, force);
  const visible = entry?.result?.suggestions.filter((s) => entry.handled[s.id] !== 'dismissed') ?? [];

  return (
    <div className="relative mx-3 mt-3 shrink-0 overflow-hidden rounded-xl border border-hair bg-sf">
      {entry?.status === 'loading' && <span className="lf-shimmer absolute inset-x-0 top-0 h-[2px]" />}
      <div className="flex h-9 items-center gap-2 px-3">
        <Sparkles className="size-3.5 text-viz-7" />
        <span className="text-[12px] font-semibold text-t1">Suggestions</span>
        {entry?.status === 'done' && visible.length > 0 && <span className="font-mono text-[11px] text-t3">{visible.length}</span>}
        <div className="ml-auto flex items-center gap-2">
          {entry && entry.status !== 'loading' && (
            <button onClick={() => request(true)} title="Ask again" aria-label="Ask again" className="grid size-6 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1">
              <RotateCcw className="size-3" />
            </button>
          )}
          <label className="flex items-center gap-1.5 text-[11px] text-t3" title="Ask for suggestions automatically after a node runs">
            Auto
            <Switch
              checked={auto}
              label="Auto-suggest"
              onChange={(value) => {
                setAuto(value);
                writeAutoSuggest(value);
              }}
            />
          </label>
        </div>
      </div>

      <div className="max-h-[300px] space-y-2 overflow-y-auto px-3 pb-3">
        {!entry && !auto && (
          <Button size="sm" onClick={() => request()} disabled={running}>
            <Sparkles className="size-3.5 text-viz-7" /> Suggest
          </Button>
        )}
        {(entry?.status === 'loading' || (!entry && auto)) && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-[12px] text-t2">
              <Loader2 className="size-3.5 animate-spin" /> Looking at {nodeName ? `“${nodeName}”` : 'this node'} and its data…
            </div>
            {[0, 1].map((i) => (
              <div key={i} className="animate-pulse-soft space-y-1.5 rounded-[10px] border border-hair bg-wl p-2.5" style={{ animationDelay: `${i * 200}ms` }}>
                <div className="h-3 w-2/3 rounded bg-nudim" />
                <div className="h-2.5 w-full rounded bg-nudim" />
              </div>
            ))}
          </div>
        )}
        {entry?.status === 'error' && (
          <div className="flex items-start gap-2 rounded-[10px] border border-rdbd bg-rddim px-2.5 py-2 text-[12px] text-rd">
            <X className="mt-px size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{entry.error}</span>
            <button onClick={() => request(true)} className="font-semibold underline-offset-2 hover:underline">
              Retry
            </button>
          </div>
        )}
        {entry?.status === 'done' && visible.length === 0 && (
          <p className="text-[12px] text-t3">{entry.result?.suggestions.length ? 'All handled.' : 'Looks good: nothing to suggest for this run.'}</p>
        )}
        {entry?.status === 'done' &&
          visible.map((suggestion) => (
            <SuggestionRow
              key={suggestion.id}
              suggestion={suggestion}
              state={entry.handled[suggestion.id]}
              onApply={() => {
                if (applyChanges([{ ops: suggestion.ops, kind: suggestion.kind, nodeType }], suggestion.title)) useSuggestions.getState().handle(key, suggestion, 'applied');
              }}
              onDismiss={() => useSuggestions.getState().handle(key, suggestion, 'dismissed')}
            />
          ))}
        {entry?.status === 'done' && entry.result && (
          <div className="font-mono text-[10.5px] text-t3">
            {entry.result.model} · {(entry.result.durationMs / 1000).toFixed(1)} s
          </div>
        )}
      </div>
    </div>
  );
}
