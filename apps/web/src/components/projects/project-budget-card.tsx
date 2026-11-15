'use client';
/**
 * A project's Settings tab → "AI budget" (docs/projects-and-goals.md#ai-budget): the monthly budget, the warning, the
 * optional hard stop and an owner; this month's spend as a bar; the month's incidents with their actions.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import {
  askForMore,
  barPercent,
  barTone,
  budgetDirty,
  budgetInput,
  fetchBudget,
  fieldsFrom,
  formatUsd,
  saveBudget,
  useScrollToHash,
  type BarTone,
  type BudgetFields,
} from '@/lib/client/project-budget-api';
import type { ProjectDetail, ProjectMemberView } from '@/lib/shared/projects';
import type { BudgetIncident, ProjectBudgetView } from '@/lib/shared/project-budget';
import { Card } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { confirmAction } from '@/components/ui/confirm';
import { Dialog } from '@/components/ui/dialog';
import { FieldLabel, Input, Select, Switch, Textarea } from '@/components/ui/inputs';
import { refreshNeedsYou } from '@/lib/client/run-trace';
import { BudgetActions } from '@/components/run-trace/needs-you-actions';
import { cn } from '@/lib/utils';

const TONE_CLASS: Record<BarTone, string> = { ok: 'bg-ac', warn: 'bg-warn', full: 'bg-rd' };

/** This month's spend against the budget. */
export function BudgetBar({ view }: { view: ProjectBudgetView }) {
  const budget = view.budget;
  if (!budget) return null;
  return (
    <div data-testid="budget-bar">
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-t1">
        <span className="font-semibold">
          {formatUsd(view.usedUsd)} of {formatUsd(budget.monthlyUsd)}
        </span>
        <span className="text-t3">in {view.month}</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-nudim" role="progressbar" aria-label="AI budget used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={barPercent(view)}>
        <div className={cn('h-full rounded-full', TONE_CLASS[barTone(view)])} style={{ width: `${barPercent(view)}%` }} />
      </div>
      <p className="mt-1 text-[12px] text-t3">
        {view.percent}% used · warns at {budget.warnPercent}%
        {view.unpricedCalls > 0 && ` · ${view.unpricedCalls} calls to local models (not counted)`}
      </p>
    </div>
  );
}

function IncidentRow({ projectId, view, incident, onDone }: { projectId: string; view: ProjectBudgetView; incident: BudgetIncident; onDone: (v: ProjectBudgetView) => void }) {
  const open = incident.status === 'open';
  return (
    <li className="py-2.5">
      <div className="flex flex-wrap items-center gap-2 text-[13px] text-t1">
        <Badge tone={incident.kind === 'stop' ? 'danger' : 'warning'}>{incident.kind === 'stop' ? 'Stopped' : 'Warning'}</Badge>
        <span>
          {formatUsd(incident.usedUsd)} of {formatUsd(incident.budgetUsd)}
        </span>
        <span className="text-[12px] text-t3">
          {timeAgo(incident.createdAt)}
          {!open && ` · ${incident.resolution ?? incident.status}`}
        </span>
      </div>
      {open && (
        <BudgetActions
          className="mt-2"
          skip={['open']}
          onDone={onDone}
          row={{ kind: 'budget', incidentKind: incident.kind, canRaise: view.canEdit, canResume: view.canResume, projectId, incidentId: incident.id, href: undefined }}
          {...(view.budget && { currentUsd: view.budget.monthlyUsd })}
        />
      )}
    </li>
  );
}

