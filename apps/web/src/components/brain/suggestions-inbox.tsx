'use client';
/** Home's Suggestions: what the second brain found, highest score first (docs/second-brain.md). Hidden when there are none. */
import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { api } from '@/lib/client/api';
import type { Proposal } from '@/lib/shared/brain';
import { Card } from '../shell/page-header';
import { SectionLabel } from '../ui/inputs';
import { ProposalCard, useProposalActions } from './proposal-card';

export function SuggestionsInbox() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [hidden, setHidden] = useState(false);
  // "For me": only what is addressed to the person (a suggestion about something outside their projects can be).
  const [forMe, setForMe] = useState(false);
  useEffect(() => {
    api<{ proposals: Proposal[] }>(`/api/proposals?status=open&limit=20${forMe ? '&for=me' : ''}`)
      .then((r) => setProposals(r.proposals))
      .catch(() => setHidden(true));
  }, [forMe]);
  const actions = useProposalActions({
    onDone: (id) => setProposals((list) => list.filter((p) => p.id !== id)),
    onForbidden: () => setHidden(true),
  });
  if (hidden || (!proposals.length && !forMe)) return null;
  return (
    <Card className="space-y-2.5 p-4">
      <div className="flex items-center gap-2">
        <Sparkles className="size-3.5 text-viz-7" />
        <SectionLabel>Suggestions</SectionLabel>
        <span className="font-mono text-[11px] text-t3">{proposals.length}</span>
        <button onClick={() => setForMe((v) => !v)} aria-pressed={forMe} className={`ml-auto rounded-md border px-2 py-0.5 text-[11.5px] ${forMe ? 'border-ac text-ac' : 'border-hair text-t3 hover:text-t1'}`}>
          For me
        </button>
      </div>
      {!proposals.length && <p className="text-[12px] text-t3">Nothing is addressed to you.</p>}
      <div className="grid grid-cols-1 gap-2.5 xl:grid-cols-2">
        {proposals.map((p) => (
          <ProposalCard key={p.id} proposal={p} actions={actions} />
        ))}
      </div>
    </Card>
  );
}
