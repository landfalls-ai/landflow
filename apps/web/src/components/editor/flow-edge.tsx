'use client';
import { memo, useEffect, useState } from 'react';
import type { EdgeProps } from '@xyflow/react';
import { Plus, Trash2 } from 'lucide-react';
import { nodeColor } from '@/lib/client/node-style';
import { EdgeLine } from '../canvas/edge-line';
import { edgePath, useLane } from '../canvas/edge-path';
import { useEditor, type FlowEdge } from './store';

const FLOW_WINDOW_MS = 1400;

export const FlowEdgeView = memo(function FlowEdgeView(props: EdgeProps<FlowEdge>) {
  const { id, source, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected } = props;
  const isAi = data?.connectionType !== 'main';
  const count = useEditor((s) => s.edgeCounts[id]);
  const flowingAt = useEditor((s) => s.flowing[id]);
  const sourceRunning = useEditor((s) => s.statuses[source]?.state === 'running');
  const color = useEditor((s) => nodeColor(s.nodeTypes[s.nodes.find((n) => n.id === source)?.data.wf.type ?? '']));
  const [hover, setHover] = useState(false);
  const [, force] = useState(0);

  // Data that just passed animates the edge for a moment.
  const flowing = (flowingAt !== undefined && Date.now() - flowingAt < FLOW_WINDOW_MS) || (isAi && sourceRunning);
  useEffect(() => {
    if (!flowingAt) return;
    const timer = setTimeout(() => force((n) => n + 1), FLOW_WINDOW_MS + 50);
    return () => clearTimeout(timer);
  }, [flowingAt]);

  const ends = { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition };
  const [path, labelX, labelY] = edgePath(ends, isAi, useLane(ends, isAi));
  const roomy = Math.hypot(targetX - sourceX, targetY - sourceY) > 120;

  const insert = () => {
    const edge = useEditor.getState().edges.find((e) => e.id === id);
    if (!edge) return;
    useEditor.getState().openPalette({ from: { nodeId: edge.source, handleId: edge.sourceHandle ?? 'main:0', handleType: 'source' }, insertInto: id, position: { x: labelX - 44, y: labelY - 44 } });
  };

  return (
    <EdgeLine
      id={id}
      path={path}
      labelX={labelX}
      labelY={labelY}
      isAi={isAi}
      count={count}
      flowing={flowing}
      highlighted={selected || hover}
      color={color}
      roomy={roomy}
      onHover={setHover}
      overlay={
        hover || selected ? (
          <div className="flex animate-pop items-center gap-0.5 rounded-full border border-hair bg-sf p-0.5 shadow-pop">
            {!isAi && (
              <button title="Insert a node here" onClick={insert} className="grid size-6 place-items-center rounded-full text-t2 hover:bg-acdim hover:text-t1">
                <Plus className="size-3.5" />
              </button>
            )}
            <button title="Delete connection" onClick={() => useEditor.getState().onEdgesChange([{ type: 'remove', id }])} className="grid size-6 place-items-center rounded-full text-t2 hover:bg-rddim hover:text-rd">
              <Trash2 className="size-3.5" />
            </button>
          </div>
        ) : undefined
      }
    />
  );
});
