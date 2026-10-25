'use client';
import { memo } from 'react';
import { NodeToolbar, Position, type NodeProps } from '@xyflow/react';
import { useShallow } from 'zustand/react/shallow';
import { CircleDot, Copy, Play, Power, Settings2, SkipForward, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { isCompact, NodeTile } from '../canvas/node-tile';
import { useEditor, type FlowNode } from './store';

function ToolbarButton({
  onClick,
  title,
  children,
  danger,
  active,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  danger?: boolean;
  active?: boolean;
}) {
  return (
    <button
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        'grid size-7 place-items-center rounded-full text-t2 transition-colors hover:bg-acdim hover:text-t1',
        danger && 'hover:bg-rddim hover:text-rd',
        active && 'text-rd',
      )}
    >
      {children}
    </button>
  );
}

export const FlowNodeView = memo(function FlowNodeView({ id, data, selected }: NodeProps<FlowNode>) {
  const { wf } = data;
  const info = useEditor((s) => s.nodeTypes[wf.type]);
  const status = useEditor((s) => s.statuses[id]);
  const breakpoint = useEditor((s) => s.breakpoints.includes(id));
  const pinned = useEditor((s) => Boolean(s.pinData[id]));
  const running = useEditor((s) => s.running);
  const fresh = useEditor((s) => s.lastAddedId === id);
  const asTool = useEditor((s) => s.edges.some((e) => e.source === id && e.data?.connectionType === 'ai_tool'));
  const connectedOutputs = useEditor(
    useShallow((s) => s.edges.filter((e) => e.source === id && e.data?.connectionType === 'main').map((e) => e.sourceHandle ?? 'main:0')),
  );
  const subConnections = useEditor(useShallow((s) => s.edges.filter((e) => e.target === id && e.data?.connectionType !== 'main').map((e) => e.targetHandle)));
  const { openNode, openPalette, removeNodes, duplicateNode, updateNode, toggleBreakpoint } = useEditor.getState();

  const compact = isCompact(info?.descriptor, wf.parameters, asTool);
  const runNode = (scope: 'from' | 'only') => useEditor.getState().run?.({ kind: 'node', nodeId: id, scope });

  return (
    <NodeTile
      name={wf.name}
      info={info}
      parameters={wf.parameters}
      status={status}
      disabled={wf.disabled}
      selected={selected}
      breakpoint={breakpoint}
      pinned={pinned}
      asTool={asTool}
      connectedOutputs={connectedOutputs}
      subConnections={subConnections}
      onAddFromOutput={(handle) => openPalette({ from: { nodeId: id, handleId: handle, handleType: 'source' } })}
      onAddSubnode={(handle, type) => openPalette({ connectionType: type, from: { nodeId: id, handleId: handle, handleType: 'target' } })}
      onToggleBreakpoint={() => toggleBreakpoint(id)}
      fresh={fresh}
    >
      <NodeToolbar isVisible={selected} position={Position.Top} offset={compact ? 12 : 14}>
        <div className="flex animate-in items-center gap-0.5 rounded-full border border-hair bg-sf p-0.5 shadow-pop">
          <ToolbarButton title="Open (double-click)" onClick={() => openNode(id)}>
            <Settings2 className="size-3.5" />
          </ToolbarButton>
          {!compact && (
            <>
              <ToolbarButton title="Run this node (and what it needs)" onClick={() => !running && runNode('only')}>
                <Play className="size-3.5" />
              </ToolbarButton>
              <ToolbarButton title="Run from this node" onClick={() => !running && runNode('from')}>
                <SkipForward className="size-3.5" />
              </ToolbarButton>
              <ToolbarButton title={breakpoint ? 'Remove breakpoint (F9)' : 'Add breakpoint (F9)'} active={breakpoint} onClick={() => toggleBreakpoint(id)}>
                <CircleDot className="size-3.5" />
              </ToolbarButton>
            </>
          )}
          <span className="mx-0.5 h-4 w-px bg-hair" />
          <ToolbarButton title={wf.disabled ? 'Enable' : 'Disable'} onClick={() => updateNode(id, { disabled: !wf.disabled })}>
            <Power className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton title="Duplicate (⌘D)" onClick={() => duplicateNode(id)}>
            <Copy className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton title="Delete" danger onClick={() => removeNodes([id])}>
            <Trash2 className="size-3.5" />
          </ToolbarButton>
        </div>
      </NodeToolbar>
    </NodeTile>
  );
});
