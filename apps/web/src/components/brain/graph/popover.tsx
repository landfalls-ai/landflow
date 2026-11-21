/**
 * The card that opens on a node: a fact's statement (as text, never HTML), kind, version, relation, confidence, first and
 * last seen and status, with Open page and Versions; a subject's name and Open page. Written for Landflow after Supermemory's
 * hover popover (see ./NOTICE.md).
 */
import type { ReactNode } from 'react';
import { stamp } from '@/lib/client/format';
import { GRAPH_EDGE_LABELS, type GraphNode } from '@/lib/shared/brain-graph';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';

export function NodePopover({ node, subject, onOpenPage, onVersions, onClose }: { node: GraphNode; subject?: string; onOpenPage?: () => void; onVersions?: () => void; onClose?: () => void }) {
  if (node.kind === 'subject')
    return (
      <Card onClose={onClose}>
        <p className="text-[13px] font-semibold text-t1 [overflow-wrap:anywhere]">{node.label}</p>
        <p className="text-[12px] text-t3">{node.subjectType === 'entity' ? 'Page' : node.subjectType}</p>
        {onOpenPage && node.page && (
          <div className="mt-2">
            <Button size="sm" onClick={onOpenPage}>
              Open page
            </Button>
          </div>
        )}
      </Card>
    );
  return (
    <Card onClose={onClose}>
      <p className="text-[13px] leading-snug text-t1 [overflow-wrap:anywhere]">{node.statement || 'The words were dropped to keep the history short.'}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[12px] text-t3">
        <Badge tone="muted">{node.factKind}</Badge>
        <Badge tone={node.latest ? 'success' : 'muted'}>{node.latest ? `Version ${node.version}, now` : `Version ${node.version}`}</Badge>
        {node.relation && node.relation !== 'updates' && <Badge tone="muted">{GRAPH_EDGE_LABELS[node.relation]}</Badge>}
        {node.status === 'stale' && <Badge tone="warning">Stale</Badge>}
        {node.forgotten && <Badge tone="danger">Forgotten</Badge>}
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px] text-t2">
        {subject && (
          <>
            <dt className="text-t3">About</dt>
            <dd className="[overflow-wrap:anywhere]">{subject}</dd>
          </>
        )}
        <dt className="text-t3">Confidence</dt>
        <dd>{Math.round(node.confidence * 100)}%</dd>
        <dt className="text-t3">First seen</dt>
        <dd>{stamp(node.firstSeen)}</dd>
        <dt className="text-t3">Last seen</dt>
        <dd>{stamp(node.lastSeen)}</dd>
      </dl>
      {(onOpenPage || onVersions) && (
        <div className="mt-2 flex gap-2">
          {onOpenPage && (
            <Button size="sm" onClick={onOpenPage}>
              Open page
            </Button>
          )}
          {onVersions && (
            <Button size="sm" onClick={onVersions}>
              Versions
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

function Card({ children, onClose }: { children: ReactNode; onClose?: () => void }) {
  return (
    <div role="dialog" aria-label="Node details" onKeyDown={(e) => e.key === 'Escape' && onClose?.()} className="pointer-events-auto w-[300px] max-w-full rounded-xl border border-hair bg-sf px-3 py-2.5 shadow-pop">
      {children}
    </div>
  );
}
