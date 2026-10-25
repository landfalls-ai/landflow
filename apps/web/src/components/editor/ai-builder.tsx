'use client';
/**
 * "Describe your workflow": the local model drafts a flow from the node
 * catalog, the editor lays it out and drops it on the canvas, with test data
 * pinned on the trigger so Execute shows the logic working straight away.
 */
import { useEffect, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import { ArrowUp, Loader2, MessageSquareText, Sparkles, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import type { FlowTemplate, TemplateNode } from '@/lib/client/templates';
import type { ConnectionType, NodeItem } from '@/lib/shared/types';
import { useAssistant } from './assistant';
import { useEditor } from './store';

interface FlowDraft {
  name: string;
  nodes: TemplateNode[];
  edges: Array<[string, string, number, ConnectionType]>;
  pinData?: Record<string, NodeItem[]>;
  model: string;
  durationMs: number;
  dropped: string[];
}

const EXAMPLES = [
  'Score the sentiment of review texts, keep the negative ones and hash them',
  'On a webhook, extract keywords from the text and reply with them in upper case',
  'Generate 5 UUIDs, base64-encode each one and sort them',
];

/** Columns by longest path from the trigger; sub-nodes under the node they attach to. */
function layout(draft: FlowDraft): TemplateNode[] {
  const main = draft.edges.filter(([, , , type]) => type === 'main');
  const subs = draft.edges.filter(([, , , type]) => type !== 'main');
  const subKeys = new Set(subs.map(([from]) => from));
  const column: Record<string, number> = {};
  const visit = (key: string, depth: number, seen: Set<string>) => {
    if (seen.has(key) || (column[key] ?? -1) >= depth) return;
    column[key] = depth;
    for (const [from, to] of main) if (from === key) visit(to, depth + 1, new Set(seen).add(key));
  };
  for (const n of draft.nodes) if (!subKeys.has(n.key) && !main.some(([, to]) => to === n.key)) visit(n.key, 0, new Set());
  const rows: Record<number, number> = {};
  const placed = draft.nodes.map((n) => {
    if (subKeys.has(n.key)) return n;
    const c = column[n.key] ?? 0;
    const r = (rows[c] = (rows[c] ?? -1) + 1);
    return { ...n, x: c * 280, y: r * 170 };
  });
  // Centre each column vertically.
  for (const n of placed) if (!subKeys.has(n.key)) n.y -= (rows[column[n.key] ?? 0] * 170) / 2;
  for (const n of placed) {
    if (!subKeys.has(n.key)) continue;
    const [, parent] = subs.find(([from]) => from === n.key)!;
    const anchor = placed.find((p) => p.key === parent)!;
    const index = subs.filter(([, to]) => to === parent).findIndex(([from]) => from === n.key);
    n.x = anchor.x + 10 + index * 110;
    n.y = anchor.y + 200;
  }
  return placed;
}

export function useBuildFlow() {
  const { fitView } = useReactFlow();
  const [busy, setBusy] = useState(false);
  const build = async (prompt: string) => {
    if (busy || prompt.trim().length < 3) return false;
    setBusy(true);
    try {
      const { draft } = await api<{ draft: FlowDraft }>('/api/ai/build', { method: 'POST', json: { prompt } });
      const state = useEditor.getState();
      const right = state.nodes.length ? Math.max(...state.nodes.map((n) => n.position.x)) + 360 : 0;
      const top = state.nodes.length ? Math.min(...state.nodes.map((n) => n.position.y)) : 0;
      const template: FlowTemplate = { id: 'ai', title: draft.name, description: prompt, icon: 'lucide:sparkles', color: 'var(--viz-7)', nodes: layout(draft), edges: draft.edges, pinData: draft.pinData };
      state.applyTemplate(template, { x: right, y: top });
      if (/^untitled/i.test(state.name) || !state.name) state.setMeta({ name: draft.name });
      setTimeout(() => fitView({ padding: 0.25, duration: 600, maxZoom: 1.1 }), 60);
      const note = draft.dropped.length ? ` (skipped ${draft.dropped.length} invalid part${draft.dropped.length === 1 ? '' : 's'})` : '';
      toast.success(`Built “${draft.name}” with ${draft.model} in ${(draft.durationMs / 1000).toFixed(1)} s${note}`, {
        description: draft.pinData ? 'Test data is pinned on the trigger: press Execute workflow to see it work.' : 'Press Execute workflow to try it.',
      });
      return true;
    } catch (e) {
      toast.error(`Couldn’t build the flow: ${(e as Error).message}`);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { build, busy };
}

/** The prompt box. `compact` is the floating version opened from the canvas toolbar. */
export function AiBuilder({ onDone, autoFocus, className }: { onDone?: () => void; autoFocus?: boolean; className?: string }) {
  const [prompt, setPrompt] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const { build, busy } = useBuildFlow();
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);
  useEffect(() => {
    if (!busy) return setElapsed(0);
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500);
    return () => clearInterval(timer);
  }, [busy]);

  const submit = async () => {
    if (await build(prompt)) {
      setPrompt('');
      onDone?.();
    }
  };

  return (
    <div className={cn('relative w-full overflow-hidden rounded-2xl border border-bd bg-sf shadow-[0_4px_24px_rgba(0,0,0,0.06)] transition-shadow focus-within:shadow-pop', className)}>
      {busy && <span className="lf-shimmer absolute inset-x-0 top-0 h-[3px]" />}
      <div className="flex items-start gap-2.5 p-3">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-[10px] bg-[color-mix(in_oklab,var(--viz-7)_14%,var(--sf))]">
          <Sparkles className="size-4 text-viz-7" />
        </span>
        <textarea
          ref={input}
          rows={2}
          value={prompt}
          disabled={busy}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
            if (e.key === 'Escape') onDone?.();
            e.stopPropagation();
          }}
          placeholder="Describe a workflow and the local model builds it… e.g. score review sentiment and hash the negative ones"
          className="min-h-[44px] flex-1 resize-none bg-transparent text-[14px] leading-snug text-t1 outline-none placeholder:text-t3 disabled:opacity-60"
        />
        <button
          onClick={() => void submit()}
          disabled={busy || prompt.trim().length < 3}
          aria-label="Build workflow"
          className="grid size-8 shrink-0 place-items-center rounded-full bg-ac2 text-on-ac transition-all hover:scale-105 disabled:opacity-30 disabled:hover:scale-100"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-t border-hair px-3 py-2">
        {busy ? (
          <span className="text-[12px] text-t2">Designing the flow from {Object.keys(useEditor.getState().nodeTypes).length} node types… {elapsed}s</span>
        ) : prompt.trim().length >= 3 ? (
          <button
            onClick={() => {
              void useAssistant.getState().send(prompt);
              setPrompt('');
              onDone?.();
            }}
            title="Build it step by step with the assistant instead, and review each change"
            className="flex items-center gap-1.5 rounded-full border border-hair px-2.5 py-0.5 text-[11.5px] text-t2 transition-colors hover:border-acbd hover:text-t1"
          >
            <MessageSquareText className="size-3" /> Continue in chat
          </button>
        ) : (
          EXAMPLES.map((example) => (
            <button key={example} onClick={() => setPrompt(example)} className="truncate rounded-full border border-hair px-2.5 py-0.5 text-[11.5px] text-t2 transition-colors hover:border-acbd hover:text-t1">
              {example}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

/** Floating builder opened from the canvas toolbar when the canvas isn't empty. */
export function AiBuilderPopover({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="absolute left-1/2 top-4 z-30 w-[640px] max-w-[calc(100%-32px)] -translate-x-1/2 animate-fade-up">
      <button onClick={onClose} aria-label="Close" className="absolute -right-2 -top-2 z-10 grid size-6 place-items-center rounded-full border border-hair bg-sf text-t3 shadow-pop hover:text-t1">
        <X className="size-3.5" />
      </button>
      <AiBuilder autoFocus onDone={onClose} />
    </div>
  );
}
