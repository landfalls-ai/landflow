'use client';
/**
 * The Memory part of "What it saw" (docs/run-trace.md#what-it-saw, C11): for each memory source a run was given (an agent's
 * profile and relevant memories, a team's notebook block) the items with kind, version and score, one line each clamped to two
 * lines, and, when the run's content was `full`, **Show the exact text**: the fenced block as the model got it, unescaped for
 * reading. On open it asks `/api/memory/items` once for the items' state now: an item forgotten since says so, with the reason,
 * and a person who may change it gets Forget and Versions. Nothing is drawn for a run without memory (an old run, or content `off`).
 */
import { useEffect, useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { stamp } from '@/lib/client/format';
import type { BrainFact } from '@/lib/shared/brain';
import { unescapeFenceText } from '@/lib/shared/memory-fence';
import type { SawMemorySource } from '@/lib/shared/what-it-saw';
import { SAW_MEMORY_LABEL } from '@/lib/shared/what-it-saw-sections';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { FactHistory, ForgetDialog } from '../brain/fact-history';

/** What `/api/memory/items` answers for one id. */
export interface SawItemState {
  id: string;
  live: boolean;
  version?: number;
  text?: string;
  forgottenAt?: string;
  reason?: string;
  canChange?: boolean;
  /** A note's team (to forget it). */
  teamId?: string;
}

const SHOWN = 5;
/** Facts have colon-built ids (`project:<id>:memory:<n>`); notes do not. */
const isFact = (id: string) => id.includes(':');

export interface SawMemoryProps {
  memory: SawMemorySource[];
  /** The exact fenced block(s); present when the run's trace content was `full`. */
  memoryText?: string;
  /** Item states known already (a test, or a caller that read them); the part reads them itself when absent. */
  states?: Record<string, SawItemState>;
}

function Source({ source, states, onForget, onVersions }: { source: SawMemorySource; states: Record<string, SawItemState>; onForget: (id: string, text: string) => void; onVersions: (id: string) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? source.items : source.items.slice(0, SHOWN);
  const label = SAW_MEMORY_LABEL[source.source];
  return (
    <div className="min-w-0" data-testid={`saw-memory-${source.source}`}>
      <div className="flex flex-wrap items-center gap-1.5 text-[12px] font-semibold text-t2">
        <span>
          {label}
          {source.mode ? ` (${source.mode})` : ''}
        </span>
        <Badge tone="muted">{source.count}</Badge>
        {source.count > source.items.length && <span className="font-normal text-t3">first {source.items.length} listed</span>}
      </div>
      <ul className="mt-1 flex flex-col gap-1.5">
        {shown.map((item) => {
          const state = states[item.id];
          const gone = state && !state.live;
          return (
            <li key={item.id} className="min-w-0 rounded-lg border border-hair bg-sf px-2.5 py-1.5 text-[13px]">
              <p className="line-clamp-2 break-words text-t1 [overflow-wrap:anywhere]">{state?.text ?? item.id}</p>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-t3">
                {item.kind && <span>{item.kind}</span>}
                {(item.version ?? state?.version) !== undefined && <span>v{item.version ?? state?.version}</span>}
                {item.static && <span>always given</span>}
                {item.score !== undefined && <span>score {item.score.toFixed(2)}</span>}
                {gone && (
                  <span className="text-warn" data-testid="saw-forgotten">
                    forgotten since {stamp(state.forgottenAt)}
                    {state.reason ? `: ${state.reason}` : ''}
                  </span>
                )}
              </div>
              {state?.canChange && (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {isFact(item.id) && (
                    <Button size="sm" variant="ghost" onClick={() => onVersions(item.id)}>
                      Versions
                    </Button>
                  )}
                  {state.live && (
                    <Button size="sm" variant="ghost" onClick={() => onForget(item.id, state.text ?? item.id)}>
                      Forget
                    </Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {source.items.length > SHOWN && (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-1 min-h-7 text-[12px] font-medium text-ac hover:underline">
          {all ? 'Show fewer' : `Show all ${source.items.length}`}
        </button>
      )}
      {source.hash && <p className="mt-0.5 font-mono text-[11px] text-t3">Block hash {source.hash}</p>}
    </div>
  );
}

export function SawMemory({ memory, memoryText, states: given }: SawMemoryProps) {
  const ids = useMemo(() => [...new Set(memory.flatMap((s) => s.items.map((i) => i.id)))], [memory]);
  const [read, setRead] = useState<Record<string, SawItemState>>({});
  const [forgetting, setForgetting] = useState<{ id: string; text: string }>();
  const [history, setHistory] = useState<string>();
  useEffect(() => {
    if (given || !ids.length) return;
    let live = true;
    // At most 50 ids a call (the route's cap): ask in batches.
    const batches = Array.from({ length: Math.ceil(ids.length / 50) }, (_, i) => ids.slice(i * 50, i * 50 + 50));
    Promise.all(batches.map((batch) => api<{ items: SawItemState[] }>(`/api/memory/items?ids=${batch.map(encodeURIComponent).join(',')}`, { background: true })))
      .then((all) => live && setRead(Object.fromEntries(all.flatMap((r) => r.items).map((i) => [i.id, i]))))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [ids, given]);
  const states = given ?? read;
  if (!memory.length) return null;
  const forget = async (reason: string, forgetAfter?: string) => {
    if (!forgetting) return;
    const { id } = forgetting;
    if (isFact(id)) await api(`/api/brain/facts/${encodeURIComponent(id)}/forget`, { method: 'POST', json: { reason, ...(forgetAfter && { forgetAfter }) } });
    else {
      const teamId = states[id]?.teamId;
      if (!teamId) throw new Error('Open the team’s Notebook tab to forget this note');
      await api(`/api/agent-teams/${encodeURIComponent(teamId)}/notes/${encodeURIComponent(id)}`, { method: 'POST', json: { action: 'forget', reason, ...(forgetAfter && { forgetAfter }) } });
    }
    toast.success(forgetAfter ? 'It will be forgotten then' : 'Forgotten');
    setRead((r) => ({ ...r, [id]: { ...r[id], id, live: false, forgottenAt: new Date().toISOString(), reason } }));
  };
  return (
    <div className="flex flex-col gap-2" data-testid="saw-memory">
      {memory.map((source) => (
        <Source key={source.source} source={source} states={states} onForget={(id, text) => setForgetting({ id, text })} onVersions={setHistory} />
      ))}
      {memoryText && (
        <details className="group min-w-0">
          <summary className="flex min-h-7 cursor-pointer list-none items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3 hover:text-t2 [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3 transition-transform group-open:rotate-90" /> Show the exact text of the memory
          </summary>
          <pre className="mt-1 max-h-[40dvh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-hair bg-sf px-2.5 py-2 font-mono text-[12px] text-t2">{unescapeFenceText(memoryText)}</pre>
        </details>
      )}
      {forgetting && <ForgetDialog what={forgetting.text} onClose={() => setForgetting(undefined)} onForget={forget} />}
      {history && <FactHistory fact={{ id: history, subjectId: history, kind: 'memory' } as BrainFact} onClose={() => setHistory(undefined)} />}
    </div>
  );
}
