'use client';
/**
 * The second brain's side card on the canvas: "N suggestions" for the open workflow, collapsed to a pill so the canvas
 * stays in view. Ops suggestions are applied here in the editor (undo, then save), like a Spotlight change.
 */
import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, Sparkles } from 'lucide-react';
import { api } from '@/lib/client/api';
import type { Proposal, WorkflowKnowledge } from '@/lib/shared/brain';
import { applyChanges } from '../editor/assistant';
import { useEditor } from '../editor/store';
import { ProposalCard, useProposalActions } from './proposal-card';

/** Select the node a suggestion is about, if the canvas has it. */
function focusNode(p: Proposal) {
  const { nodeId, nodeName } = p.target;
  useEditor.setState((s) => ({ nodes: s.nodes.map((n) => ({ ...n, selected: n.id === nodeId || (!!nodeName && n.data.wf.name === nodeName) })) }));
}

export function BrainCanvasCard() {
  const workflowId = useEditor((s) => s.workflowId);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    setProposals([]);
    if (workflowId)
      api<WorkflowKnowledge>(`/api/brain/workflows/${encodeURIComponent(workflowId)}`)
        .then((r) => live && setProposals(r.proposals))
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [workflowId]);

  const remove = useCallback((id: string) => setProposals((list) => list.filter((p) => p.id !== id)), []);
  const actions = useProposalActions({
    onDone: remove,
    localApply: (p) => applyChanges([{ ops: p.ops, kind: 'proposal' }], p.title),
  });
  if (!proposals.length) return null;

  return (
    <div className="pointer-events-auto absolute left-3 top-16 z-20 w-[320px] max-w-[calc(100%-5rem)]">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex h-8 items-center gap-1.5 rounded-full border border-hair bg-sf px-3 text-[12px] font-semibold text-t1 shadow-[0_2px_8px_rgba(0,0,0,0.04)] hover:border-ac"
      >
        <Sparkles className="size-3.5 text-viz-7" />
        {proposals.length} suggestion{proposals.length === 1 ? '' : 's'}
        <ChevronDown className={open ? 'size-3.5 rotate-180 text-t3' : 'size-3.5 text-t3'} />
      </button>
      {open && (
        <div className="mt-2 max-h-[55vh] animate-fade-up space-y-2 overflow-y-auto rounded-2xl border border-hair bg-sf/95 p-2 shadow-pop backdrop-blur">
          {proposals.map((p) => (
            <ProposalCard key={p.id} proposal={p} actions={actions} compact onFocus={p.target.nodeId || p.target.nodeName ? () => focusNode(p) : undefined} />
          ))}
        </div>
      )}
    </div>
  );
}
