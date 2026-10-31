'use client';
/**
 * A canvas group in the editor: a labelled frame behind its nodes. Drag it by its header (its nodes come along),
 * resize it from its edges and corners, double-click the label to rename it. When selected, a toolbar offers the
 * colours, collapse, duplicate and ungroup. Collapsed, it is a compact box whose edges carry its nodes' connections
 * (see ./groups.ts canvasGraph); double-click the box to expand it again. Groups nest: the count and the box's icons
 * cover the nodes of the groups inside too.
 *
 * A composite frame (docs/composites.md) shows its type in the header with how its contract stands; the badge opens
 * the contract (./composite-panel.tsx). Empty required slots are drawn as placeholders that open the node creator on
 * what the slot accepts, and a collapsed composite draws its named outputs. "Composite…" types a plain group.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Handle, NodeResizer, NodeToolbar, Position, type EdgeProps, type NodeProps } from '@xyflow/react';
import { Boxes, Check, ChevronsDownUp, ChevronsUpDown, Copy, PencilLine, Plus, Ungroup } from 'lucide-react';
import { cn } from '@/lib/utils';
import { nodeColor } from '@/lib/client/node-style';
import { useShallow } from 'zustand/react/shallow';
import { GROUP_MIN_SIZE, GROUP_NAME_MAX, compositePortHandle, descendantNodeIds } from '@/lib/shared/groups';
import { describeMatcher } from '@/lib/shared/composites';
import { EdgeLine } from '../canvas/edge-line';
import { edgePath, useLane } from '../canvas/edge-path';
import { CompositeBadge, GroupBoxView, GroupFrameView } from '../canvas/group-frame';
import { CompositeDialog } from './composite-dialog';
import { CompositePanel, slotPosition } from './composite-panel';
import { editorLookup, issueCounts, useCompositeReport } from './composites';
import { STICKY_COLORS, stickyColors } from '../canvas/sticky-note';
import { GROUP_HANDLES, linksOf, type GroupProxyEdge } from './groups';
import { useEditor, type GroupFlowNode } from './store';

const toolbarButton = 'grid size-6 place-items-center rounded-full text-t2 transition-colors hover:bg-acdim hover:text-t1';
const hiddenHandle = '!size-2 !min-h-0 !min-w-0 !border-0 !bg-transparent opacity-0';

export const GroupNodeView = memo(function GroupNodeView({ id, data, selected }: NodeProps<GroupFlowNode>) {
  const [renaming, setRenaming] = useState(false);
  const [contract, setContract] = useState(false);
  const [typing, setTyping] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const { updateGroup, ungroup, duplicateNode, openPalette } = useEditor.getState();
  const nodes = useEditor((s) => s.nodes);
  const nodeTypes = useEditor((s) => s.nodeTypes);
  const composites = useEditor((s) => s.composites);
  const report = useCompositeReport(id);
  const descriptor = report?.descriptor ?? composites.find((c) => c.type === data.composite?.type)?.descriptor;
  const { errors, warnings } = issueCounts(report);
  // Every node inside, nested groups' included.
  const inside = useEditor(useShallow((s) => descendantNodeIds(linksOf(s.groups), id)));
  const icons = useMemo(
    () =>
      data.collapsed
        ? inside.flatMap((nodeId) => {
            const node = nodes.find((n) => n.id === nodeId);
            const info = node && nodeTypes[node.data.wf.type];
            return node ? [{ icon: info?.descriptor.icon, color: nodeColor(info) }] : [];
          })
        : [],
    [data.collapsed, inside, nodes, nodeTypes],
  );

  useEffect(() => {
    if (!renaming) return;
    input.current?.focus();
    input.current?.select();
  }, [renaming]);
  useEffect(() => {
    if (!selected) setRenaming(false);
  }, [selected]);

  const label = renaming ? (
    <input
      ref={input}
      value={data.name}
      maxLength={GROUP_NAME_MAX}
      aria-label="Group name"
      spellCheck={false}
      onChange={(e) => updateGroup(id, { name: e.target.value })}
      onBlur={() => {
        setRenaming(false);
        if (!data.name.trim()) updateGroup(id, { name: 'Group' });
      }}
      onKeyDown={(e) => {
        // Keep editor shortcuts out of the field; Enter or Escape finishes.
        e.stopPropagation();
        if (e.key === 'Enter' || e.key === 'Escape') input.current?.blur();
      }}
      className="nodrag nopan min-w-0 flex-1 rounded-md bg-sf px-1.5 py-0.5 text-[13px] font-semibold text-t1 outline-none ring-1 ring-acbd"
    />
  ) : undefined;
  const toggle = (collapsed: boolean) => updateGroup(id, { collapsed });
  const lookup = editorLookup(nodeTypes, composites);

  const badge = data.composite ? (
    <CompositeBadge
      icon={descriptor?.icon}
      label={`${descriptor?.displayName ?? data.composite.type} v${data.composite.version}`}
      tone={errors ? 'error' : warnings || !report?.descriptor ? 'warning' : 'ok'}
      title={errors ? `${errors} to fix before publishing` : warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : report?.descriptor ? 'Contract met' : 'Its contract isn’t available here'}
      onClick={() => setContract((open) => !open)}
    >
      {errors ? (
        <span className="rounded-full bg-rddim px-1.5 font-mono text-[10.5px] leading-4 text-rd">{errors}</span>
      ) : warnings ? (
        <span className="rounded-full bg-warndim px-1.5 font-mono text-[10.5px] leading-4 text-warn">{warnings}</span>
      ) : report?.descriptor ? (
        <Check className="size-3 text-gn" />
      ) : null}
    </CompositeBadge>
  ) : undefined;
  // Required slots nothing fills yet: placeholders along the bottom of the frame.
  const empty = report?.slots.filter((slot) => slot.filled.length < slot.min && !slot.composite) ?? [];
  const placeholders = empty.length ? (
    <div className="pointer-events-auto absolute bottom-3 left-3 flex flex-wrap gap-2">
      {empty.map((slot, i) => (
        <button
          key={slot.name}
          onClick={(e) => (e.stopPropagation(), openPalette({ slot: { groupId: id, slot: slot.name }, position: slotPosition(id, i) }))}
          title={slot.description}
          className="nodrag flex h-[58px] w-[180px] flex-col items-start justify-center gap-0.5 rounded-[14px] border-[1.5px] border-dashed border-rdbd bg-sf/70 px-3 text-left transition-colors hover:border-ac"
        >
          <span className="flex items-center gap-1 text-[12px] font-semibold text-t1">
            <Plus className="size-3" /> {slot.displayName}
          </span>
          <span className="line-clamp-1 text-[11px] text-t3">{describeMatcher(slot.accepts, lookup)}</span>
        </button>
      ))}
    </div>
  ) : undefined;
  const outputs = data.collapsed ? (report?.outputs ?? []) : [];

  return (
    <>
      {!data.collapsed && (
        <NodeResizer
          isVisible={selected}
          minWidth={GROUP_MIN_SIZE.width}
          minHeight={GROUP_MIN_SIZE.height}
          lineClassName="!border-transparent"
          lineStyle={{ pointerEvents: 'all' }}
          handleStyle={{ pointerEvents: 'all' }}
          handleClassName="!size-2.5 !rounded-[3px] !border-[1.5px] !border-t3 !bg-sf"
        />
      )}
      <NodeToolbar isVisible={selected && !renaming} position={Position.Top} offset={10}>
        <div className="flex animate-in items-center gap-1 rounded-full border border-hair bg-sf p-1 shadow-pop">
          {STICKY_COLORS.map((c, index) => (
            <button
              key={c.name}
              title={c.name}
              aria-label={`${c.name} group`}
              aria-pressed={data.color === index}
              onClick={(e) => {
                e.stopPropagation();
                updateGroup(id, { color: index });
              }}
              className={cn(
                'size-[18px] rounded-full border transition-transform hover:scale-110',
                data.color === index ? 'border-t1 shadow-[0_0_0_2px_var(--sf),0_0_0_3px_var(--t1)]' : 'border-hair',
              )}
              style={{ background: stickyColors(index).swatch }}
            />
          ))}
          <span className="mx-0.5 h-4 w-px bg-hair" />
          <button title="Rename (double-click)" aria-label="Rename group" onClick={(e) => (e.stopPropagation(), setRenaming(true))} className={toolbarButton}>
            <PencilLine className="size-3.5" />
          </button>
          <button
            title={data.collapsed ? 'Expand' : 'Collapse'}
            aria-label={data.collapsed ? 'Expand group' : 'Collapse group'}
            onClick={(e) => (e.stopPropagation(), toggle(!data.collapsed))}
            className={toolbarButton}
          >
            {data.collapsed ? <ChevronsUpDown className="size-3.5" /> : <ChevronsDownUp className="size-3.5" />}
          </button>
          <button
            title={data.composite ? 'Contract' : 'Composite: type this group by a contract, or make a new type from it'}
            aria-label={data.composite ? 'Open the contract' : 'Make composite'}
            onClick={(e) => (e.stopPropagation(), data.composite ? setContract(true) : setTyping(true))}
            className={toolbarButton}
          >
            <Boxes className="size-3.5" />
          </button>
          <button title="Duplicate group and its nodes" aria-label="Duplicate group" onClick={(e) => (e.stopPropagation(), duplicateNode(id))} className={toolbarButton}>
            <Copy className="size-3.5" />
          </button>
          <button title="Ungroup (⇧⌘G)" aria-label="Ungroup" onClick={(e) => (e.stopPropagation(), ungroup([id]))} className={toolbarButton}>
            <Ungroup className="size-3.5" />
          </button>
        </div>
      </NodeToolbar>
      {report && (
        // A toolbar sits one above its node: for a frame (far behind) that is under the nodes and frames next to it.
        <NodeToolbar isVisible={contract} position={Position.Right} offset={14} align="start" style={{ zIndex: 1000 }}>
          <CompositePanel groupId={id} report={report} onClose={() => setContract(false)} />
        </NodeToolbar>
      )}
      {typing && <CompositeDialog groupId={id} onClose={() => setTyping(false)} />}
      {data.collapsed ? (
        <GroupBoxView
          name={data.name}
          color={data.color}
          count={inside.length}
          icons={icons}
          selected={selected}
          label={label}
          className="lf-frame-handle cursor-grab active:cursor-grabbing"
          onDoubleClick={() => toggle(false)}
          actions={
            <button title="Expand" aria-label="Expand group" onClick={(e) => (e.stopPropagation(), toggle(false))} className={cn(toolbarButton, 'nodrag size-5')}>
              <ChevronsUpDown className="size-3.5" />
            </button>
          }
        >
          <Handle type="target" position={Position.Left} id={GROUP_HANDLES.in} isConnectable={false} className={hiddenHandle} />
          <Handle type="source" position={Position.Right} id={GROUP_HANDLES.out} isConnectable={false} className={hiddenHandle} />
          <Handle type="source" position={Position.Top} id={GROUP_HANDLES.aiOut} isConnectable={false} className={hiddenHandle} />
          <Handle type="target" position={Position.Bottom} id={GROUP_HANDLES.aiIn} isConnectable={false} className={hiddenHandle} />
          {/* A composite's named outputs: the connections leaving through each are drawn from it. */}
          {outputs.map((port, i) => {
            const top = `${((i + 1) / (outputs.length + 1)) * 100}%`;
            return (
              <span key={port.name}>
                <Handle type="source" position={Position.Right} id={compositePortHandle(port.name)} isConnectable={false} style={{ top }} className="!size-2 !min-h-0 !min-w-0 !border-[1.5px] !border-t3 !bg-sf" />
                <span className="pointer-events-none absolute left-full ml-2.5 -translate-y-1/2 whitespace-nowrap font-mono text-[10px] text-t3" style={{ top }}>
                  {port.displayName}
                </span>
              </span>
            );
          })}
        </GroupBoxView>
      ) : (
        <GroupFrameView
          name={data.name}
          color={data.color}
          count={inside.length}
          selected={selected}
          label={label}
          headerClassName="lf-frame-handle cursor-grab active:cursor-grabbing"
          onHeaderDoubleClick={() => setRenaming(true)}
          badge={badge}
          actions={
            <button title="Collapse" aria-label="Collapse group" onClick={(e) => (e.stopPropagation(), toggle(true))} className={cn(toolbarButton, 'nodrag')}>
              <ChevronsDownUp className="size-3.5" />
            </button>
          }
        >
          {placeholders}
        </GroupFrameView>
      )}
    </>
  );
});

/** A connection to or from a collapsed group: dashed for sub-node ports, labelled when it stands for several. */
export const GroupProxyEdgeView = memo(function GroupProxyEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<GroupProxyEdge>) {
  const isAi = data?.connectionType !== 'main';
  const ends = { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition };
  const [path, labelX, labelY] = edgePath(ends, isAi, useLane(ends, isAi));
  const count = data?.count ?? 1;
  return (
    <EdgeLine
      id={id}
      path={path}
      labelX={labelX}
      labelY={labelY}
      isAi={isAi}
      overlay={
        count > 1 ? (
          <div className="pointer-events-none rounded-full border border-hair bg-sf px-2 font-mono text-[10px] leading-[18px] text-t2">{count} connections</div>
        ) : undefined
      }
    />
  );
});
