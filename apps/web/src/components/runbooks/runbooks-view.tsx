'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { BookOpenCheck, ChevronRight, ShieldCheck, Trash2 } from 'lucide-react';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { FieldLabel, Input, Switch, Textarea } from '@/components/ui/inputs';

interface Runbook {
  id: string;
  name: string;
  alertKind: string;
  room?: string;
  steps: number;
  approvals: number;
  published: boolean;
  updatedAt: string;
  url: string;
  match?: string;
}

interface Step {
  title: string;
  approval: boolean;
  reason?: string;
  notes: string[];
  source?: { seq?: number; remediationId?: string; from: 'remediation' | 'outcome' };
}

interface Draft {
  name: string;
  alertKind: string;
  description: string;
  room?: string;
  steps: Step[];
  skipped: string[];
  background: { cause?: string; fix?: string; lessons?: string };
}

const EXAMPLE = '{\n  "incident": { "displayId": "ACME-12", "title": "Checkout 5xx" },\n  "events": [],\n  "outcome": { "cause": "", "fix": "", "lessons": "" }\n}';

/** /runbooks: the runbooks by alert kind, and "Make a runbook" from a closed Landfall room. One column, cards. */
export function RunbooksView() {
  const [kind, setKind] = useState('');
  const [runbooks, setRunbooks] = useState<Runbook[]>();
  const [error, setError] = useState<string>();
  const [making, setMaking] = useState(false);

  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get('kind');
    if (initial) setKind(initial);
  }, []);

  const load = useCallback(() => {
    api<{ runbooks: Runbook[] }>(`/api/runbooks?kind=${encodeURIComponent(kind.trim())}`)
      .then((r) => setRunbooks(r.runbooks))
      .catch((e: Error) => setError(e.message));
  }, [kind]);
  useEffect(() => {
    const timer = setTimeout(load, 200);
    return () => clearTimeout(timer);
  }, [load]);

  return (
    <>
      <PageHeader title="Runbooks" meta={runbooks && <span>{runbooks.length}</span>} actions={<Button variant="primary" size="sm" onClick={() => setMaking((v) => !v)}>Make a runbook</Button>} />
      <PageBody width="narrow" className="space-y-3">
        {error && <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>}
        {making && <MakeRunbook onSaved={() => { setMaking(false); load(); }} />}
        <Input value={kind} onChange={(e) => setKind(e.target.value)} placeholder="Filter by alert kind, e.g. high-error-rate" className="h-9" />
        {runbooks && runbooks.length === 0 && (
          <Card>
            <EmptyState title={kind.trim() ? 'No runbook for this kind of alert' : 'No runbooks yet'} hint="After a Landfall war room closes, paste the room (the Landfall node’s Get Room output) under Make a runbook. The steps the responders took become a draft workflow you review." />
          </Card>
        )}
        {runbooks?.map((r) => (
          <Link key={r.id} href={r.url} className="group block">
            <Card className="flex items-center gap-3 transition-colors group-hover:bg-acdim">
              <BookOpenCheck className="size-4 shrink-0 text-t2" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold text-t1">{r.name}</div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-t3">
                  <Badge tone="accent">{r.alertKind || 'no kind'}</Badge>
                  <Badge tone={r.published ? 'success' : 'warning'}>{r.published ? 'published' : 'draft'}</Badge>
                  <span>{r.steps} {r.steps === 1 ? 'step' : 'steps'}</span>
                  {r.approvals > 0 && <span className="inline-flex items-center gap-0.5"><ShieldCheck className="size-3" />{r.approvals} to approve</span>}
                  {r.room && <span>from {r.room}</span>}
                  {r.updatedAt && <span>{timeAgo(r.updatedAt)}</span>}
                </div>
              </div>
              <ChevronRight className="size-4 shrink-0 text-t3" />
            </Card>
          </Link>
        ))}
      </PageBody>
    </>
  );
}

