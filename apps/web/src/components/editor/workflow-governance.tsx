'use client';
/**
 * Workflow settings → Governance (GET/PUT /api/workflows/<id>/policy): four-eyes publishing for this workflow even when
 * the instance doesn't ask for it, and a node allow-list stricter than its project's and the instance's. Admins of the
 * workflow's project change it; everyone else sees what applies. The dialog's Save saves it first (then the workflow,
 * so the save's warnings already follow the new list) and the node picker reloads.
 */
import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import type { WorkflowPolicy, WorkflowPolicyView } from '@/lib/shared/project-policy';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { ToggleRow } from '../agents/dialog';
import { ScopedNodeList, type NodeCatalog } from '../governance/scoped-node-list';
import { useEditor } from './store';

export interface WorkflowGovernance {
  view?: WorkflowPolicyView;
  draft?: WorkflowPolicy;
  setDraft: (next: WorkflowPolicy) => void;
  dirty: boolean;
  catalog?: NodeCatalog;
  /** Saves a changed policy; false when the server refused it (the error is shown). */
  save: () => Promise<boolean>;
}

export function useWorkflowGovernance(workflowId: string): WorkflowGovernance {
  const [view, setView] = useState<WorkflowPolicyView>();
  const [draft, setDraft] = useState<WorkflowPolicy>();
  const [catalog, setCatalog] = useState<NodeCatalog>();
  useEffect(() => {
    if (!workflowId) return;
    api<WorkflowPolicyView>(`/api/workflows/${encodeURIComponent(workflowId)}/policy`)
      .then((next) => {
        setView(next);
        setDraft(next.policy);
      })
      .catch(() => {});
    // Every node type of the instance (not only the ones allowed here), to pick from.
    api<{ nodeTypes: NodeTypeInfo[] }>('/api/node-types')
      .then(({ nodeTypes }) =>
        setCatalog({
          plugins: [...new Map(nodeTypes.map((t) => [t.pluginId, { id: t.pluginId, name: t.pluginName ?? t.pluginId }])).values()],
          nodeTypes: nodeTypes.map((t) => ({ type: t.type, displayName: t.descriptor.displayName, pluginId: t.pluginId })),
        }),
      )
      .catch(() => {});
  }, [workflowId]);
  const strip = (p?: WorkflowPolicy) => p && { fourEyes: p.fourEyes, nodes: p.nodes };
  const dirty = Boolean(view && draft && JSON.stringify(strip(draft)) !== JSON.stringify(strip(view.policy)));
  const save = useCallback(async () => {
    if (!dirty || !draft) return true;
    try {
      const next = await api<WorkflowPolicyView>(`/api/workflows/${encodeURIComponent(workflowId)}/policy`, { method: 'PUT', json: { fourEyes: draft.fourEyes, nodes: draft.nodes } });
      setView(next);
      setDraft(next.policy);
      const { nodeTypes } = await api<{ nodeTypes: NodeTypeInfo[] }>(`/api/node-types?workflowId=${encodeURIComponent(workflowId)}`);
      useEditor.getState().setNodeTypes(nodeTypes);
      return true;
    } catch (e) {
      toast.error(`The governance settings weren’t saved: ${(e as Error).message}`);
      return false;
    }
  }, [dirty, draft, workflowId]);
  return { view, draft, setDraft, dirty, catalog, save };
}

export function WorkflowGovernanceSection({ state }: { state: WorkflowGovernance }) {
  const { view, draft, setDraft, catalog } = state;
  if (!view || !draft) return null;
  const editable = view.canEdit;
  const project = view.project;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-[12px] font-semibold text-t2">
        <ShieldCheck className="size-3.5" /> Governance
      </div>
      <ToggleRow
        title="Four-eyes publishing"
        description={
          view.instanceFourEyes
            ? 'On for the whole instance already: publishing this workflow needs someone else’s approval.'
            : 'Publishing (and rolling back) this workflow needs someone else’s approval, even though the instance doesn’t ask for it.'
        }
        checked={view.instanceFourEyes || draft.fourEyes}
        disabled={!editable || view.instanceFourEyes}
        onChange={(fourEyes) => setDraft({ ...draft, fourEyes })}
      />
      <div className="rounded-[10px] border border-hair px-3 py-2.5">
        <div className="mb-2 text-[13px] text-t1">Allowed nodes</div>
        <ScopedNodeList value={draft.nodes} onChange={(nodes) => setDraft({ ...draft, nodes })} catalog={catalog} disabled={!editable} offLabel="As the project and instance allow" allowLabel="Only these" />
        <p className="mt-2 text-[12px] leading-snug text-t3">
          {project?.nodes.mode === 'allow'
            ? `The “${project.name}” project allows only ${[...project.nodes.types, ...project.nodes.plugins.map((p) => `the ${p} plugin`)].join(', ') || 'nothing'}; this list narrows it further.`
            : 'Narrows what the instance (Settings → Governance) and the project allow.'}{' '}
          Nodes not on it are hidden from the node picker, flagged when saving, refused at publish and fail when a run reaches them.
        </p>
      </div>
      {!editable && <p className="text-[12px] text-t3">Admins of the workflow’s project change these.</p>}
    </div>
  );
}
