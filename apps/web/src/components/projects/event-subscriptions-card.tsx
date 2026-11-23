'use client';
/**
 * A project's Settings tab → "Event subscriptions" (docs/features/event-subscriptions.md): webhooks that receive the run
 * events of the project's workflows. Members see the list with each subscription's state (Delivering, a backlog, Failing
 * with the last error, Disabled with why, events given up on); the project's admins add, edit, delete, send a test and
 * "Retry now". The signing secret is shown once, when a subscription is made or its secret replaced.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import { RUN_EVENT_LABELS, RUN_EVENT_TYPES, subscriptionState, type EventSubscriptionInput, type EventSubscriptionView, type RunEventType } from '@/lib/shared/event-subscriptions';
import { Card } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { confirmAction } from '@/components/ui/confirm';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, FieldLabel, Input, Switch, Textarea } from '@/components/ui/inputs';

const TONES = { ok: 'success', warn: 'warning', danger: 'danger', muted: 'muted' } as const;

/** The host of a URL: a path or a query may carry a token, so the card never shows more. */
const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** The signing secret, shown once with Copy. */
export function SecretNotice({ secret }: { secret: string }) {
  return (
    <div className="rounded-lg border border-hair bg-nudim p-3">
      <p className="text-[12px] text-t2">This is the signing secret. It is shown once, only now; copy it now and keep it where your receiver can read it. If you lose it, make a new one.</p>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-md bg-sf px-2 py-1.5 font-mono text-[12px] text-t1">{secret}</code>
        <CopyButton text={secret} label="Copy" />
      </div>
    </div>
  );
}

