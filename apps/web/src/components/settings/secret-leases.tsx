'use client';
/**
 * Settings → External secrets → Leases (owners and admins): the leased dynamic secrets (C30) issued to runs by an OpenBao
 * / Vault provider's dynamic mounts. One row per run and path: the run (a link to its Run trace), the secret, when it was
 * issued and when it ends, and its state. **Revoke now** removes the credential at the store at once; **Revoke run** does it for every open lease
 * of one run. A lease that could not be revoked for 24 hours shows a red banner until each is revoked or set aside. A
 * lease id or value is never shown, and the API never sends one.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { KeyRound, RefreshCw, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { dayTime, plural, stamp, timeAgo } from '@/lib/client/format';
import type { SecretLeaseRevokeResponse, SecretLeasesResponse, SecretLeaseState, SecretLeaseView } from '@/lib/shared/secrets';
import { Card } from '@/components/shell/page-header';
import { Badge, type Tone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataGrid, type GridColumn } from '@/components/ui/data-grid';
import { EmptyState } from '@/components/ui/empty-state';
import { SectionLabel } from '@/components/ui/inputs';
import { Segmented } from '@/components/ui/segmented';

type Filter = 'active' | 'ended' | 'revoke_failed' | 'all';

const STATE: Record<SecretLeaseState, { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'success' },
  revoked: { label: 'Revoked', tone: 'muted' },
  expired: { label: 'Expired', tone: 'muted' },
  revoke_failed: { label: 'Not revoked', tone: 'danger' },
};

/** The reference a credential field writes for this lease's secret. */
const secretOf = (lease: Pick<SecretLeaseView, 'provider' | 'path'>) => `$secrets.${lease.provider}['${lease.path}']`;

