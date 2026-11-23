'use client';
/**
 * Grants: who holds what, since when and until when, with Revoke now, Done (a manual grant) and Retry only where the view says the
 * viewer may (`canRevoke`, `canMarkDone`, `canRetry`). A red banner says when a removal is more than a day overdue. A desktop gets the
 * grid, a phone cards.
 */
import { useState } from 'react';
import { ShieldCheck, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { accessApi, overdueGrants, useLoaded } from '@/lib/client/access';
import type { AccessGrantView, GrantStatus } from '@/lib/shared/access';
import { usePhone } from '@/lib/client/use-phone';
import { Card } from '../shell/page-header';
import { Badge, type Tone } from '../ui/badge';
import { Button } from '../ui/button';
import { DataGrid, type GridColumn } from '../ui/data-grid';
import { EmptyState } from '../ui/empty-state';
import { Segmented } from '../ui/segmented';
import { untilText } from './my-requests';

export type GrantAct = (grant: AccessGrantView, action: 'revoke' | 'done' | 'retry') => void;

const GRANT_WORDS: Record<GrantStatus, [string, Tone]> = {
  pending: ['Waiting for hand work', 'warning'],
  active: ['Active', 'success'],
  removing: ['Removing', 'warning'],
  expired: ['Ended', 'muted'],
  revoked: ['Revoked', 'muted'],
  failed: ['Failed', 'danger'],
  revoke_failed: ['Removal failed', 'danger'],
  drift: ['Removed outside Landflow', 'muted'],
};
export const GrantBadge = ({ status }: { status: GrantStatus }) => <Badge tone={GRANT_WORDS[status][1]}>{GRANT_WORDS[status][0]}</Badge>;

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const untilCell = (g: AccessGrantView) => (g.until === null ? 'No end' : g.until ? when(g.until) : '');

function Actions({ grant, onAct }: { grant: AccessGrantView; onAct: GrantAct }) {
  return (
    <div className="flex gap-1.5 max-md:w-full">
      {grant.canRevoke && <Button size="sm" variant="outline" onClick={() => onAct(grant, 'revoke')} className="max-md:h-11 max-md:flex-1">Revoke now</Button>}
      {grant.canMarkDone && <Button size="sm" variant="outline" onClick={() => onAct(grant, 'done')} className="max-md:h-11 max-md:flex-1">Done</Button>}
      {grant.canRetry && <Button size="sm" variant="outline" onClick={() => onAct(grant, 'retry')} className="max-md:h-11 max-md:flex-1">Retry</Button>}
    </div>
  );
}

export function OverdueBanner({ grants, now }: { grants: AccessGrantView[]; now?: number }) {
  const late = overdueGrants(grants, now);
  if (late.length === 0) return null;
  return (
    <div role="alert" className="flex items-start gap-2 rounded-xl border border-rdbd bg-rddim px-3 py-2 text-[13px] text-rd">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <span>{late.length === 1 ? 'One grant' : `${late.length} grants`} could not be removed on time: {late.map((g) => `${g.holder.name} on ${g.entryName}${g.lastError ? ` (${g.lastError})` : ''}`).join('; ')}. Retry, or remove it by hand.</span>
    </div>
  );
}

export function GrantsGrid({ grants, onAct }: { grants: AccessGrantView[]; onAct: GrantAct }) {
  const columns: Array<GridColumn<AccessGrantView>> = [
    { key: 'holder', label: 'Who', type: 'text', value: (g) => g.holder.name, width: 150 },
    { key: 'entryName', label: 'What', type: 'text', render: (g) => <span>{g.entryName} <span className="text-t3">{g.targetLabel}</span></span>, width: 240 },
    { key: 'account', label: 'Account', type: 'text', width: 130 },
    { key: 'since', label: 'Since', type: 'text', value: (g) => when(g.since), width: 130 },
    { key: 'until', label: 'Until', type: 'text', value: untilCell, width: 130 },
    { key: 'approvedBy', label: 'Approved by', type: 'text', width: 130 },
    { key: 'status', label: 'Status', type: 'text', render: (g) => <GrantBadge status={g.status} />, width: 170 },
  ];
  return (
    <DataGrid
      label="Grants"
      columns={columns}
      rows={grants}
      readOnly
      minWidth={1000}
      rowActions={(g) => <Actions grant={g} onAct={onAct} />}
      empty={<EmptyState compact title="No grants" hint="Approved access shows here until it ends." />}
    />
  );
}

export function GrantCards({ grants, onAct }: { grants: AccessGrantView[]; onAct: GrantAct }) {
  return (
    <ul className="flex flex-col gap-2">
      {grants.map((g) => (
        <li key={g.id} className="rounded-2xl border border-hair bg-sf px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-semibold text-t1">{g.entryName}</span>
            <GrantBadge status={g.status} />
          </div>
          <p className="mt-0.5 text-[13px] text-t2">{g.holder.name}{g.account ? ` · ${g.account}` : ''}</p>
          <p className="text-[12px] text-t3">{g.targetLabel} · {untilText(g.until) || 'not started'}{g.approvedBy ? ` · approved by ${g.approvedBy}` : ''}</p>
          {g.lastError && <p className="mt-1 text-[13px] text-rd [overflow-wrap:anywhere]">{g.lastError}</p>}
          {(g.canRevoke || g.canMarkDone || g.canRetry) && <div className="mt-2"><Actions grant={g} onAct={onAct} /></div>}
        </li>
      ))}
    </ul>
  );
}

export function GrantsView({ admin, manages }: { admin: boolean; manages: boolean }) {
  const phone = usePhone();
  const [scope, setScope] = useState<'mine' | 'all'>(admin || manages ? 'all' : 'mine');
  const { data, error, reload } = useLoaded(() => accessApi.grants(scope), [scope]);
  const [busy, setBusy] = useState(false);
  const act: GrantAct = async (grant, action) => {
    if (busy) return;
    setBusy(true);
    try {
      await accessApi.grantAction(grant.id, action);
      toast.success(action === 'revoke' ? 'Access removed' : action === 'done' ? 'Marked done' : 'Tried again');
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3">
      {(admin || manages) && <Segmented label="Show" value={scope} onChange={setScope} options={[{ value: 'all', label: admin ? 'Everyone' : 'What I manage' }, { value: 'mine', label: 'Mine' }]} />}
      {error && !data && <Card><EmptyState title="Grants not available" hint={error} /></Card>}
      {!data && !error && <p className="text-[13px] text-t3">Loading…</p>}
      {data && (
        <>
          <OverdueBanner grants={data.items} />
          {data.items.length === 0 ? (
            <Card><EmptyState icon={<ShieldCheck />} title="No grants" hint="Approved access shows here until it ends." /></Card>
          ) : phone ? (
            <GrantCards grants={data.items} onAct={act} />
          ) : (
            <GrantsGrid grants={data.items} onAct={act} />
          )}
        </>
      )}
    </div>
  );
}