/** The card without its data fetching, for the page and for tests. */
export function EventSubscriptionsCardView({
  subscriptions,
  canEdit,
  onAdd,
  onEdit,
  onDelete,
  onRetry,
  onTest,
  busy,
}: {
  subscriptions: EventSubscriptionView[];
  canEdit: boolean;
  projectId: string;
  onAdd?: () => void;
  onEdit?: (subscription: EventSubscriptionView) => void;
  onDelete?: (subscription: EventSubscriptionView) => void;
  onRetry?: (subscription: EventSubscriptionView) => void;
  onTest?: (subscription: EventSubscriptionView) => void;
  busy?: string;
}) {
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-t1">Event subscriptions</div>
          <div className="text-[12px] text-t3">Send this project’s run events to a URL, signed, once at least, in order. Landflow tries again for 72 hours.</div>
        </div>
        {canEdit && (
          <Button variant="primary" size="sm" onClick={onAdd}>
            Add subscription
          </Button>
        )}
      </div>
      {!subscriptions.length ? (
        <p className="text-[13px] text-t3">No subscriptions yet.{canEdit ? ' Add one to be told when a run starts, finishes or fails.' : ''}</p>
      ) : (
        <ul className="divide-y divide-hair">
          {subscriptions.map((s) => {
            const state = subscriptionState(s);
            return (
              <li key={s.id} className="flex items-start gap-3 py-3 max-md:flex-col">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-semibold text-t1">{s.name}</span>
                    <Badge tone={TONES[state.tone]}>{state.label}</Badge>
                  </div>
                  <div className="font-mono text-[12px] text-t3">{hostOf(s.url)}</div>
                  <div className="flex flex-wrap gap-1.5">
                    {s.events.map((event) => (
                      <Badge key={event} tone="neutral">
                        {RUN_EVENT_LABELS[event]}
                      </Badge>
                    ))}
                    {s.nodeNames.length > 0 && <span className="text-[12px] text-t3">Steps: {s.nodeNames.join(', ')}</span>}
                  </div>
                  <div className="text-[12px] text-t3">
                    {s.lastDelivery ? `Last delivery ${timeAgo(s.lastDelivery.at)}${s.lastDelivery.status ? `, HTTP ${s.lastDelivery.status}` : ', not reached'}` : 'Nothing delivered yet'}
                    {s.backlog > 0 && ` · ${s.backlog} waiting, the oldest ${Math.max(1, Math.round(s.oldestAgeSeconds / 60))} min`}
                  </div>
                </div>
                {canEdit && (
                  <div className="flex shrink-0 flex-wrap gap-1.5">
                    {(s.backlog > 0 || s.dead > 0) && (
                      <Button size="sm" variant="outline" onClick={() => onRetry?.(s)} loading={busy === `retry:${s.id}`}>
                        Retry now
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => onTest?.(s)} loading={busy === `test:${s.id}`}>
                      Send test
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => onEdit?.(s)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => onDelete?.(s)}>
                      Delete
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

interface Fields {
  name: string;
  url: string;
  events: RunEventType[];
  nodeNames: string;
  workflowIds: string[];
  includeOutput: boolean;
  ordered: boolean;
}
const emptyFields: Fields = { name: '', url: '', events: ['run.failed'], nodeNames: '', workflowIds: [], includeOutput: false, ordered: true };
const fieldsOf = (s: EventSubscriptionView): Fields => ({ name: s.name, url: s.url, events: s.events, nodeNames: s.nodeNames.join('\n'), workflowIds: s.workflowIds ?? [], includeOutput: s.includeOutput, ordered: s.ordered });

function SubscriptionDialog({ projectId, editing, workflows, onClose, onSaved }: { projectId: string; editing?: EventSubscriptionView; workflows: Array<{ id: string; name: string }>; onClose: () => void; onSaved: (secret?: string) => void }) {
  const [fields, setFields] = useState<Fields>(editing ? fieldsOf(editing) : emptyFields);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const set = (patch: Partial<Fields>) => setFields((f) => ({ ...f, ...patch }));
  const nodes = fields.nodeNames.split(/[\n,]/).map((n) => n.trim()).filter(Boolean);
  const toggle = (event: RunEventType, on: boolean) => set({ events: on ? [...fields.events, event] : fields.events.filter((e) => e !== event) });
  const valid = fields.name.trim() && fields.url.trim() && fields.events.length > 0 && (!fields.events.includes('node.finished') || nodes.length > 0);
  const save = async () => {
    setBusy(true);
    setError(undefined);
    const input: EventSubscriptionInput = { name: fields.name.trim(), url: fields.url.trim(), events: RUN_EVENT_TYPES.filter((e) => fields.events.includes(e)), workflowIds: fields.workflowIds.length ? fields.workflowIds : null, nodeNames: nodes, includeOutput: fields.includeOutput, ordered: fields.ordered };
    try {
      const base = `/api/projects/${encodeURIComponent(projectId)}/event-subscriptions`;
      const answer = editing ? await api<{ secret?: string }>(`${base}/${editing.id}`, { method: 'PATCH', json: input }) : await api<{ secret: string }>(base, { method: 'POST', json: input });
      onSaved(answer.secret);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={editing ? 'Edit subscription' : 'Add subscription'}
      subtitle="Landflow sends each event to the URL as a signed POST."
      width={520}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={busy} disabled={!valid}>
            {editing ? 'Save' : 'Add subscription'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <FieldLabel>Name</FieldLabel>
          <Input value={fields.name} onChange={(e) => set({ name: e.target.value })} maxLength={120} autoFocus placeholder="Billing system" />
        </div>
        <div>
          <FieldLabel>URL</FieldLabel>
          <Input value={fields.url} onChange={(e) => set({ url: e.target.value })} maxLength={2000} inputMode="url" placeholder="https://example.com/hooks/landflow" />
        </div>
        <div>
          <FieldLabel>Send me an event when</FieldLabel>
          <div className="space-y-1">
            {RUN_EVENT_TYPES.map((event) => (
              <Checkbox key={event} checked={fields.events.includes(event)} onChange={(on) => toggle(event, on)} label={RUN_EVENT_LABELS[event]} />
            ))}
          </div>
        </div>
        {fields.events.includes('node.finished') && (
          <div>
            <FieldLabel>Steps (one name per line)</FieldLabel>
            <Textarea rows={2} value={fields.nodeNames} onChange={(e) => set({ nodeNames: e.target.value })} placeholder="Send invoice" />
            <p className="mt-1 text-[12px] text-t3">These events arrive after the run ends.</p>
          </div>
        )}
        {workflows.length > 0 && (
          <div>
            <FieldLabel>Workflows</FieldLabel>
            <p className="mb-1 text-[12px] text-t3">{fields.workflowIds.length ? 'Only the ones ticked.' : 'All of the project’s workflows. Tick some to narrow it.'}</p>
            <div className="max-h-36 space-y-1 overflow-y-auto">
              {workflows.map((w) => (
                <Checkbox key={w.id} checked={fields.workflowIds.includes(w.id)} onChange={(on) => set({ workflowIds: on ? [...fields.workflowIds, w.id] : fields.workflowIds.filter((id) => id !== w.id) })} label={w.name} />
              ))}
            </div>
          </div>
        )}
        <div className="space-y-2">
          {/* The Switch carries its words only as an aria-label, so the visible text sits beside it (as the MCP card does). */}
          <div className="flex items-center gap-2.5">
            <Switch checked={fields.includeOutput} onChange={(on) => set({ includeOutput: on })} label="Include the last step’s first 5 items" />
            <span className="text-[13px] font-semibold text-t1">Include the last step’s first 5 items</span>
          </div>
          <p className="text-[12px] text-t3">Off by default: events carry ids, status and times only. The items may hold personal or secret values a workflow produced.</p>
          <div className="flex items-center gap-2.5">
            <Switch checked={fields.ordered} onChange={(on) => set({ ordered: on })} label="Deliver one at a time, in order" />
            <span className="text-[13px] font-semibold text-t1">Deliver one at a time, in order</span>
          </div>
        </div>
        {error && <p className="text-[12px] text-rd">{error}</p>}
      </div>
    </Dialog>
  );
}

export function EventSubscriptionsCard({ projectId }: { projectId: string }) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/event-subscriptions`;
  const [data, setData] = useState<{ subscriptions: EventSubscriptionView[]; canEdit: boolean }>();
  const [workflows, setWorkflows] = useState<Array<{ id: string; name: string }>>([]);
  const [dialog, setDialog] = useState<{ editing?: EventSubscriptionView } | undefined>();
  const [secret, setSecret] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    api<{ subscriptions: EventSubscriptionView[]; canEdit: boolean }>(base, { background: true })
      .then(setData)
      .catch(() => setFailed(true));
  }, [base]);
  useEffect(() => {
    load();
    // The backlog and last delivery move on their own: look again every 15 s while the card is on screen.
    const timer = setInterval(load, 15_000);
    api<{ workflows: Array<{ id: string; name: string; ownership?: { projectId?: string } }> }>(`/api/workflows?projectId=${encodeURIComponent(projectId)}`)
      .then((r) => setWorkflows(r.workflows.filter((w) => !w.ownership?.projectId || w.ownership.projectId === projectId).map((w) => ({ id: w.id, name: w.name }))))
      .catch(() => undefined);
    return () => clearInterval(timer);
  }, [load, projectId]);
  if (failed) return null;
  if (!data) return <Card className="h-24 animate-pulse-soft">{null}</Card>;

  const act = async (key: string, run: () => Promise<void>) => {
    setBusy(key);
    try {
      await run();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <>
      <EventSubscriptionsCardView
        subscriptions={data.subscriptions}
        canEdit={data.canEdit}
        projectId={projectId}
        busy={busy}
        onAdd={() => setDialog({})}
        onEdit={(editing) => setDialog({ editing })}
        onDelete={(s) =>
          void act(`delete:${s.id}`, async () => {
            if (!(await confirmAction(`Remove “${s.name}”? Events still waiting for it are dropped.`, { action: 'Remove', danger: true }))) return;
            await api(`${base}/${s.id}`, { method: 'DELETE' });
            toast.success('Subscription removed');
            load();
          })
        }
        onRetry={(s) =>
          void act(`retry:${s.id}`, async () => {
            const { retried } = await api<{ retried: number }>(`${base}/${s.id}/retry`, { method: 'POST' });
            toast.success(retried ? `Trying ${retried} again now` : 'Nothing was waiting');
            load();
          })
        }
        onTest={(s) =>
          void act(`test:${s.id}`, async () => {
            const result = await api<{ ok: boolean; message: string }>(`${base}/${s.id}/test`, { method: 'POST' });
            if (result.ok) toast.success(result.message);
            else toast.error(result.message);
            load();
          })
        }
      />
      {dialog && (
        <SubscriptionDialog
          projectId={projectId}
          {...(dialog.editing && { editing: dialog.editing })}
          workflows={workflows}
          onClose={() => setDialog(undefined)}
          onSaved={(newSecret) => {
            setDialog(undefined);
            if (newSecret) setSecret(newSecret);
            else toast.success('Subscription saved');
            load();
          }}
        />
      )}
      {secret && (
        <Dialog title="Signing secret" subtitle="Your receiver uses it to check each event came from Landflow." width={480} onClose={() => setSecret(undefined)} footer={<Button variant="primary" onClick={() => setSecret(undefined)}>Done</Button>}>
          <SecretNotice secret={secret} />
        </Dialog>
      )}
    </>
  );
}
