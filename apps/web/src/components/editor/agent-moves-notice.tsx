'use client';
/**
 * AG17: the notice after a flow's own wiring moved into its agents (docs/agents.md#from-workflows). A side card, canvas-first (it sits
 * at the canvas's top right, never over its centre, and folds to a bottom sheet on a phone): each item that moved and its agent, each
 * kept item and why, and each agent's changes not published, with Publish (the smoke test on the draft, then the eval gate: never
 * skipped) and Open <agent>. Closed, it stays as a one-line pill ("Moved into agents · 2") that reopens the whole record.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRightLeft, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { isPhone } from '@/lib/client/use-phone';
import { moveNow, readMoves } from '@/lib/client/agent-moves';
import { AGENT_CHANGED, AGENT_SAVED, publishChange, testDraft } from '@/lib/client/agent-change';
import { MOVES_CHANGED, moveNoticeLines, type AgentMove } from '@/lib/shared/agent-bubbles';
import type { AgentPublish } from '@/lib/shared/agent-card';
import type { NodeTypeInfo, Workflow } from '@/lib/shared/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useEditLock } from './edit-lock';
import { usePublication } from './publish-control';
import { useEditor } from './store';

const seenKey = (workflowId: string) => `landflow.agentMoves.seen.${workflowId}`;
const readSeen = (workflowId: string): string => {
  try {
    return window.localStorage.getItem(seenKey(workflowId)) ?? '';
  } catch {
    return '';
  }
};
const writeSeen = (workflowId: string, at: string) => {
  try {
    window.localStorage.setItem(seenKey(workflowId), at);
  } catch {
    // Private mode: the notice shows again next time.
  }
};

/** Resolves true once this tab holds the edit lock (false when someone else does, or it never settles). */
export function whenLockHeld(timeoutMs = 8_000): Promise<boolean> {
  const decided = () => {
    const s = useEditLock.getState();
    return s.known ? !s.readOnly : undefined;
  };
  return new Promise((resolve) => {
    const now = decided();
    if (now !== undefined) return resolve(now);
    const done = (value: boolean) => {
      unsubscribe();
      clearTimeout(timer);
      resolve(value);
    };
    const unsubscribe = useEditLock.subscribe(() => {
      const v = decided();
      if (v !== undefined) done(v);
    });
    const timer = setTimeout(() => done(false), timeoutMs);
  });
}

/** Load the flow again after a move (the answer's `updatedAt` is the new baseline). Edits in progress are kept: nothing is reloaded over them. */
export async function reloadWorkflow(workflowId: string): Promise<void> {
  const state = useEditor.getState();
  if (state.workflowId !== workflowId) return;
  if (state.dirty) {
    toast.message('The flow’s wiring moved into its agents', { description: 'Save or discard your changes, then reload to see the flow without it.' });
    return;
  }
  const { workflow } = await api<{ workflow: Workflow }>(`/api/workflows/${workflowId}`, { background: true });
  state.load(workflow, Object.values(state.nodeTypes) as NodeTypeInfo[]);
}

const when = (at: string) => {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
};

