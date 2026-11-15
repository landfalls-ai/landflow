'use client';
/** An agent's card on the Agents list: its name, what it does and whether it is published. Nothing else (docs/agents.md#the-roster). */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/client/api';
import { Copy, Download, ExternalLink, MoreHorizontal, Sparkles } from 'lucide-react';
import { askAbout, askDetail } from '@/lib/client/ask-about';
import type { AgentSummary } from '@/lib/shared/agents';
import { AgentAvatar } from './avatar';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { MenuItem, Popover } from '../ui/popover';
import { availabilityLabel, ownershipOfSummary, sharedFromLabel, type AvailabilityAnswer } from './project-names';

/** Where each agent is available, fetched once per agent for the list's lines (a failed read leaves the line out). */
const known = new Map<string, AvailabilityAnswer>();
function useAvailability(agentId: string): AvailabilityAnswer | undefined {
  const [answer, setAnswer] = useState(known.get(agentId));
  useEffect(() => {
    let live = true;
    api<{ availability: AvailabilityAnswer }>(`/api/agents/${agentId}/shares`, { background: true })
      .then((r) => {
        known.set(agentId, r.availability);
        if (live) setAnswer(r.availability);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [agentId]);
  return answer;
}

export function AgentCard({ agent, index = 0, onSave, onExport }: { agent: AgentSummary; index?: number; onSave: () => void; onExport: () => void }) {
  const about = agent.description || agent.role;
  const where = availabilityLabel(useAvailability(agent.id));
  const shared = sharedFromLabel(ownershipOfSummary(agent));
  return (
    <article
      className="flex animate-fade-up flex-col gap-2.5 rounded-2xl border border-hair bg-sf p-4 transition-colors duration-[120ms] hover:border-bd"
      style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}
    >
      <div className="flex items-start gap-3">
        <AgentAvatar agent={agent} size={52} />
        <div className="min-w-0 flex-1">
          <Link href={`/agents/${agent.id}`} className="block truncate rounded text-[14px] font-semibold text-t1 hover:text-ac focus-visible:outline-2 focus-visible:outline-ac">
            {agent.name}
          </Link>
          <p className="line-clamp-2 text-[12px] leading-snug text-t2">{about || 'No description'}</p>
        </div>
        <Popover
          trigger={({ toggle }) => (
            <Button size="icon-sm" variant="ghost" aria-label={`More actions for ${agent.name}`} aria-haspopup="menu" onClick={toggle}>
              <MoreHorizontal className="size-4" />
            </Button>
          )}
        >
          {(close) => (
            <>
              <Link href={`/agents/${agent.id}`} role="menuitem" className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-t1 hover:bg-acdim [&_svg]:size-3.5">
                <ExternalLink /> Open
              </Link>
              <MenuItem
                onClick={() => {
                  close();
                  askAbout(askDetail({ type: 'agent', id: agent.id, name: agent.name }));
                }}
              >
                <Sparkles /> Ask Spotlight
              </MenuItem>
              <MenuItem
                onClick={() => {
                  close();
                  onSave();
                }}
              >
                <Copy /> Save as template…
              </MenuItem>
              <MenuItem
                onClick={() => {
                  close();
                  onExport();
                }}
              >
                <Download /> Export JSON
              </MenuItem>
            </>
          )}
        </Popover>
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-1.5">
        {agent.publishedVersion ? <Badge tone="success">Published v{agent.publishedVersion}</Badge> : <Badge tone="muted">Draft</Badge>}
        {agent.publishedVersion && agent.draftChanged && <Badge tone="warning">Changes not published</Badge>}
      </div>
      {(shared || where) && (
        <p className="truncate text-[12px] text-t3" title={shared ?? `Available in ${where}`}>
          {shared ?? `Available in ${where}`}
        </p>
      )}
    </article>
  );
}
