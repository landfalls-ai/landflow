'use client';
/**
 * Abilities tab → What it remembers (docs/agents.md#memory, C09): the memories this agent holds about a person, with Forget
 * (a reason is required) and Restore. A person sees their own; the agent's editors pick whose. Text is shown as text, never as
 * markup. The list is `MemoryList` (no state, so it renders on its own); the card loads and acts.
 */
import { useCallback, useEffect, useState } from 'react';
import { Brain } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import type { AgentMemoryView } from '@/lib/shared/agents';
import { Badge, FilterChip } from '../ui/badge';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { Input, Select } from '../ui/inputs';
import { Section, Field, Dialog } from './dialog';

interface Page {
  items: AgentMemoryView[];
  nextCursor?: string;
  users?: string[];
  recall: 'meaning' | 'words';
}

const day = (iso: string) => iso.slice(0, 10);

/** The memories as rows: static and version badges, when it was said, and Forget (or Restore for a forgotten one). */
export function MemoryList({ items, onForget, onRestore }: { items: AgentMemoryView[]; onForget?: (item: AgentMemoryView) => void; onRestore?: (item: AgentMemoryView) => void }) {
  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => (
        <li key={item.id} className="flex items-start gap-3 rounded-[10px] border border-hair bg-wl px-3 py-2.5 max-md:flex-col">
          <div className="min-w-0 flex-1">
            <p className="break-words text-[13px] leading-snug text-t1">{item.text}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-t3">
              {item.static && <Badge tone="accent">Static</Badge>}
              {item.version > 1 && <Badge tone="muted">Version {item.version}</Badge>}
              <span>{item.forgottenAt ? `Forgotten ${day(item.forgottenAt)}` : `Said ${day(item.at)}`}</span>
              {item.forgetReason && <span className="break-words">Reason: {item.forgetReason}</span>}
            </div>
          </div>
          {item.forgottenAt
            ? onRestore && (
                <Button variant="outline" size="sm" onClick={() => onRestore(item)}>
                  Restore
                </Button>
              )
            : onForget && (
                <Button variant="outline" size="sm" onClick={() => onForget(item)}>
                  Forget
                </Button>
              )}
        </li>
      ))}
    </ul>
  );
}

export function MemoryCard({ agentId }: { agentId: string }) {
  const [users, setUsers] = useState<string[]>();
  const [user, setUser] = useState<string>();
  const [forgotten, setForgotten] = useState(false);
  const [page, setPage] = useState<Page>();
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<AgentMemoryView>();
  const [reason, setReason] = useState('');

  const load = useCallback(
    (cursor?: string) => {
      const query = new URLSearchParams({ forgotten: forgotten ? '1' : '0', ...(user && { user }), ...(cursor && { cursor }) });
      setLoading(true);
      api<Page>(`/api/agents/${agentId}/memories?${query}`)
        .then((r) => {
          if (r.users) {
            // An editor without a person picked yet: the people the agent has memories of.
            setUsers(r.users);
            if (r.users[0]) setUser(r.users[0]);
            else setPage({ items: [], recall: r.recall });
            return;
          }
          setPage((old) => (cursor && old ? { ...r, items: [...old.items, ...r.items] } : r));
        })
        .catch((e) => toast.error((e as Error).message))
        .finally(() => setLoading(false));
    },
    [agentId, user, forgotten],
  );
  useEffect(() => load(), [load]);

  const change = async (item: AgentMemoryView, body: Record<string, unknown>, done: string) => {
    try {
      await api(`/api/agents/${agentId}/memories/${item.id}`, { method: 'POST', json: { ...body, ...(user && { user }) } });
      toast.success(done);
      setTarget(undefined);
      setReason('');
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <Section
      icon={<Brain className="size-4" />}
      title="What it remembers"
      description={users ? 'What this agent has saved about a person. Pick whose.' : 'What this agent has saved about you.'}
    >
      <div className="flex flex-col gap-3">
        {users && users.length > 0 && (
          <Field label="Person" id="memory-person">
            <Select id="memory-person" value={user ?? ''} onChange={(e) => setUser(e.target.value)}>
              {users.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <FilterChip active={forgotten} onClick={() => setForgotten((f) => !f)}>
            Forgotten
          </FilterChip>
          {page?.recall === 'words' && <Badge tone="warning">Recall by words only</Badge>}
        </div>
        {page && page.items.length > 0 ? (
          <MemoryList items={page.items} onForget={setTarget} onRestore={(item) => change(item, { action: 'restore' }, 'Restored')} />
        ) : (
          !loading && <EmptyState compact title={forgotten ? 'Nothing forgotten' : 'Nothing remembered yet'} hint={forgotten ? undefined : 'It saves durable facts as people talk to it.'} />
        )}
        {page?.nextCursor && (
          <Button variant="outline" size="sm" loading={loading} onClick={() => load(page.nextCursor)}>
            Show more
          </Button>
        )}
      </div>
      {target && (
        <Dialog
          title="Forget this memory"
          subtitle="The agent stops recalling it. You can bring it back from the Forgotten list."
          onClose={() => setTarget(undefined)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setTarget(undefined)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={!reason.trim()} onClick={() => change(target, { action: 'forget', reason: reason.trim() }, 'Forgotten')}>
                Forget
              </Button>
            </>
          }
        >
          <p className="mb-3 break-words text-[13px] text-t1">{target.text}</p>
          <Field label="Why" id="memory-reason" required>
            <Input id="memory-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="It is not true any more" />
          </Field>
        </Dialog>
      )}
    </Section>
  );
}