/** Paste a room, review the folded steps (drop one, flip its approval), save them as a draft workflow. */
function MakeRunbook({ onSaved }: { onSaved: () => void }) {
  const [source, setSource] = useState('');
  const [alertKind, setAlertKind] = useState('');
  const [draft, setDraft] = useState<Draft>();
  const [existing, setExisting] = useState<Runbook[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const fold = async () => {
    setError(undefined);
    let room: unknown;
    try {
      room = JSON.parse(source);
    } catch {
      return setError('The room is not valid JSON');
    }
    setBusy(true);
    try {
      const r = await api<{ draft: Draft; existing: Runbook[] }>('/api/runbooks/draft', { method: 'POST', json: { room, ...(alertKind.trim() && { alertKind: alertKind.trim() }) } });
      setDraft(r.draft);
      setExisting(r.existing);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(undefined);
    try {
      const { runbook } = await api<{ runbook: Runbook }>('/api/runbooks', { method: 'POST', json: { name: draft.name, alertKind: draft.alertKind, description: draft.description, room: draft.room, steps: draft.steps, background: draft.background } });
      window.location.assign(runbook.url);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const change = (index: number, patch: Partial<Step>) => setDraft((d) => d && { ...d, steps: d.steps.map((s, i) => (i === index ? { ...s, ...patch } : s)) });

  return (
    <Card className="space-y-3">
      {error && <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2 text-[13px] text-rd">{error}</div>}
      {!draft ? (
        <>
          <div>
            <FieldLabel>The closed room</FieldLabel>
            <Textarea value={source} onChange={(e) => setSource(e.target.value)} rows={8} placeholder={EXAMPLE} className="font-mono text-[12px]" />
            <p className="mt-1 text-[12px] text-t3">JSON with <code>incident</code>, <code>events</code> and optionally <code>outcome</code> (a Room outcomes row). The Landfall node’s Incident → Get Room gives the first two.</p>
          </div>
          <div>
            <FieldLabel>Alert kind (optional)</FieldLabel>
            <Input value={alertKind} onChange={(e) => setAlertKind(e.target.value)} placeholder="Defaults to the room’s title" />
          </div>
          <Button variant="primary" onClick={fold} disabled={busy || !source.trim()}>Fold into steps</Button>
        </>
      ) : (
        <>
          <div>
            <FieldLabel>Name</FieldLabel>
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          <div>
            <FieldLabel>Alert kind</FieldLabel>
            <Input value={draft.alertKind} onChange={(e) => setDraft({ ...draft, alertKind: e.target.value })} />
            {existing.length > 0 && <p className="mt-1 text-[12px] text-t3">Already has {existing.length === 1 ? 'a runbook' : `${existing.length} runbooks`}: {existing.map((r) => r.name).join(', ')}</p>}
          </div>
          <div className="space-y-2">
            {draft.steps.map((step, i) => (
              <div key={i} className="rounded-xl border border-hair bg-sf2 p-3">
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 font-mono text-[12px] text-t3">{i + 1}</span>
                  <Input value={step.title} onChange={(e) => change(i, { title: e.target.value })} className="h-8 flex-1" />
                  <button type="button" aria-label="Remove the step" className="mt-1 text-t3 hover:text-rd" onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_, k) => k !== i) })}>
                    <Trash2 className="size-4" />
                  </button>
                </div>
                <div className="mt-2 flex items-center gap-2 text-[12px] text-t2">
                  <Switch checked={step.approval} onChange={(approval) => change(i, { approval, reason: approval ? (step.reason ?? 'A person approves this step') : undefined })} label="Approval first" />
                  <span>Ask a person before this step{step.approval && step.reason ? `: ${step.reason}` : ''}</span>
                </div>
                {step.notes.length > 0 && <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[12px] text-t3">{step.notes.map((n, k) => <li key={k}>{n}</li>)}</ul>}
              </div>
            ))}
          </div>
          {draft.skipped.length > 0 && <p className="text-[12px] text-t3">Left out: {draft.skipped.join('; ')}</p>}
          <div className="flex gap-2">
            <Button variant="primary" onClick={save} disabled={busy || !draft.steps.length || !draft.name.trim() || !draft.alertKind.trim()}>Save as draft</Button>
            <Button onClick={() => setDraft(undefined)} disabled={busy}>Back</Button>
          </div>
          <p className="text-[12px] text-t3">Saved as a draft workflow. Nothing runs until you publish it.</p>
        </>
      )}
    </Card>
  );
}