/** The whole record, one line per item: what happened, where, who and when. */
function MoveRecord({ moves, onRetry, onResolve }: { moves: AgentMove[]; onRetry: (m: AgentMove) => void; onResolve: (m: AgentMove) => void }) {
  return (
    <ul className="space-y-2" aria-label="Everything that moved from this flow">
      {moves.map((m) => (
        <li key={`${m.subNodeId}-${m.nodeId}`} className="rounded-lg border border-hair bg-sf2 px-2.5 py-2 text-[12px]">
          <div className="flex flex-wrap items-baseline gap-x-1.5">
            <span className="font-semibold text-t1">{m.name}</span>
            <span className="text-t3">{m.as === 'knowledge' ? 'knowledge base' : (m.as ?? m.slot)}</span>
            <span className={cn('ml-auto rounded px-1 text-[11px] font-medium', m.outcome === 'kept' ? 'bg-warndim text-warn' : 'bg-acdim text-ac')}>
              {m.outcome === 'moved' ? `moved into ${m.agentName}` : m.outcome === 'same' ? `already in ${m.agentName}` : 'kept in this flow'}
            </span>
          </div>
          {m.why && <p className="mt-1 text-t2">{m.why}</p>}
          {m.state && m.outcome === 'moved' && <p className="mt-0.5 text-t3">{m.state === 'pending' ? 'not published yet' : m.state === 'live' ? 'published: live' : 'removed from the agent’s draft'}</p>}
          <p className="mt-0.5 text-t3">
            {m.by === 'migration' ? 'by the host’s start pass' : 'on open'} · {when(m.at)}
          </p>
          {m.outcome === 'kept' && (m.retry || m.resolvable) && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {m.retry && (
                <Button size="sm" variant="outline" onClick={() => onRetry(m)}>
                  Try again
                </Button>
              )}
              {m.resolvable && (
                <Button size="sm" variant="outline" onClick={() => onResolve(m)}>
                  Use for {m.agentName} everywhere
                </Button>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

export function AgentMovesNotice({ workflowId }: { workflowId: string }) {
  const [moves, setMoves] = useState<AgentMove[]>([]);
  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState(false);
  // Agents whose published version is newer than this workflow's production pin ("Keep v2 until republish"): published is not in production.
  const [pinnedOlder, setPinnedOlder] = useState<ReadonlySet<string>>(new Set());
  const [publishing, setPublishing] = useState<Record<string, string>>({});
  const readOnly = useEditLock((s) => s.readOnly);

  const load = useCallback(async (): Promise<AgentMove[]> => {
    try {
      const list = await readMoves(workflowId);
      setMoves(list);
      return list;
    } catch {
      return [];
    }
  }, [workflowId]);

  // A publish (here or from the version history) moves the production pin: look again when the production version changes.
  const productionVersion = usePublication((s) => (s.workflowId === workflowId ? s.status?.published?.versionId : undefined));
  useEffect(() => {
    let live = true;
    const look = () =>
      void api<{ updates: Array<{ agentId: string }> }>(`/api/workflows/${workflowId}/agent-updates`, { background: true }).then(
        (r) => live && setPinnedOlder(new Set((r.updates ?? []).map((u) => u.agentId))),
        () => undefined,
      );
    // The moves event names its workflow: another flow's move says nothing about this one's pins.
    const lookForMine = (e: Event) => {
      if ((e as CustomEvent<{ workflowId?: string }>).detail?.workflowId === workflowId) look();
    };
    look();
    window.addEventListener(AGENT_CHANGED, look);
    window.addEventListener(AGENT_SAVED, look);
    window.addEventListener(MOVES_CHANGED, lookForMine);
    return () => {
      live = false;
      window.removeEventListener(AGENT_CHANGED, look);
      window.removeEventListener(AGENT_SAVED, look);
      window.removeEventListener(MOVES_CHANGED, lookForMine);
    };
  }, [workflowId, productionVersion]);

  // The first time a person opens the flow after a move the card opens by itself; a later open shows the pill only.
  useEffect(() => {
    let live = true;
    setMoves([]);
    setOpen(false);
    setRecord(false);
    void load().then((list) => {
      // A phone starts as the small pill (the sheet hid the canvas); the first open per flow is for the desktop.
      if (live && list.length && list[0]!.at > readSeen(workflowId) && !isPhone()) setOpen(true);
    });
    return () => {
      live = false;
    };
  }, [workflowId, load]);

  useEffect(() => {
    const onChanged = (e: Event) => {
      if ((e as CustomEvent<{ workflowId?: string }>).detail?.workflowId !== workflowId) return;
      void load().then((list) => {
        if (list.length && list[0]!.at > readSeen(workflowId) && !isPhone()) setOpen(true);
      });
    };
    window.addEventListener(MOVES_CHANGED, onChanged);
    return () => window.removeEventListener(MOVES_CHANGED, onChanged);
  }, [workflowId, load]);

  // Open, it collapses to the pill (and remembers that it was seen) on any pointerdown on the canvas, so it never sits over the bubbles.
  const asideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target?.closest?.('.react-flow') || asideRef.current?.contains(target)) return;
      if (moves[0]?.at) writeSeen(workflowId, moves[0].at);
      setOpen(false);
      setRecord(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open, moves, workflowId]);

  const newest = moves[0]?.at ?? '';
  const unseen = useMemo(() => moves.filter((m) => m.at > readSeen(workflowId)), [moves, workflowId, open]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = record ? moves : unseen.length ? unseen : moves;
  const agents = useMemo(() => {
    const byId = new Map<string, { id: string; name: string; draftDiffers: boolean }>();
    for (const m of shown) if (m.outcome === 'moved' && m.state === 'pending') byId.set(m.agentId, { id: m.agentId, name: m.agentName, draftDiffers: true });
    return [...byId.values()];
  }, [shown]);
  const lines = moveNoticeLines(shown, agents, pinnedOlder);

  const close = () => {
    if (newest) writeSeen(workflowId, newest);
    setOpen(false);
    setRecord(false);
  };

  const publish = async (agent: { id: string; name: string }) => {
    setPublishing((p) => ({ ...p, [agent.id]: 'Testing the draft…' }));
    const smoke = await testDraft(agent.id, `Hello ${agent.name}, what can you do?`);
    if (smoke.state !== 'passed') {
      setPublishing((p) => ({ ...p, [agent.id]: `The test did not pass${smoke.reason ? `: ${smoke.reason}` : ''}. Nothing was published.` }));
      return;
    }
    setPublishing((p) => ({ ...p, [agent.id]: 'Running the gate…' }));
    const result: AgentPublish = await publishChange(agent.id);
    setPublishing((p) => ({
      ...p,
      [agent.id]: result.state === 'published' ? 'Published.' : result.state === 'held' ? `The gate holds it${result.score !== undefined ? ` (score ${result.score})` : ''}${result.reason ? `: ${result.reason}` : ''}. Nothing was published.` : `Couldn’t publish${result.reason ? `: ${result.reason}` : ''}.`,
    }));
    void load();
  };

  const again = async (m: AgentMove, resolve: boolean) => {
    const id = m.subNodeId;
    try {
      const baseUpdatedAt = useEditor.getState().baseUpdatedAt;
      const result = await moveNow({ id: workflowId, ...(baseUpdatedAt && { updatedAt: baseUpdatedAt }) }, { subNodeIds: [id], ...(resolve && { resolve: { [id]: 'useEverywhere' as const } }) });
      if (result.moved.length) await reloadWorkflow(workflowId);
      await load();
    } catch (e) {
      toast.error(`Couldn’t move ${m.name}`, { description: (e as Error).message });
    }
  };

  if (!moves.length) return null;
  const count = moves.filter((m) => m.outcome !== 'kept').length;

  if (!open) {
    return (
      <div className="pointer-events-none absolute right-14 top-3 z-20 max-md:right-16 max-md:top-3">
        <button
          type="button"
          onClick={() => {
            setRecord(true);
            setOpen(true);
          }}
          data-testid="agent-moves-pill"
          className="pointer-events-auto flex h-8 items-center gap-1.5 rounded-full border border-hair bg-sf px-3 text-[12px] max-md:h-11 max-md:min-w-11 max-md:justify-center font-semibold text-t1 shadow-[0_2px_8px_rgba(0,0,0,0.04)] hover:border-ac"
          title="What moved from this flow into its agents"
        >
          <ArrowRightLeft className="size-3.5 text-ac" />
          {/* On a phone: the icon and the number, left of the toolbar column (nothing else lives there). */}
          <span className="max-md:sr-only">{count ? `Moved into agents · ${count}` : `This flow only · ${moves.length}`}</span>
          <span aria-hidden className="hidden max-md:inline">
            {count || moves.length}
          </span>
        </button>
      </div>
    );
  }

  // The same Publish and Open buttons in the first-open view and in the record the pill opens (a move still pending can be published from either).
  const agentRows = (
    <>
      {agents.map((a) => (
        <div key={a.id} className="space-y-1">
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="primary" disabled={readOnly || publishing[a.id]?.endsWith('…')} onClick={() => void publish(a)}>
              Publish {a.name}
            </Button>
            <a className="inline-flex h-7 items-center rounded-md border border-hair px-2 text-[12px] font-medium text-t1 hover:border-ac" href={`/agents/${a.id}`} target="_blank" rel="noreferrer">
              Open {a.name}
            </a>
          </div>
          {publishing[a.id] && <p className="text-t3">{publishing[a.id]}</p>}
        </div>
      ))}
    </>
  );

  return (
    <aside
      ref={asideRef}
      role="region"
      aria-label="Moved into agents"
      data-testid="agent-moves-notice"
      className="pointer-events-auto absolute right-14 top-3 z-20 flex max-h-[60vh] w-[300px] max-w-[calc(100%-4.5rem)] animate-fade-up flex-col rounded-2xl border border-hair bg-sf/95 shadow-pop backdrop-blur max-md:inset-x-2 max-md:bottom-16 max-md:top-auto max-md:w-auto max-md:max-w-none max-md:max-h-[40vh]"
    >
      <header className="flex items-center gap-2 border-b border-hair px-3 py-2">
        <ArrowRightLeft className="size-3.5 text-ac" />
        <h2 className="text-[13px] font-semibold text-t1">{record ? 'Moved into agents' : 'This flow’s wiring moved into its agents'}</h2>
        <button type="button" onClick={close} className="ml-auto rounded p-1 text-t3 hover:bg-sf2 hover:text-t1" aria-label="Close">
          <X className="size-3.5" />
        </button>
      </header>
      <div className="min-h-0 space-y-3 overflow-y-auto px-3 py-2.5 text-[12px]">
        {record ? (
          <>
            <MoveRecord moves={moves} onRetry={(m) => void again(m, false)} onResolve={(m) => void again(m, true)} />
            {agentRows}
          </>
        ) : (
          <>
            <p className="text-t3">A model or tool wired into a Run an Agent node is now the agent’s: its model, memory, tools and knowledge are the bubbles under the node. What can’t move stays here and runs in this flow only.</p>
            <ul className="space-y-1.5 text-t1">
              {lines.map((line) => (
                <li key={line} className="leading-snug">
                  {line}
                </li>
              ))}
            </ul>
            {agentRows}
            <button type="button" onClick={() => setRecord(true)} className="text-[12px] font-medium text-ac hover:underline">
              Show everything that moved
            </button>
          </>
        )}
      </div>
    </aside>
  );
}
