'use client';
/**
 * /access (docs/access-requests.md#the-access-page): the tabs a person gets (Ask, My requests, To decide, Grants, Catalog), or before
 * set-up the card that says so. `AccessFrame` is the shell (header, tabs, the gate); `AccessPage` loads the data and picks the tab's body.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { Viewer } from '@/lib/shared/auth';
import type { AccessSetup } from '@/lib/shared/access';
import { accessApi, accessTabs, type AccessAccounts, isAdminViewer, isApprover, useLoaded, type AccessTab, type AccessTabId } from '@/lib/client/access';
import { useViewer } from '../auth/viewer';
import { Card, PageBody, PageHeader } from '../shell/page-header';
import { EmptyState } from '../ui/empty-state';
import { Segmented, SegmentedCount } from '../ui/segmented';
import { AccessChat } from './access-chat';
import { AskForm } from './ask-form';
import { CatalogView } from './catalog-grid';
import { GrantsView } from './grants-grid';
import { RequestsView } from './my-requests';
import { SetupCard } from './setup-card';
import { DecideView } from './to-decide';

/** The page's frame: the title, the tabs (a phone scrolls them), and the gate before set-up. */
export function AccessFrame({ viewer, setup, tabs, tab, onTab, children, onSetup }: { viewer: Pick<Viewer, 'role'>; setup: AccessSetup | undefined; tabs: AccessTab[]; tab: AccessTabId; onTab: (tab: AccessTabId) => void; children: ReactNode; onSetup?: (setup: AccessSetup) => void }) {
  const ready = Boolean(setup?.installed);
  return (
    <>
      <PageHeader title="Access" meta={ready && !setup?.active ? 'The request flow is switched off: new requests wait for an admin to publish it.' : undefined} />
      <PageBody>
        {!setup && <p className="text-[13px] text-t3">Loading…</p>}
        {setup && !ready && (isAdminViewer(viewer) ? <SetupCard onDone={onSetup ?? (() => {})} /> : (
          <Card>
            <EmptyState title="Access requests aren't set up yet. Ask an admin." hint="Once an admin sets it up, you can ask for a GitHub team, a Google group or anything else here, for a time you choose." />
          </Card>
        ))}
        {ready && (
          <div className="flex flex-col gap-4">
            <Segmented
              label="Access"
              value={tab}
              onChange={onTab}
              options={tabs.map((t) => ({ value: t.id, label: t.count !== undefined ? <>{t.label} {t.count > 0 && <SegmentedCount>{t.count}</SegmentedCount>}</> : t.label }))}
            />
            {children}
          </div>
        )}
      </PageBody>
    </>
  );
}

const TABS: AccessTabId[] = ['ask', 'mine', 'decide', 'grants', 'catalog'];

export function AccessPage() {
  const viewer = useViewer();
  const setupState = useLoaded(accessApi.setup);
  const entriesState = useLoaded(accessApi.entries);
  const ready = Boolean(setupState.data?.installed);
  const decideState = useLoaded(() => (ready ? accessApi.requests('decide').then((r) => r.items.filter((i) => i.canDecide).length) : Promise.resolve(0)), [ready]);
  const [tab, setTabState] = useState<AccessTabId>('ask');
  const [highlight, setHighlight] = useState<string>();
  const [mode, setMode] = useState<'form' | 'chat'>('form');

  // The address names the tab (and a request to point at): /access?tab=mine&request=<id>.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const wanted = params.get('tab') as AccessTabId | null;
    if (wanted && TABS.includes(wanted)) setTabState(wanted);
    setHighlight(params.get('request') ?? undefined);
  }, []);
  const setTab = useCallback((next: AccessTabId) => {
    setTabState(next);
    setHighlight(undefined);
    window.history.replaceState(null, '', `/access?tab=${next}`);
  }, []);

  // Keep the counts and lists current while the page is open (background reads: they don't extend the session).
  const { reload: reloadSetup } = setupState;
  const { reload: reloadEntries } = entriesState;
  const { reload: reloadDecide } = decideState;
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void reloadDecide();
      void reloadEntries();
    }, 15_000);
    return () => clearInterval(id);
  }, [reloadDecide, reloadEntries]);

  const accounts = useLoaded(() => (ready ? accessApi.accounts() : Promise.resolve<AccessAccounts>({})), [ready]);
  const entries = useMemo(() => entriesState.data?.items ?? [], [entriesState.data]);
  const people = entriesState.data?.people ?? [];
  const setup = setupState.data;

  if (!viewer) return null;
  const tabs = accessTabs({ setup, viewer, entries, toDecide: decideState.data ?? 0 });
  // A tab the person doesn't have (a link someone sent) falls back to Ask.
  const current: AccessTabId = tabs.some((t) => t.id === tab) ? tab : 'ask';
  const refreshAll = () => {
    void reloadSetup();
    void reloadEntries();
    void reloadDecide();
  };

  return (
    <AccessFrame viewer={viewer} setup={setup} tabs={tabs} tab={current} onTab={setTab} onSetup={() => refreshAll()}>
      {current === 'ask' && (
        <div className="flex flex-col gap-3">
          <Segmented label="How to ask" value={mode} onChange={setMode} options={[{ value: 'form', label: 'Form' }, { value: 'chat', label: 'Chat' }]} />
          {mode === 'form' ? (
            <AskForm
              entries={entries.filter((e) => e.enabled)}
              savedGithub={accounts.data?.github}
              email={viewer.email}
              onAsked={() => {
                toast.success('Asked. You will see the answer under My requests.');
                void accounts.reload();
                void reloadDecide();
                setTab('mine');
              }}
              onAccountSaved={() => void accounts.reload()}
            />
          ) : (
            <AccessChat available={Boolean(setup?.chatWorkflowId)} onFiled={() => { toast.success('Filed. You will see the answer under My requests.'); void reloadDecide(); }} onOpen={(id) => { setTab('mine'); setHighlight(id); }} />
          )}
        </div>
      )}
      {current === 'mine' && <RequestsView viewerId={viewer.id} highlight={highlight} />}
      {current === 'decide' && <DecideView entries={entries} onDecided={refreshAll} />}
      {current === 'grants' && <GrantsView admin={isAdminViewer(viewer)} manages={isApprover(viewer, entries) || entries.some((e) => e.canEdit)} />}
      {current === 'catalog' && <CatalogView viewer={viewer} entries={entries} people={people} setup={setup} onChanged={() => void reloadEntries()} />}
    </AccessFrame>
  );
}