/** The card without its data fetching, for the page and for tests. */
export function ProjectBudgetCardView({
  projectId,
  view,
  members,
  fields,
  onFields,
  onSave,
  saving,
  error,
  onView,
  onAsk,
}: {
  projectId: string;
  view: ProjectBudgetView;
  members: ProjectMemberView[];
  fields: BudgetFields;
  onFields?: (next: BudgetFields) => void;
  onSave?: () => void;
  saving?: boolean;
  error?: string;
  onView?: (view: ProjectBudgetView) => void;
  onAsk?: () => void;
}) {
  const set = (patch: Partial<BudgetFields>) => onFields?.({ ...fields, ...patch });
  const edit = view.canEdit;
  const dirty = budgetDirty(fields, view);
  return (
    <div id="budget" className="scroll-mt-[72px] max-md:scroll-mt-[200px]">
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-[13px] font-semibold text-t1">AI budget</div>
        {view.paused && <Badge tone="danger">Paused</Badge>}
        {!view.budget && <Badge tone="muted">No budget</Badge>}
      </div>
      <p className="text-[12px] text-t3">What this project’s agents may spend on paid AI models each month. Local models are free and never counted.</p>

      <BudgetBar view={view} />
      {!view.budget && view.unpricedCalls > 0 && <p className="text-[12px] text-t3">{view.unpricedCalls} calls to local models (not counted)</p>}

      {edit ? (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <FieldLabel>Monthly budget ($)</FieldLabel>
              <Input type="number" inputMode="decimal" min={0} step="any" aria-label="Monthly budget in dollars" value={fields.monthly} onChange={(e) => set({ monthly: e.target.value })} placeholder="No budget" />
            </div>
            <div>
              <FieldLabel>Warn at (%)</FieldLabel>
              <Input type="number" inputMode="numeric" min={1} max={100} step={1} aria-label="Warn at percent" value={fields.warn} onChange={(e) => set({ warn: e.target.value })} />
            </div>
          </div>
          <div className="flex items-start gap-2">
            <Switch checked={fields.hardStop} onChange={(on) => set({ hardStop: on })} label="Hard stop" />
            <div>
              <div className="text-[13px] font-semibold text-t1">Hard stop</div>
              <p className="text-[12px] text-t3">When on, this project’s paid AI calls stop at the budget until someone resumes them. Local models never stop.</p>
            </div>
          </div>
          <div className="max-w-[360px]">
            <FieldLabel>Owner</FieldLabel>
            <Select value={fields.ownerId} onChange={(e) => set({ ownerId: e.target.value })} aria-label="Budget owner">
              <option value="">No owner (the project’s admins)</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-[12px] text-t3">Asked besides the admins; may resume and dismiss.</p>
          </div>
          {error && <p className="text-[12px] text-rd">{error}</p>}
          {dirty && (
            <div className="flex justify-end gap-2 border-t border-hair pt-3">
              <Button size="sm" variant="ghost" onClick={() => onFields?.(fieldsFrom(view))}>
                Discard
              </Button>
              <Button size="sm" variant="primary" onClick={onSave} loading={saving}>
                Save
              </Button>
            </div>
          )}
        </div>
      ) : (
        view.budget && (
          <p className="text-[12px] text-t3">
            {formatUsd(view.budget.monthlyUsd)} a month, warns at {view.budget.warnPercent}%. {view.budget.hardStop ? 'Paid calls stop at the budget.' : 'Paid calls go on past the budget.'} The project’s admins change this.
          </p>
        )
      )}
      {!edit && !view.budget && <p className="text-[12px] text-t3">The project’s admins set a budget.</p>}

      {view.incidents.length > 0 && (
        <div>
          <div className="text-[12px] font-semibold text-t2">This month’s incidents</div>
          <ul className="divide-y divide-hair">
            {view.incidents.map((i) => (
              <IncidentRow key={i.id} projectId={projectId} view={view} incident={i} onDone={(v) => onView?.(v)} />
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {view.canAsk && view.capId && (
          <Button size="sm" variant="outline" className="max-md:min-h-[44px]" onClick={onAsk}>
            Ask for more…
          </Button>
        )}
        <Link href="/insights/ai" className="inline-flex h-8 items-center rounded-[10px] px-2 text-[12.5px] text-ac hover:underline max-md:min-h-[44px]">
          See it on Insights → AI
        </Link>
      </div>
    </Card>
    </div>
  );
}

function AskDialog({ view, onClose }: { view: ProjectBudgetView; onClose: () => void }) {
  const current = view.budget?.monthlyUsd ?? 0;
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const n = Number(amount);
  const valid = amount.trim() !== '' && Number.isFinite(n) && n > current && reason.trim().length > 0;
  const send = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await askForMore(view.capId!, n, reason.trim());
      toast.success('Asked for more');
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Ask for more"
      subtitle={`The budget is ${formatUsd(current)} a month now. An admin decides.`}
      width={440}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void send()} loading={busy} disabled={!valid}>
            Send request
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <FieldLabel>New monthly budget (USD)</FieldLabel>
          <Input type="number" inputMode="decimal" min={0} step="any" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus placeholder={`More than ${current}`} />
        </div>
        <div>
          <FieldLabel>Why</FieldLabel>
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="What the extra is for" />
        </div>
        {error && <p className="text-[12px] text-rd">{error}</p>}
      </div>
    </Dialog>
  );
}

export function ProjectBudgetCard({ projectId }: { projectId: string }) {
  const [view, setView] = useState<ProjectBudgetView>();
  const [members, setMembers] = useState<ProjectMemberView[]>([]);
  const [fields, setFields] = useState<BudgetFields>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [asking, setAsking] = useState(false);
  const [failed, setFailed] = useState(false);
  const show = (next: ProjectBudgetView) => {
    setView(next);
    setFields(fieldsFrom(next));
    setError(undefined);
  };
  // An incident action or a save may resolve incidents, so the shared Needs you list reloads too.
  const changed = (next: ProjectBudgetView) => {
    show(next);
    refreshNeedsYou();
  };
  useEffect(() => {
    fetchBudget(projectId)
      .then(show)
      .catch(() => setFailed(true));
    api<{ project: ProjectDetail }>(`/api/projects/${encodeURIComponent(projectId)}`)
      .then((r) => setMembers(r.project.members))
      .catch(() => undefined);
  }, [projectId]);
  useScrollToHash('budget', Boolean(view) || failed);
  if (failed) return null;
  if (!view || !fields) return <div id="budget" className="scroll-mt-[72px] max-md:scroll-mt-[200px]"><Card className="h-24 animate-pulse-soft">{null}</Card></div>;

  const save = async () => {
    const parsed = budgetInput(fields);
    if ('error' in parsed) return setError(parsed.error);
    if (parsed.input.monthlyUsd === 0 && view.budget && !(await confirmAction('Remove the budget? Nothing will be watched or stopped for this project.', { action: 'Remove', danger: true }))) return;
    setSaving(true);
    try {
      changed(await saveBudget(projectId, parsed.input));
      toast.success('AI budget saved');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <ProjectBudgetCardView projectId={projectId} view={view} members={members} fields={fields} onFields={setFields} onSave={() => void save()} saving={saving} error={error} onView={changed} onAsk={() => setAsking(true)} />
      {asking && <AskDialog view={view} onClose={() => setAsking(false)} />}
    </>
  );
}
