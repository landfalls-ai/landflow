'use client';
/**
 * Settings → Environments (owners and admins). The instance is one environment (LANDFLOW_ENVIRONMENT), with its own
 * Git branch (Settings → Source control). Here: protect it (workflows read-only; changes arrive only by pull or
 * promotion), name the other environments' branches, choose what a pull does with publication, map credential names
 * the files use to this instance's credentials, choose the data tables whose rows promotion copies and the
 * `$secrets` references promoted credentials' secret fields get, promote this environment's branch to another one
 * (all or some workflows, with the credentials' definitions and the opted-in tables' rows, a diff preview and
 * conflict detection; with four-eyes on, a request someone else approves here) and pull this environment's branch.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDownToLine, Check, ChevronDown, ChevronRight, GitMerge, KeyRound, Layers, Lock, Plus, Rocket, Save, Table2, Trash2, TriangleAlert, Undo2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/client/api';
import type { CredentialMapping, CredentialSecretMapping, EnvironmentView, PromotionEntry, PromotionRequestedResponse, PromotionRequestView, PromotionResult, PullPublishMode } from '@/lib/shared/secrets';
import type { SourceControlPullResult } from '@/lib/shared/sync';
import type { DataTableSummary } from '@/lib/shared/data-tables';
import type { WorkflowSummary } from '@/lib/shared/types';
import { useCredentials } from '@/components/credentials/use-credentials';
import { Card } from '@/components/shell/page-header';
import { Badge, type Tone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FieldLabel, Input, SectionLabel, Select, Switch } from '@/components/ui/inputs';

const PUBLISH_LABELS: Record<PullPublishMode, string> = {
  file: 'Follow each file (publish workflows that are active in the branch)',
  all: 'Publish every pulled workflow',
  none: 'Save drafts only (publish by hand)',
};
const STATUS_TONES: Record<PromotionEntry['status'], Tone> = { added: 'success', modified: 'accent', unchanged: 'muted', deleted: 'warning' };
const FILE_TONES: Record<'A' | 'M' | 'D', Tone> = { A: 'success', M: 'accent', D: 'warning' };
const FILE_LABELS: Record<'A' | 'M' | 'D', string> = { A: 'added', M: 'modified', D: 'deleted' };
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A unified diff, colored by line. */
export function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="max-h-80 overflow-auto rounded-md border border-hair bg-sf px-2 py-1.5 font-mono text-[11px] leading-[1.45]">
      {diff.split('\n').map((line, i) => (
        <div key={i} className={line.startsWith('+') && !line.startsWith('+++') ? 'text-gn' : line.startsWith('-') && !line.startsWith('---') ? 'text-rd' : line.startsWith('@@') ? 'text-ac' : 'text-t3'}>
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}

function EntryRow({ entry }: { entry: PromotionEntry }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="py-1.5">
      <div className="flex items-center gap-2 text-[13px]">
        <button className="flex min-w-0 items-center gap-2 text-left disabled:cursor-default" onClick={() => setOpen(!open)} disabled={!entry.diff} aria-expanded={open}>
          {entry.diff ? open ? <ChevronDown className="size-3.5 text-t3" /> : <ChevronRight className="size-3.5 text-t3" /> : <span className="w-3.5" />}
          <Badge tone={entry.conflict ? 'danger' : STATUS_TONES[entry.status]}>{entry.conflict ? 'conflict' : entry.status}</Badge>
          <span className="min-w-0 truncate text-t1">{entry.name}</span>
        </button>
        <span className="ml-auto truncate text-[12px] text-t3">{entry.conflict ?? entry.fields?.join(', ')}</span>
      </div>
      {open && entry.diff && (
        <div className="mt-1.5 pl-6">
          <DiffView diff={entry.diff} />
        </div>
      )}
    </li>
  );
}

function FileRow({ file }: { file: PromotionResult['files'][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="py-1">
      <button className="flex min-w-0 items-center gap-2 text-left text-[12px] disabled:cursor-default" onClick={() => setOpen(!open)} disabled={!file.diff} aria-expanded={open}>
        {file.diff ? open ? <ChevronDown className="size-3.5 text-t3" /> : <ChevronRight className="size-3.5 text-t3" /> : <span className="w-3.5" />}
        <Badge tone={FILE_TONES[file.status]}>{FILE_LABELS[file.status]}</Badge>
        <span className="min-w-0 truncate font-mono text-t2">{file.path}</span>
      </button>
      {open && file.diff && (
        <div className="mt-1.5 pl-6">
          <DiffView diff={file.diff} />
        </div>
      )}
    </li>
  );
}

function Promotion({ result }: { result: PromotionResult }) {
  const changed = result.entries.filter((e) => e.status !== 'unchanged');
  const credentials = result.credentials ?? [];
  const tables = result.tables ?? [];
  const unchanged = result.entries.length - changed.length;
  return (
    <div className="mt-3 rounded-[10px] border border-hair px-3 py-2">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-[12px] text-t3">
        <span>
          {result.from.branch} ({result.from.commit.slice(0, 7)}) → {result.to.branch}
          {result.to.commit ? ` (${result.to.commit.slice(0, 7)})` : ' (new branch)'}
        </span>
        {result.conflicts > 0 && (
          <span className="flex items-center gap-1 text-rd">
            <TriangleAlert className="size-3" /> {plural(result.conflicts, 'conflict')}
          </span>
        )}
        {result.promoted && result.commit && <Badge tone="success">Promoted {result.commit.slice(0, 7)}</Badge>}
      </div>
      {changed.length ? (
        <ul className="divide-y divide-hair">
          {changed.map((entry) => (
            <EntryRow key={entry.id} entry={entry} />
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-t2">No workflow changes.</p>
      )}
      {unchanged > 0 && <p className="mt-1 text-[12px] text-t3">{plural(unchanged, 'workflow')} unchanged</p>}
      {credentials.length > 0 && (
        <div className="mt-2">
          <div className="mb-0.5 flex items-center gap-1.5 text-[12px] font-semibold text-t2">
            <KeyRound className="size-3.5 text-t3" /> Credential definitions (secret values never travel)
          </div>
          <ul className="divide-y divide-hair">
            {credentials.map((c) => {
              const empty = c.secretFields.filter((f) => !c.mapped.includes(f));
              return (
                <li key={`${c.type}:${c.name}`} className="flex items-center gap-2 py-1 text-[13px]">
                  <Badge tone={STATUS_TONES[c.status]}>{c.status}</Badge>
                  <span className="min-w-0 truncate text-t1">{c.name}</span>
                  <span className="text-[12px] text-t3">{c.type}</span>
                  <span className="ml-auto truncate text-[12px] text-t3">
                    {[c.mapped.length > 0 && `$secrets: ${c.mapped.join(', ')}`, empty.length > 0 && `empty in ${result.to.environment}: ${empty.join(', ')}`].filter(Boolean).join(' · ')}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {tables.length > 0 && (
        <div className="mt-2">
          <div className="mb-0.5 flex items-center gap-1.5 text-[12px] font-semibold text-t2">
            <Table2 className="size-3.5 text-t3" /> Data table rows (replace the target’s on pull)
          </div>
          <ul className="divide-y divide-hair">
            {tables.map((t) => (
              <li key={t.id} className="flex items-center gap-2 py-1 text-[13px]">
                <Badge tone={STATUS_TONES[t.status]}>{t.status}</Badge>
                <span className="min-w-0 truncate text-t1">{t.name}</span>
                <span className="ml-auto text-[12px] text-t3">{plural(t.rows, 'row')}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.files.length > 0 && (
        <ul className="mt-2 divide-y divide-hair">
          {result.files.map((f) => (
            <FileRow key={f.path} file={f} />
          ))}
        </ul>
      )}
      {result.warnings.map((w) => (
        <p key={w} className="mt-1 text-[12px] text-t3">
          {w}
        </p>
      ))}
    </div>
  );
}

function PromoteCard({ view, onRequested }: { view: EnvironmentView; onRequested: () => void }) {
  const targets = view.environments.filter((e) => !e.current);
  const [target, setTarget] = useState(() => {
    const index = view.environments.findIndex((e) => e.current);
    return view.environments[index + 1]?.name ?? targets[0]?.name ?? '';
  });
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [all, setAll] = useState(true);
  const [prune, setPrune] = useState(false);
  const [withCredentials, setWithCredentials] = useState(true);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<'preview' | 'promote'>();
  const [result, setResult] = useState<PromotionResult>();

  useEffect(() => {
    api<{ workflows: WorkflowSummary[] }>('/api/workflows')
      .then((r) => setWorkflows(r.workflows))
      .catch(() => setWorkflows([]));
  }, []);

  const run = async (dryRun: boolean, force = false) => {
    setBusy(dryRun ? 'preview' : 'promote');
    try {
      const body = { target, dryRun, force, prune: all && prune, credentials: withCredentials, ...(!all && { workflows: picked }), ...(message.trim() && { message: message.trim() }) };
      const next = await api<PromotionResult | PromotionRequestedResponse>('/api/environment/promote', { method: 'POST', json: body });
      if ('approvalRequired' in next) {
        // Four-eyes: a request for someone else to approve (below).
        setResult(undefined);
        toast.success(`Promotion to ${next.request.target} is waiting for approval by another owner or admin`);
        onRequested();
        return;
      }
      setResult(next);
      if (!dryRun) toast.success(next.promoted ? `Promoted to ${next.to.environment} (${next.commit?.slice(0, 7)}): pull there to apply` : 'Nothing to promote');
    } catch (e) {
      const body = (e as ApiError).body as PromotionResult | undefined;
      if (body?.entries) setResult(body);
      toast.error((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  if (!targets.length) return null;
  return (
    <Card className="px-5 py-4">
      <div className="mb-3 flex items-center gap-2">
        <Rocket className="size-4 text-t3" strokeWidth={1.8} />
        <SectionLabel>Promote</SectionLabel>
        <span className="ml-auto text-[12px] text-t3">Push first: promotion copies what {view.branch ?? 'this branch'} holds in the repository</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <FieldLabel>To</FieldLabel>
          <Select value={target} onChange={(e) => (setTarget(e.target.value), setResult(undefined))}>
            {targets.map((e) => (
              <option key={e.name} value={e.name}>
                {e.name} ({e.branch})
              </option>
            ))}
          </Select>
        </div>
        <div>
          <FieldLabel>Commit message</FieldLabel>
          <Input value={message} onChange={(e) => setMessage(e.target.value)} placeholder={`Promote from ${view.name}`} />
        </div>
        <div className="flex items-center gap-2 sm:col-span-2">
          <Switch checked={all} onChange={(v) => (setAll(v), setResult(undefined))} label="All workflows" />
          <span className="text-[13px] text-t2">All workflows (with folders and data table schemas)</span>
          {all && (
            <span className="ml-4 flex items-center gap-2">
              <Switch checked={prune} onChange={setPrune} label="Remove missing" />
              <span className="text-[13px] text-t2">Remove workflows {view.name} doesn’t have</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 sm:col-span-2">
          <Switch checked={withCredentials} onChange={(v) => (setWithCredentials(v), setResult(undefined))} label="Credential definitions" />
          <span className="text-[13px] text-t2">
            Credential definitions: name, type and non-secret fields of the credentials they use (secret fields stay empty, or take their $secrets mapping)
            {view.rowTables.length > 0 && `; rows of ${view.rowTables.map((t) => t.name ?? t.id).join(', ')}`}
          </span>
        </div>
        {!all && (
          <div className="max-h-56 overflow-y-auto rounded-[10px] border border-hair px-3 py-2 sm:col-span-2">
            {workflows.map((w) => (
              <label key={w.id} className="flex items-center gap-2 py-0.5 text-[13px] text-t1">
                <input type="checkbox" checked={picked.includes(w.id)} onChange={(e) => (setPicked((p) => (e.target.checked ? [...p, w.id] : p.filter((id) => id !== w.id))), setResult(undefined))} />
                <span className="truncate">{w.name}</span>
              </label>
            ))}
            {!workflows.length && <p className="text-[13px] text-t3">No workflows.</p>}
          </div>
        )}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button onClick={() => run(true)} loading={busy === 'preview'} disabled={!target || (!all && !picked.length)}>
          <GitMerge className="size-3.5" /> Preview
        </Button>
        <Button variant="primary" onClick={() => run(false)} loading={busy === 'promote'} disabled={!result?.dryRun || result.conflicts > 0}>
          <Rocket className="size-3.5" /> Promote to {target}
        </Button>
        {result?.dryRun && result.conflicts > 0 && (
          <Button variant="danger" onClick={() => run(false, true)} loading={busy === 'promote'}>
            Promote anyway, overwriting {result.to.branch}’s changes
          </Button>
        )}
      </div>
      {result && <Promotion result={result} />}
    </Card>
  );
}

const REQUEST_TONES: Record<PromotionRequestView['status'], Tone> = { pending: 'warning', approved: 'success', rejected: 'danger', canceled: 'muted', stale: 'muted', failed: 'danger' };

function RequestRow({ request, onChanged }: { request: PromotionRequestView; onChanged: () => void }) {
  const [open, setOpen] = useState(request.status === 'pending');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | 'cancel'>();
  const decide = async (verb: 'approve' | 'reject' | 'cancel') => {
    setBusy(verb);
    try {
      const result = await api<{ request: PromotionRequestView; result?: PromotionResult }>(`/api/environment/promotion-requests/${encodeURIComponent(request.id)}/${verb}`, {
        method: 'POST',
        json: verb === 'cancel' ? {} : { comment: comment.trim() || undefined },
      });
      toast.success(verb === 'approve' ? `Promoted to ${request.target} (${result.result?.commit?.slice(0, 7)}): pull there to apply` : verb === 'reject' ? 'Rejected' : 'Withdrawn');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(undefined);
      onChanged();
    }
  };
  const who = request.requestedByName ?? request.requestedBy;
  return (
    <li className="py-2">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <button className="flex min-w-0 items-center gap-2 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? <ChevronDown className="size-3.5 text-t3" /> : <ChevronRight className="size-3.5 text-t3" />}
          <Badge tone={REQUEST_TONES[request.status]}>{request.status}</Badge>
          <span className="text-t1">
            {request.source} → {request.target}
          </span>
          <span className="text-t3">
            {request.workflows?.length ? plural(request.workflows.length, 'workflow') : 'all workflows'} · {who} · {new Date(request.requestedAt).toLocaleString()}
          </span>
        </button>
        <span className="ml-auto truncate text-[12px] text-t3">{request.reason ?? request.comment ?? request.message ?? (request.commit && `promoted ${request.commit.slice(0, 7)}`)}</span>
      </div>
      {open && (
        <div className="pl-6">
          <Promotion result={request.preview} />
          {request.status === 'pending' && (request.canApprove || request.canCancel) && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {request.canApprove && (
                <>
                  <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Comment (optional)" className="max-w-[320px]" aria-label="Comment" />
                  <Button size="sm" variant="primary" onClick={() => decide('approve')} loading={busy === 'approve'}>
                    <Check className="size-3.5" /> Approve and promote
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => decide('reject')} loading={busy === 'reject'}>
                    <X className="size-3.5" /> Reject
                  </Button>
                </>
              )}
              {request.canCancel && !request.canApprove && (
                <Button size="sm" variant="ghost" onClick={() => decide('cancel')} loading={busy === 'cancel'}>
                  <Undo2 className="size-3.5" /> Withdraw
                </Button>
              )}
              {!request.canApprove && <span className="text-[12px] text-t3">Another owner or admin approves it</span>}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** Four-eyes on promotion: pending requests (approve, reject, withdraw) and the recent decisions. */
function PromotionRequestsCard({ version }: { version: number }) {
  const [requests, setRequests] = useState<PromotionRequestView[]>();
  const [fourEyes, setFourEyes] = useState(false);
  const load = useCallback(() => {
    api<{ requests: PromotionRequestView[]; fourEyes: boolean }>('/api/environment/promotion-requests?status=all&limit=20')
      .then((r) => (setRequests(r.requests), setFourEyes(r.fourEyes)))
      .catch(() => setRequests([]));
  }, []);
  useEffect(() => load(), [load, version]);
  if (!requests || (!fourEyes && !requests.some((r) => r.status === 'pending'))) return null;
  const pending = requests.filter((r) => r.status === 'pending');
  return (
    <Card className="px-5 py-4">
      <div className="mb-1 flex items-center gap-2">
        <Rocket className="size-4 text-t3" strokeWidth={1.8} />
        <SectionLabel>Promotion requests</SectionLabel>
        <span className="ml-auto text-[12px] text-t3">Four-eyes (Settings → Governance): another owner or admin approves each promotion</span>
      </div>
      {requests.length ? (
        <ul className="divide-y divide-hair">
          {[...pending, ...requests.filter((r) => r.status !== 'pending')].map((r) => (
            <RequestRow key={r.id} request={r} onChanged={load} />
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-t3">No promotion requests yet.</p>
      )}
    </Card>
  );
}

function PullCard({ view }: { view: EnvironmentView }) {
  const [publish, setPublish] = useState<PullPublishMode>(view.publishOnPull);
  const [prune, setPrune] = useState(false);
  const [busy, setBusy] = useState<'preview' | 'pull'>();
  const [preview, setPreview] = useState<SourceControlPullResult>();
  const pull = async (dryRun: boolean, force = false) => {
    setBusy(dryRun ? 'preview' : 'pull');
    try {
      const result = await api<SourceControlPullResult>('/api/environment/pull', { method: 'POST', json: { dryRun, prune, force, publish } });
      setPreview(dryRun ? result : undefined);
      if (!dryRun) toast.success(result.appliedCount ? `Applied ${plural(result.appliedCount, 'change')} from ${result.commit.slice(0, 7)}` : 'Already up to date');
    } catch (e) {
      const body = (e as ApiError).body as SourceControlPullResult | undefined;
      if (body?.changes) setPreview(body);
      toast.error((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <Card className="px-5 py-4">
      <div className="mb-3 flex items-center gap-2">
        <ArrowDownToLine className="size-4 text-t3" strokeWidth={1.8} />
        <SectionLabel>Pull {view.branch}</SectionLabel>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[260px] flex-1">
          <FieldLabel>Publication</FieldLabel>
          <Select value={publish} onChange={(e) => setPublish(e.target.value as PullPublishMode)}>
            {(Object.keys(PUBLISH_LABELS) as PullPublishMode[]).map((mode) => (
              <option key={mode} value={mode}>
                {PUBLISH_LABELS[mode]}
              </option>
            ))}
          </Select>
        </div>
        <span className="flex items-center gap-2 pb-1.5">
          <Switch checked={prune} onChange={setPrune} label="Delete missing" />
          <span className="text-[13px] text-t2">Delete missing</span>
        </span>
        <span className="flex gap-2">
          <Button onClick={() => pull(true)} loading={busy === 'preview'}>
            Preview pull
          </Button>
          <Button variant="primary" onClick={() => pull(false)} loading={busy === 'pull'}>
            <ArrowDownToLine className="size-3.5" /> Pull
          </Button>
        </span>
      </div>
      {preview && (
        <div className="mt-3 rounded-[10px] border border-hair px-3 py-2 text-[13px]">
          {preview.changes.length ? (
            <ul className="divide-y divide-hair">
              {preview.changes.map((c) => (
                <li key={`${c.kind}:${c.id}:${c.action}`} className="flex items-center gap-2 py-1">
                  <Badge tone={c.conflict ? 'danger' : c.action === 'delete' ? 'warning' : c.action === 'create' ? 'success' : 'accent'}>{c.action}</Badge>
                  <span className="text-t3">{c.kind}</span>
                  <span className="min-w-0 truncate text-t1">{c.name}</span>
                  <span className="ml-auto truncate text-[12px] text-t3">{c.conflict ?? c.fields?.join(', ')}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-t2">Nothing to change: the instance matches the branch.</p>
          )}
          {[...preview.errors, ...preview.warnings].map((w) => (
            <p key={w} className="mt-1 text-[12px] text-t3">
              {w}
            </p>
          ))}
          {preview.conflicts > 0 && (
            <Button variant="danger" size="sm" className="mt-2" onClick={() => pull(false, true)} loading={busy === 'pull'}>
              Pull anyway, overwriting the edits made here
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

interface Draft {
  protected: boolean;
  environments: string;
  branches: Record<string, string>;
  publishOnPull: PullPublishMode;
  credentialMap: CredentialMapping[];
  rowTables: string[];
  secretMappings: CredentialSecretMapping[];
}

const draftOf = (view: EnvironmentView): Draft => ({
  protected: view.protectedSource === 'settings' ? view.protected : false,
  environments: view.environments.map((e) => e.name).join(', '),
  branches: Object.fromEntries(view.environments.filter((e) => !e.current).map((e) => [e.name, e.branch])),
  publishOnPull: view.publishOnPull,
  credentialMap: view.credentialMap.map(({ type, name, credentialId }) => ({ type, name, credentialId })),
  rowTables: view.rowTables.map((t) => t.id),
  secretMappings: view.secretMappings.map((m) => ({ ...m })),
});

export function EnvironmentsSettings() {
  const [view, setView] = useState<EnvironmentView>();
  const [draft, setDraft] = useState<Draft>();
  const [error, setError] = useState<string>();
  const { credentials: credentialList, types: credentialTypes } = useCredentials();
  const creds = useMemo(() => credentialList ?? [], [credentialList]);
  const [tables, setTables] = useState<DataTableSummary[]>([]);
  const [saving, setSaving] = useState(false);
  const [requests, setRequests] = useState(0);

  useEffect(() => {
    api<EnvironmentView>('/api/environment')
      .then((v) => (setView(v), setDraft(draftOf(v))))
      .catch((e: Error) => setError(e.message));
    api<{ tables: DataTableSummary[] }>('/api/data-tables')
      .then((r) => setTables(r.tables))
      .catch(() => setTables([]));
  }, []);
  const types = useMemo(() => [...new Set(creds.map((c) => c.type))].sort(), [creds]);
  /** The secret (password) fields of a credential type, by its descriptor. */
  const secretFieldsOf = (type: string) => credentialTypes?.find((t) => t.type === type)?.descriptor.properties.filter((p) => p.typeOptions?.password).map((p) => p.name) ?? [];

  if (!view || !draft) {
    return error ? <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div> : <div className="h-56 rounded-2xl border border-hair bg-sf animate-pulse-soft" />;
  }
  if (!view.name) {
    return (
      <Card className="px-5 py-4 text-[13px] text-t2">
        <div className="mb-2 flex items-center gap-2">
          <Layers className="size-4 text-t3" strokeWidth={1.8} />
          <SectionLabel>No environment</SectionLabel>
        </div>
        <p>
          This instance isn’t an environment. Start it with <code className="font-mono text-[12px]">LANDFLOW_ENVIRONMENT=development</code> (or staging, production, …) and give each environment its own
          branch in Settings → Source control; then promote workflows from one environment’s branch to the next and pull them there, with that environment’s credentials, variables and
          external secrets. <code className="font-mono text-[12px]">LANDFLOW_ENVIRONMENT_PROTECTED=true</code> makes workflows read-only there.
        </p>
      </Card>
    );
  }

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => d && { ...d, [key]: value });
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(view));
  const save = async () => {
    setSaving(true);
    try {
      const environments = draft.environments
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean);
      const next = await api<EnvironmentView>('/api/environment', {
        method: 'PUT',
        json: {
          ...(view.protectedSource !== 'env' && { protected: draft.protected }),
          environments,
          branches: Object.fromEntries(Object.entries(draft.branches).filter(([name, branch]) => environments.includes(name) && branch.trim())),
          publishOnPull: draft.publishOnPull,
          credentialMap: draft.credentialMap.filter((m) => m.type && m.name.trim() && m.credentialId),
          rowTables: draft.rowTables,
          secretMappings: draft.secretMappings.filter((m) => m.type && m.name && m.field.trim() && m.value.trim()).map((m) => ({ ...m, ...(!m.environment && { environment: undefined }) })),
        },
      });
      setView(next);
      setDraft(draftOf(next));
      toast.success('Environment settings saved');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const others = draft.environments
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e && e !== view.name);
  return (
    <div className="space-y-4">
      <Card className="px-5 py-4">
        <div className="mb-3 flex items-center gap-2">
          <Layers className="size-4 text-t3" strokeWidth={1.8} />
          <SectionLabel>This environment</SectionLabel>
          <span className="ml-auto flex items-center gap-2">
            <Badge tone="accent">{view.name}</Badge>
            {view.protected && (
              <Badge tone="warning">
                <Lock className="size-3" /> Protected
              </Badge>
            )}
          </span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex items-center gap-2 sm:col-span-2">
            <Switch checked={view.protectedSource === 'env' ? view.protected : draft.protected} onChange={(v) => set('protected', v)} disabled={view.protectedSource === 'env'} label="Protected" />
            <span className="text-[13px] text-t2">
              Protected: workflows are read-only here and change only by pull or promotion
              {view.protectedSource === 'env' && ' (set by LANDFLOW_ENVIRONMENT_PROTECTED)'}
            </span>
          </div>
          <div>
            <FieldLabel>Branch</FieldLabel>
            <Input value={view.branch ?? '(set up Settings → Source control)'} disabled />
          </div>
          <div>
            <FieldLabel>Environments, in promotion order</FieldLabel>
            <Input value={draft.environments} onChange={(e) => set('environments', e.target.value)} placeholder="development, staging, production" spellCheck={false} />
          </div>
          {others.map((name) => (
            <div key={name}>
              <FieldLabel>{name} branch</FieldLabel>
              <Input value={draft.branches[name] ?? name} onChange={(e) => set('branches', { ...draft.branches, [name]: e.target.value })} spellCheck={false} />
            </div>
          ))}
          <div className="sm:col-span-2">
            <FieldLabel>When this environment pulls</FieldLabel>
            <Select value={draft.publishOnPull} onChange={(e) => set('publishOnPull', e.target.value as PullPublishMode)}>
              {(Object.keys(PUBLISH_LABELS) as PullPublishMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {PUBLISH_LABELS[mode]}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="mt-4 border-t border-hair pt-3">
          <div className="mb-1 flex items-center gap-2">
            <SectionLabel>Credential mapping</SectionLabel>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => set('credentialMap', [...draft.credentialMap, { type: types[0] ?? '', name: '', credentialId: '' }])} disabled={!types.length}>
              <Plus className="size-3.5" /> Add mapping
            </Button>
          </div>
          <p className="mb-2 text-[12px] text-t3">Pulled workflows use this instance’s credential of the same name and type; map the names that differ here.</p>
          {draft.credentialMap.map((mapping, index) => {
            const update = (change: Partial<CredentialMapping>) => set('credentialMap', draft.credentialMap.map((m, i) => (i === index ? { ...m, ...change } : m)));
            return (
              <div key={index} className="mb-2 grid grid-cols-[1fr_1fr_1fr_auto] items-center gap-2">
                <Select value={mapping.type} onChange={(e) => update({ type: e.target.value, credentialId: '' })} aria-label="Credential type">
                  {types.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
                <Input value={mapping.name} onChange={(e) => update({ name: e.target.value })} placeholder="Name in the files" aria-label="Name in the files" />
                <Select value={mapping.credentialId} onChange={(e) => update({ credentialId: e.target.value })} aria-label="This instance's credential">
                  <option value="">Choose a credential</option>
                  {creds
                    .filter((c) => c.type === mapping.type)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </Select>
                <Button variant="ghost" size="icon-sm" onClick={() => set('credentialMap', draft.credentialMap.filter((_, i) => i !== index))} aria-label="Remove mapping">
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            );
          })}
        </div>
        <div className="mt-4 border-t border-hair pt-3">
          <SectionLabel>Promoted data table rows</SectionLabel>
          <p className="mb-2 mt-1 text-[12px] text-t3">
            Promotion copies these tables’ rows from this instance; the target’s pull replaces the table’s rows with them. Schemas travel with “All workflows” either way.
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {tables.map((t) => (
              <label key={t.id} className="flex items-center gap-2 text-[13px] text-t1">
                <input
                  type="checkbox"
                  checked={draft.rowTables.includes(t.id)}
                  onChange={(e) => set('rowTables', e.target.checked ? [...draft.rowTables, t.id] : draft.rowTables.filter((id) => id !== t.id))}
                />
                {t.name}
              </label>
            ))}
            {!tables.length && <span className="text-[13px] text-t3">No data tables.</span>}
          </div>
        </div>

        <div className="mt-4 border-t border-hair pt-3">
          <div className="mb-1 flex items-center gap-2">
            <SectionLabel>Secrets for promoted credentials</SectionLabel>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto"
              onClick={() => set('secretMappings', [...draft.secretMappings, { type: creds[0]?.type ?? '', name: creds[0]?.name ?? '', field: secretFieldsOf(creds[0]?.type ?? '')[0] ?? '', value: '' }])}
              disabled={!creds.length}
            >
              <Plus className="size-3.5" /> Add secret mapping
            </Button>
          </div>
          <p className="mb-2 text-[12px] text-t3">
            A promoted credential’s secret fields stay empty in the target; map one to a <code className="font-mono">{'{{ $secrets.<provider>.<name>.<key> }}'}</code> reference the target resolves with its own
            providers.
          </p>
          {draft.secretMappings.map((mapping, index) => {
            const update = (change: Partial<CredentialSecretMapping>) => set('secretMappings', draft.secretMappings.map((m, i) => (i === index ? { ...m, ...change } : m)));
            const fields = secretFieldsOf(mapping.type);
            return (
              <div key={index} className="mb-2 grid grid-cols-[1.2fr_0.8fr_1.6fr_0.8fr_auto] items-center gap-2">
                <Select
                  value={`${mapping.type}\u0000${mapping.name}`}
                  onChange={(e) => {
                    const [type, name] = e.target.value.split('\u0000');
                    update({ type, name, field: secretFieldsOf(type)[0] ?? '' });
                  }}
                  aria-label="Credential"
                >
                  {!creds.some((c) => c.type === mapping.type && c.name === mapping.name) && <option value={`${mapping.type}\u0000${mapping.name}`}>{mapping.name || 'Choose a credential'}</option>}
                  {creds.map((c) => (
                    <option key={c.id} value={`${c.type}\u0000${c.name}`}>
                      {c.name}
                    </option>
                  ))}
                </Select>
                {fields.length ? (
                  <Select value={mapping.field} onChange={(e) => update({ field: e.target.value })} aria-label="Secret field">
                    {!fields.includes(mapping.field) && <option value={mapping.field}>{mapping.field || 'Field'}</option>}
                    {fields.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input value={mapping.field} onChange={(e) => update({ field: e.target.value })} placeholder="Secret field" aria-label="Secret field" spellCheck={false} />
                )}
                <Input value={mapping.value} onChange={(e) => update({ value: e.target.value })} placeholder="{{ $secrets.vault.api.key }}" aria-label="$secrets reference" spellCheck={false} className="font-mono text-[12px]" />
                <Select value={mapping.environment ?? ''} onChange={(e) => update({ environment: e.target.value || undefined })} aria-label="Target environment">
                  <option value="">Every target</option>
                  {others.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </Select>
                <Button variant="ghost" size="icon-sm" onClick={() => set('secretMappings', draft.secretMappings.filter((_, i) => i !== index))} aria-label="Remove secret mapping">
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            );
          })}
        </div>
        <div className="mt-4">
          <Button variant="primary" onClick={save} loading={saving} disabled={!dirty}>
            <Save className="size-3.5" /> Save
          </Button>
        </div>
      </Card>
      {view.sourceControl ? (
        <>
          <PromoteCard view={view} onRequested={() => setRequests((n) => n + 1)} />
          <PromotionRequestsCard version={requests} />
          <PullCard view={view} />
        </>
      ) : (
        <Card className="px-5 py-4 text-[13px] text-t2">Connect a repository in Settings → Source control to promote and pull.</Card>
      )}
    </div>
  );
}
