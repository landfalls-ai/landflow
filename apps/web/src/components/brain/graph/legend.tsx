/**
 * The graph's legend: what each edge colour and node shape means. Written for Landflow after Supermemory's legend (see
 * ./NOTICE.md); the labels come from `GRAPH_EDGE_LABELS`, colours are the app's tokens.
 */
import { GRAPH_EDGE_LABELS, type GraphEdgeType } from '@/lib/shared/brain-graph';

const EDGE_COLOUR: Record<GraphEdgeType, string> = { about: 'var(--t3)', updates: 'var(--viz-1)', extends: 'var(--viz-3)', derives: 'var(--viz-5)' };
const EDGE_HINT: Record<GraphEdgeType, string> = {
  about: 'A fact and what it is about',
  updates: 'A new version of the same fact',
  extends: 'A fact that builds on another',
  derives: 'A fact worked out from another',
};

export function Legend({ history }: { history: boolean }) {
  const edges: GraphEdgeType[] = history ? ['about', 'updates', 'extends', 'derives'] : ['about'];
  return (
    <div role="group" aria-label="Legend" className="pointer-events-auto rounded-xl border border-hair bg-sf/95 px-3 py-2 text-[12px] text-t2 shadow-sm">
      <ul className="flex flex-col gap-1">
        <li className="flex items-center gap-2">
          <span aria-hidden className="size-3 rounded-[3px] bg-ac" />
          Subject (workflow, agent or page)
        </li>
        <li className="flex items-center gap-2">
          <span aria-hidden className="size-2.5 rounded-full bg-t2" />
          Fact
        </li>
        <li className="flex items-center gap-2">
          <span aria-hidden className="size-2.5 rounded-full border-[1.5px] border-t2" />
          Stale fact
        </li>
        {edges.map((type) => (
          <li key={type} className="flex items-center gap-2" title={EDGE_HINT[type]}>
            <span aria-hidden className="h-0.5 w-3" style={{ backgroundColor: EDGE_COLOUR[type] }} />
            {GRAPH_EDGE_LABELS[type]}
          </li>
        ))}
      </ul>
    </div>
  );
}
