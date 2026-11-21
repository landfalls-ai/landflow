/**
 * The Graph tab on a phone (FR-9): a force graph does not read at 390 px, so the same data is a list grouped by subject, a
 * fact under its subject and each later version indented under the one it replaced. New for Landflow.
 */
import { stamp } from '@/lib/client/format';
import { GRAPH_EDGE_LABELS, type GraphFactNode, type GraphSubjectNode } from '@/lib/shared/brain-graph';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import type { GraphData } from './merge';

export interface ListGroup {
  subject: GraphSubjectNode;
  facts: Array<{ node: GraphFactNode; depth: number }>;
}

/** Subjects with their facts: a chain oldest first, each version one step in from its parent (a parent not loaded starts at 0). */
export function groupBySubject(data: GraphData): ListGroup[] {
  const subjects = new Map(data.nodes.flatMap((n) => (n.kind === 'subject' ? [[n.id, n] as const] : [])));
  const facts = new Map(data.nodes.flatMap((n) => (n.kind === 'fact' ? [[n.factId, n] as const] : [])));
  const subjectOf = new Map(data.edges.filter((e) => e.type === 'about').map((e) => [e.from, e.to]));
  const groups = new Map<string, ListGroup>();
  for (const s of subjects.values()) groups.set(s.id, { subject: s, facts: [] });
  const depthOf = (f: GraphFactNode): number => {
    let depth = 0;
    const seen = new Set<string>();
    for (let cur: GraphFactNode | undefined = f; cur?.parentId && facts.has(cur.parentId) && !seen.has(cur.factId); cur = facts.get(cur.parentId)) {
      seen.add(cur.factId);
      depth++;
    }
    return depth;
  };
  const ordered = [...facts.values()].sort((a, b) => (a.chainId === b.chainId ? a.version - b.version : a.lastSeen < b.lastSeen ? 1 : -1));
  for (const f of ordered) groups.get(subjectOf.get(f.id) ?? '')?.facts.push({ node: f, depth: depthOf(f) });
  return [...groups.values()].filter((g) => g.facts.length > 0 || subjects.size === 1);
}

export function GraphList({ data, onOpenPage, onVersions }: { data: GraphData; onOpenPage: (page: string) => void; onVersions: (fact: GraphFactNode, subject: string) => void }) {
  const groups = groupBySubject(data);
  return (
    <div className="flex flex-col gap-4">
      {groups.map(({ subject, facts }) => (
        <section key={subject.id} aria-label={subject.label}>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <h3 className="text-[15px] font-semibold text-t1 [overflow-wrap:anywhere]">{subject.label}</h3>
            {subject.page && (
              <Button size="sm" className="max-md:h-11" onClick={() => onOpenPage(subject.page!)}>
                Open page
              </Button>
            )}
          </div>
          <ul className="flex flex-col gap-1.5">
            {facts.map(({ node, depth }) => (
              <li key={node.id} style={{ marginLeft: `${Math.min(depth, 4) * 16}px` }} className={`rounded-xl border border-hair px-3 py-2 ${node.latest ? '' : 'opacity-70'}`}>
                <p className="text-[13px] leading-snug text-t1 [overflow-wrap:anywhere]">{node.statement || 'The words were dropped to keep the history short.'}</p>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-t3">
                  <Badge tone="muted">{node.factKind}</Badge>
                  <Badge tone={node.latest ? 'success' : 'muted'}>{`Version ${node.version}`}</Badge>
                  {node.relation && <Badge tone="muted">{GRAPH_EDGE_LABELS[node.relation]}</Badge>}
                  {node.status === 'stale' && <Badge tone="warning">Stale</Badge>}
                  {node.forgotten && <Badge tone="danger">Forgotten</Badge>}
                  <span>{stamp(node.lastSeen)}</span>
                </div>
                {node.version > 1 || !node.latest ? (
                  <button type="button" onClick={() => onVersions(node, subject.label)} className="mt-1 inline-flex min-h-11 items-center text-[12px] font-semibold text-ac">
                    Versions
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
