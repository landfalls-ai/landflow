'use client';
/**
 * "Composite…" on a plain group (docs/composites.md): type it by an existing composite type (its members bind to the
 * slots they obviously fill), or make a new type from it. A new type is proposed from the group (one slot per node
 * type, its outgoing connections as outputs, its sub-node wiring and fail-open nodes as rules); the author names it,
 * loosens slots to optional, locks the core steps, and saves it to this instance's library as `local.<name>`.
 */
import { useMemo, useState } from 'react';
import { Boxes } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { autoBind, compositeIssues, describeMatcher, identifierFrom, proposeComposite, type CompositeTypeDescriptor, type CompositeTypeInfo } from '@/lib/shared/composites';
import { Dialog } from '../agents/dialog';
import { Button } from '../ui/button';
import { NodeIcon } from '../ui/icon';
import { FieldLabel, Input, Switch, Textarea } from '../ui/inputs';
import { checkedGraph, editorLookup, loadComposites } from './composites';
import { useEditor } from './store';

type Tab = 'use' | 'new';

export function CompositeDialog({ groupId, onClose }: { groupId: string; onClose: () => void }) {
  const composites = useEditor((s) => s.composites);
  const nodeTypes = useEditor((s) => s.nodeTypes);
  const [tab, setTab] = useState<Tab>(composites.length ? 'use' : 'new');
  const group = useEditor((s) => s.groups.find((g) => g.id === groupId));
  const lookup = editorLookup(nodeTypes, composites);

  const proposed = useMemo(() => {
    const { nodes, edges, groups } = useEditor.getState();
    return proposeComposite(checkedGraph(nodes, edges, groups), groupId, lookup);
    // Proposed once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId]);
  const [draft, setDraft] = useState<CompositeTypeDescriptor | undefined>(proposed?.descriptor);
  const [saving, setSaving] = useState(false);

  /** Type the group by `info`, binding each member to the slot it obviously fills. */
  const use = (info: CompositeTypeInfo) => {
    const state = useEditor.getState();
    state.updateGroup(groupId, { composite: { type: info.type, version: info.descriptor.version, slots: {} } });
    const after = useEditor.getState();
    let graph = checkedGraph(after.nodes, after.edges, after.groups);
    const members = after.groups.find((g) => g.id === groupId)?.data.nodeIds ?? [];
    const current = editorLookup(after.nodeTypes, after.composites);
    for (const id of members) {
      const bound = autoBind(graph, groupId, id, current);
      if (!bound) continue;
      useEditor.setState((s) => ({ groups: s.groups.map((g) => (g.id === groupId ? { ...g, data: { ...g.data, composite: bound } } : g)) }));
      const s = useEditor.getState();
      graph = checkedGraph(s.nodes, s.edges, s.groups);
    }
    const errors = compositeIssues(graph, current).filter((i) => i.groupId === groupId && i.severity === 'error');
    if (errors.length) toast.warning(`Typed as ${info.descriptor.displayName}: ${errors.length} thing${errors.length === 1 ? '' : 's'} to fix before publishing`, { description: 'Open the frame’s contract to see them' });
    else toast.success(`Typed as ${info.descriptor.displayName}: contract met`);
    onClose();
  };

  const save = async () => {
    if (!draft || !proposed) return;
    setSaving(true);
    try {
      const descriptor = { ...draft, name: identifierFrom(draft.displayName) };
      const { composite } = await api<{ composite: CompositeTypeInfo }>('/api/composites', { method: 'POST', json: { descriptor } });
      useEditor.getState().setComposites([...useEditor.getState().composites.filter((c) => c.type !== composite.type), composite]);
      useEditor.getState().updateGroup(groupId, { composite: { type: composite.type, version: composite.descriptor.version, slots: proposed.slots }, name: draft.displayName });
      loadComposites();
      toast.success(`Saved ${composite.descriptor.displayName} (${composite.type} v${composite.descriptor.version})`, { description: 'It’s in the node creator under Composites' });
      onClose();
    } catch (e) {
      toast.error(`Could not save the type: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const patchSlot = (name: string, patch: { min?: number; locked?: boolean }) =>
    setDraft((d) => d && { ...d, slots: d.slots.map((s) => (s.name === name ? { ...s, ...patch, ...(patch.locked === false && { locked: undefined }) } : s)) });

  return (
    <Dialog
      title="Composite"
      subtitle={group?.data.name}
      icon={<Boxes className="size-5 text-t2" />}
      onClose={onClose}
      width={620}
      footer={
        tab === 'new' ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save} loading={saving} disabled={!draft?.displayName.trim() || !draft.slots.length}>
              Save type and use it
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-4">
        <div role="tablist" className="flex w-fit items-center gap-0.5 rounded-full border border-hair bg-sf2 p-0.5">
          {(['use', 'new'] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn('h-7 rounded-full px-3.5 text-[13px] text-t2 transition-all hover:text-t1', tab === t && 'bg-sf font-semibold text-t1 shadow-[0_1px_3px_rgba(0,0,0,0.08),0_0_0_1px_var(--hair)]')}
            >
              {t === 'use' ? 'Use a type' : 'New type from this group'}
            </button>
          ))}
        </div>

        {tab === 'use' && (
          <div className="flex flex-col gap-2">
            <p className="text-[12.5px] text-t2">The group keeps its nodes; each joins the slot it obviously fills, and the frame is checked against the type’s contract from then on.</p>
            {composites.map((info) => (
              <button key={info.type} onClick={() => use(info)} className="flex items-start gap-3 rounded-[12px] border border-hair px-3 py-2.5 text-left transition-colors hover:border-ac">
                <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-[9px] border border-hair" style={info.descriptor.color ? { color: info.descriptor.color } : undefined}>
                  <NodeIcon icon={info.descriptor.icon ?? 'lucide:boxes'} size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-semibold text-t1">{info.descriptor.displayName}</span>
                    <span className="font-mono text-[10.5px] text-t3">
                      {info.type} v{info.descriptor.version}
                    </span>
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-[12px] text-t2">{info.descriptor.description}</span>
                  <span className="mt-1 block text-[11.5px] text-t3">Slots: {info.descriptor.slots.map((s) => s.displayName).join(', ')}</span>
                </span>
              </button>
            ))}
            {!composites.length && <p className="text-[12.5px] text-t3">No composite types yet. Make one from this group.</p>}
          </div>
        )}

        {tab === 'new' && draft && (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-[1fr_auto] items-end gap-3">
              <label className="flex flex-col gap-1">
                <FieldLabel>Name</FieldLabel>
                <Input value={draft.displayName} maxLength={80} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} />
              </label>
              <span className="pb-2 font-mono text-[11px] text-t3">local.{identifierFrom(draft.displayName || 'composite')}</span>
            </div>
            <label className="flex flex-col gap-1">
              <FieldLabel>Description</FieldLabel>
              <Textarea rows={2} value={draft.description} maxLength={500} placeholder="What a frame of this type does, and what it guarantees" onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </label>
            <div className="flex flex-col gap-1.5">
              <FieldLabel>Slots</FieldLabel>
              <p className="text-[11.5px] text-t3">One per node type in the group, taking exactly that type (a model or tool slot takes any). Make the steps a frame can do without optional; lock the ones it can’t lose.</p>
              {draft.slots.map((slot) => (
                <div key={slot.name} className="flex items-center gap-3 rounded-[10px] border border-hair px-2.5 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-t1">{slot.displayName}</span>
                    <span className="block truncate text-[11.5px] text-t3">Takes {describeMatcher(slot.accepts, lookup)}</span>
                  </span>
                  <span className="flex items-center gap-1.5 text-[11.5px] text-t2">
                    Optional <Switch checked={slot.min === 0} onChange={(v) => patchSlot(slot.name, { min: v ? 0 : Math.max(1, (proposed?.slots[slot.name] ?? []).length) })} />
                  </span>
                  <span className="flex items-center gap-1.5 text-[11.5px] text-t2">
                    Locked <Switch checked={Boolean(slot.locked)} onChange={(v) => patchSlot(slot.name, { locked: v })} />
                  </span>
                </div>
              ))}
            </div>
            {(draft.outputs?.length ?? 0) > 0 && (
              <p className="text-[12px] text-t2">
                Outputs: {draft.outputs!.map((p) => p.displayName ?? p.name).join(', ')}. Rules: {draft.rules?.length ? draft.rules.map((r) => r.rule).join(', ') : 'none'}.
              </p>
            )}
            <label className="flex items-center gap-2 text-[12.5px] text-t2">
              <Switch checked={Boolean(draft.closed)} onChange={(v) => setDraft({ ...draft, closed: v || undefined })} /> Closed: nodes outside its slots are errors
            </label>
          </div>
        )}
        {tab === 'new' && !draft && <p className="text-[12.5px] text-t3">This group has no nodes to make a type from.</p>}
      </div>
    </Dialog>
  );
}