export function SecretLeases() {
  const [filter, setFilter] = useState<Filter>('active');
  const [data, setData] = useState<SecretLeasesResponse>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [more, setMore] = useState(false);

  const load = useCallback(
    async (cursor?: string, background = false) => {
      try {
        const query = new URLSearchParams({ limit: '50', ...(filter !== 'all' && { state: filter }), ...(cursor && { cursor }) });
        const page = await api<SecretLeasesResponse>(`/api/external-secrets/leases?${query}`, { background });
        setData((old) => (cursor && old ? { ...page, leases: [...old.leases, ...page.leases] } : page));
        setError(undefined);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setMore(false);
      }
    },
    [filter],
  );
  // Leases come and go as runs do: look again every ten seconds while the section is open.
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(undefined, true), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const revoke = async (key: string, body: { id: string; dismiss?: boolean } | { executionId: string }, done: (result: SecretLeaseRevokeResponse) => string) => {
    setBusy(key);
    try {
      const result = await api<SecretLeaseRevokeResponse>('/api/external-secrets/leases/revoke', { method: 'POST', json: body });
      const failure = result.failed ? result.leases.find((l) => l.lastError)?.lastError : undefined;
      if (result.failed) toast.error(`The store refused${failure ? `: ${failure}` : ''}. It is tried again by itself.`);
      else toast.success(done(result));
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const columns: Array<GridColumn<SecretLeaseView>> = [
    {
      key: 'executionId',
      label: 'Run',
      type: 'text',
      width: 150,
      render: (lease) => (
        <Link href={`/runs/${lease.executionId}`} className="font-mono text-[12px] text-ac hover:underline" title="Open the Run trace">
          {lease.executionId.slice(0, 14)}
        </Link>
      ),
    },
    { key: 'path', label: 'Secret', type: 'text', width: 300, render: (lease) => <span className="font-mono text-[12px] text-t1">{secretOf(lease)}</span> },
    { key: 'issuedAt', label: 'Issued', type: 'text', width: 110, render: (lease) => <span title={dayTime(lease.issuedAt)}>{timeAgo(lease.issuedAt)}</span> },
    {
      key: 'expiresAt',
      label: 'Ends',
      type: 'text',
      width: 170,
      render: (lease) => (
        <span title={lease.renewedUntil ? 'Renewed while the run went' : undefined}>
          {stamp(lease.expiresAt)}
          {lease.renewedUntil ? ' (renewed)' : ''}
        </span>
      ),
    },
    {
      key: 'state',
      label: 'State',
      type: 'text',
      width: 120,
      render: (lease) => (
        <Badge tone={STATE[lease.state].tone} title={lease.lastError}>
          {STATE[lease.state].label}
          {lease.dismissed ? ' · set aside' : ''}
        </Badge>
      ),
    },
  ];

  const leases = data?.leases ?? [];
  const openOf = (executionId: string) => leases.filter((l) => l.executionId === executionId && l.state === 'active').length;
  const failed = leases.filter((l) => l.state === 'revoke_failed' && !l.dismissed);

  return (
    <Card className="px-5 py-4">
      <div className="mb-2 flex flex-wrap items-center gap-2" data-testid="secret-leases">
        <KeyRound className="size-4 text-t3" strokeWidth={1.8} />
        <SectionLabel>Leases</SectionLabel>
        {data && <span className="text-[12px] text-t3">{plural(data.counts.active, 'open lease')}</span>}
        <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={() => void load()} aria-label="Refresh leases" title="Look again">
          <RefreshCw className="size-3.5" />
        </Button>
      </div>
      <p className="text-[13px] text-t2">
        A path under a provider’s <b>Dynamic mounts</b>, <code className="font-mono text-[12px]">{"{{ $secrets.bao['database/creds/report-reader'].password }}"}</code>, is issued to a run, once per path, the first time a node’s
        credential needs it. The store removes it when the run ends, and the host removes it if the run is gone or its time runs out.
      </p>
      {data && data.counts.revokeFailed > 0 && (
        <div className="mt-3 flex items-start gap-2 rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd" role="alert" data-testid="lease-banner">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" strokeWidth={1.8} />
          <div className="min-w-0">
            <p className="font-semibold">{plural(data.counts.revokeFailed, 'leased secret')} could not be revoked for 24 hours</p>
            <p>The credential may still work at the store. Revoke it there, then set the lease aside here; or Revoke now once the store is back.</p>
            {failed.map((lease) => (
              <p key={lease.id} className="mt-1 flex flex-wrap items-center gap-2">
                <span className="font-mono text-[12px]">{secretOf(lease)}</span>
                <Button size="sm" variant="outline" loading={busy === lease.id} onClick={() => void revoke(lease.id, { id: lease.id, dismiss: true }, () => 'Set aside')}>
                  Set aside
                </Button>
              </p>
            ))}
          </div>
        </div>
      )}
      <div className="mt-3">
        <Segmented<Filter>
          label="Leases"
          value={filter}
          onChange={(next) => {
            setData(undefined);
            setFilter(next);
          }}
          options={[
            { value: 'active', label: 'Open' },
            { value: 'ended', label: 'Ended' },
            { value: 'revoke_failed', label: 'Not revoked' },
            { value: 'all', label: 'All' },
          ]}
        />
      </div>
      {error && <p className="mt-2 text-[13px] text-rd">{error}</p>}
      <div className="mt-3">
        {!data && !error ? (
          <div className="h-24 rounded-xl border border-hair bg-sf animate-pulse-soft" />
        ) : leases.length === 0 && !error ? (
          <EmptyState compact icon={<KeyRound />} title={filter === 'active' ? 'No open leases' : 'No leases here'} hint="A run gets one when a node’s credential reads a path under a dynamic mount." />
        ) : (
          <DataGrid
            columns={columns}
            rows={leases}
            readOnly
            minWidth={900}
            label="Leased secrets"
            className="max-h-[60dvh]"
            trailingHeader={<span className="sr-only">Actions</span>}
            rowActions={(lease) =>
              lease.state === 'active' || (lease.state === 'revoke_failed' && !lease.dismissed) ? (
                <span className="flex items-center gap-1.5">
                  <Button size="sm" variant="outline" loading={busy === lease.id} onClick={() => void revoke(lease.id, { id: lease.id }, () => 'Revoked')}>
                    Revoke now
                  </Button>
                  {openOf(lease.executionId) > 1 && (
                    <Button size="sm" variant="ghost" loading={busy === `run:${lease.executionId}`} onClick={() => void revoke(`run:${lease.executionId}`, { executionId: lease.executionId }, (r) => `Revoked ${plural(r.revoked, 'lease')} of the run`)}>
                      Revoke run
                    </Button>
                  )}
                </span>
              ) : null
            }
          />
        )}
        {data?.nextCursor && (
          <Button className="mt-2" variant="outline" size="sm" loading={more} onClick={() => {
              setMore(true);
              void load(data.nextCursor);
            }}>
            Older leases
          </Button>
        )}
      </div>
    </Card>
  );
}
