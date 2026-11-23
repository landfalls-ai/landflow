'use client';
/** The catalog: one row per entry (a card on a phone), the sheet to edit one, and New entry for admins. */
import { useState } from 'react';
import Link from 'next/link';
import { Plus, Library } from 'lucide-react';
import { SYSTEM_FORM } from '@/lib/client/access';
import { durationText, type AccessEntryView, type AccessSetup } from '@/lib/shared/access';
import type { Viewer } from '@/lib/shared/auth';
import { usePhone } from '@/lib/client/use-phone';
import { isAdminViewer, type Person2 } from '@/lib/client/access';
import { Card } from '../shell/page-header';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { DataGrid, type GridColumn } from '../ui/data-grid';
import { EmptyState } from '../ui/empty-state';
import { EntrySheet } from './entry-sheet';

export function CatalogGrid({ entries, isAdmin, onOpen, onNew, phone }: { entries: AccessEntryView[]; isAdmin: boolean; onOpen: (entry: AccessEntryView) => void; onNew: () => void; phone?: boolean }) {
  const columns: Array<GridColumn<AccessEntryView>> = [
    { key: 'name', label: 'Name', type: 'text', render: (e) => <button type="button" onClick={() => onOpen(e)} className="text-left font-semibold text-ac hover:underline">{e.name}</button>, width: 200 },
    { key: 'system', label: 'System', type: 'text', value: (e) => SYSTEM_FORM[e.system].label, width: 160 },
    { key: 'target', label: 'Target', type: 'text', value: (e) => e.target.label, width: 200 },
    { key: 'durations', label: 'Durations', type: 'text', value: (e) => e.durations.map(durationText).join(', '), width: 220 },
    { key: 'approvers', label: 'Approvers', type: 'text', value: (e) => e.approverNames.join(', '), width: 180 },
    { key: 'enabled', label: 'State', type: 'text', render: (e) => <Badge tone={e.enabled ? 'success' : 'muted'}>{e.enabled ? 'On' : 'Off'}</Badge>, width: 80 },
  ];
  return (
    <div className="flex flex-col gap-3">
      {isAdmin && (
        <div>
          <Button variant="primary" size="sm" onClick={onNew} data-testid="access-new-entry" className="max-md:h-11"><Plus className="size-3.5" /> New entry</Button>
        </div>
      )}
      {phone && entries.length === 0 ? (
        <Card><EmptyState icon={<Library />} title="Nothing in the catalog" hint="Add what people may ask for." /></Card>
      ) : phone ? (
        <ul className="flex flex-col gap-2">
          {entries.map((e) => (
            <li key={e.id}>
              <button type="button" onClick={() => onOpen(e)} className="w-full rounded-2xl border border-hair bg-sf px-4 py-3 text-left">
                <span className="flex items-center gap-2"><span className="text-[14px] font-semibold text-t1">{e.name}</span><Badge tone={e.enabled ? 'success' : 'muted'}>{e.enabled ? 'On' : 'Off'}</Badge></span>
                <span className="block text-[13px] text-t2">{SYSTEM_FORM[e.system].label} · {e.target.label}</span>
                <span className="block text-[12px] text-t3">{e.durations.map(durationText).join(', ')}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <DataGrid label="Catalog" columns={columns} rows={entries} readOnly minWidth={1000} empty={<EmptyState compact title="Nothing in the catalog" hint="Add what people may ask for." />} />
      )}
    </div>
  );
}

export function CatalogView({ viewer, entries, people, setup, onChanged }: { viewer: Pick<Viewer, 'role'>; entries: AccessEntryView[]; people: Person2[]; setup?: AccessSetup; onChanged: () => void }) {
  const projectId = setup?.projectId;
  const phone = usePhone();
  const admin = isAdminViewer(viewer);
  const [sheet, setSheet] = useState<{ entry?: AccessEntryView }>();
  const editable = entries.filter((e) => admin || e.canEdit);
  return (
    <>
      {admin && setup?.workflowId && (
        <p className="mb-3 text-[12.5px] text-t3">
          The flows behind this page: <Link href={`/workflows/${setup.workflowId}`} className="text-ac hover:underline">Access requests</Link>
          {setup.chatWorkflowId && <>, <Link href={`/workflows/${setup.chatWorkflowId}`} className="text-ac hover:underline">the chat</Link></>}.
          {setup.flowsAdminOnly ? ' Only admins can change them, so what an approver is shown can’t be altered by someone else.' : ''}
        </p>
      )}
      {editable.length === 0 && !admin ? (
        <Card><EmptyState icon={<Library />} title="You own no entries" /></Card>
      ) : (
        <CatalogGrid entries={editable} isAdmin={admin} phone={phone} onOpen={(entry) => setSheet({ entry })} onNew={() => setSheet({})} />
      )}
      <EntrySheet open={Boolean(sheet)} entry={sheet?.entry} isAdmin={admin} people={people} projectId={projectId} onClose={() => setSheet(undefined)} onSaved={onChanged} />
    </>
  );
}
