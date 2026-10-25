'use client';
/**
 * How a connection looks, shared by the editor and the read-only execution
 * view: grey until data passes, green with an item count once it has, and
 * dots travelling along it while items are flowing.
 */
import type { ReactNode } from 'react';
import { BaseEdge, EdgeLabelRenderer } from '@xyflow/react';

export interface EdgeLineProps {
  id: string;
  path: string;
  labelX: number;
  labelY: number;
  /** Sub-node connection (model, memory, tool): dashed. */
  isAi?: boolean;
  count?: number;
  /** Items are passing right now. */
  flowing?: boolean;
  highlighted?: boolean;
  /** Colour of the travelling dots (the source node's). */
  color?: string;
  /** Room for a label in the middle. */
  roomy?: boolean;
  /** Replaces the count label (e.g. hover actions). */
  overlay?: ReactNode;
  onHover?: (hover: boolean) => void;
}

export function EdgeLine({ id, path, labelX, labelY, isAi, count, flowing, highlighted, color = 'var(--ac)', roomy = true, overlay, onHover }: EdgeLineProps) {
  const carried = count !== undefined && count > 0;
  const stroke = highlighted ? 'var(--ac)' : carried ? (isAi ? 'var(--viz-7)' : 'var(--gn)') : isAi ? 'var(--t3)' : 'var(--bd)';
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke,
          strokeWidth: highlighted || carried ? 2 : 1.5,
          strokeDasharray: isAi ? '5 4' : undefined,
          transition: 'stroke 0.3s, stroke-width 0.3s',
        }}
      />
      {flowing && (
        <g className="pointer-events-none">
          {[0, 1, 2].map((i) => (
            <circle key={i} r={isAi ? 2.5 : 3.5} fill={color} opacity={0.9}>
              <animateMotion dur="0.9s" begin={`${i * 0.3}s`} repeatCount="indefinite" path={path} />
            </circle>
          ))}
        </g>
      )}
      {onHover && <path d={path} fill="none" stroke="transparent" strokeWidth={20} onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)} />}
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan pointer-events-auto absolute"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          onMouseEnter={() => onHover?.(true)}
          onMouseLeave={() => onHover?.(false)}
        >
          {overlay ??
            (roomy && carried && (
              <div
                className={`animate-pop rounded-full border px-2 font-mono text-[10px] leading-[18px] ${isAi ? 'border-acbd bg-sf text-viz-7' : 'border-gnbd bg-sf text-gn'}`}
              >
                {isAi ? `${count} call${count === 1 ? '' : 's'}` : `${count} item${count === 1 ? '' : 's'}`}
              </div>
            ))}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
