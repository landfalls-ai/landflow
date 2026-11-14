'use client';
/**
 * Draft and publish in the editor header (lib/server/publish.ts): saves are drafts; Publish puts the saved draft live
 * for production triggers (webhooks, forms, schedules, polls, app webhooks, MCP, error workflows and sub-workflow
 * calls), with an optional note. The top bar's button says "Publish" or "Live v4" (a dot
 * marks unpublished changes); its menu unpublishes and lists where app webhook triggers stand. Older versions are published
 * (rolled back to) from the version history. With four-eyes publishing on (Settings → Governance), Publish and Unpublish
 * ask for approval instead (202 `approvalRequired`), and the menu lists the workflow's pending requests to approve,
 * reject or withdraw. The menu also schedules a publish or unpublish for a later time (./publish-schedules) and lists
 * and cancels what is scheduled.
 */
import { useCallback, useEffect, useState } from 'react';
import { create } from 'zustand';
import { AlertTriangle, CalendarClock, ChevronDown, CircleOff, Rocket, Webhook } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import type { PublicationStatus, PublishResult } from '@/lib/shared/publish';
import type { PublishRequestView } from '@/lib/shared/governance';
import { PublishRequestCard, usePublishRequests } from '../governance/publish-requests';
import { Button } from '../ui/button';
import { Textarea } from '../ui/inputs';
import { MenuItem, MenuLabel, MenuSeparator, Popover } from '../ui/popover';
import { publishLabel } from './chrome';
import { useEditLock } from './edit-lock';
import { ScheduleForm, ScheduleRows, useSchedules } from './publish-schedules';
import { useEditor } from './store';

interface PublicationStore {
  workflowId?: string;
  status?: PublicationStatus;
  refresh(workflowId: string): Promise<PublicationStatus | undefined>;
  /** After a publish or unpublish (here or from the version history): the new status, and the editor's active flag in step. */
  apply(workflowId: string, result: PublishResult): void;
  /** Bumped when a publish request was made (here or from the version history): the menu reloads its requests. */
  requests: number;
}

/** A publish or unpublish answer: published, or (four-eyes publishing) a request waiting for someone else. */
export type PublishAnswer = PublishResult & { approvalRequired?: true; request?: PublishRequestView };

export const usePublication = create<PublicationStore>((set, get) => ({
  requests: 0,
  async refresh(workflowId) {
    try {
      const status = await api<PublicationStatus>(`/api/workflows/${workflowId}/publication`);
      set({ workflowId, status });
      return status;
    } catch {
      if (get().workflowId !== workflowId) set({ workflowId, status: undefined });
      return undefined;
    }
  },
  apply(workflowId, result) {
    set({ workflowId, status: result });
    // The server turned the workflow (in)active: keep the editor in step without marking it dirty.
    useEditor.setState({ active: Boolean(result.published) });
    // That turn also moves the stored workflow's `updatedAt`. The tab's base version stays as it was: the next save gets a 412,
    // and the editor's retry takes the new version only when the stored content is still what this tab saved. Taking it
    // here would hide an edit someone else saved before the publish.
    for (const failure of result.triggerErrors ?? []) toast.warning(`${failure.nodeName}: ${failure.message}`, { description: 'The trigger is retried every minute.' });
  },
}));

/** Publish a version (default: the saved draft); the version history uses it for rollbacks. */
export async function publishVersion(workflowId: string, options: { versionId?: string; note?: string } = {}): Promise<PublishAnswer> {
  const result = await api<PublishAnswer>(`/api/workflows/${workflowId}/publish`, { method: 'POST', json: options });
  if (result.approvalRequired) usePublication.setState((s) => ({ requests: s.requests + 1 }));
  else usePublication.getState().apply(workflowId, result);
  return result;
}

/** The toast for a request that waits for approval. */
export function toastApprovalRequested(result: PublishAnswer) {
  toast.info('Sent for approval', { description: `${result.request?.diff?.summary ? `${result.request.diff.summary}. ` : ''}Someone else has to approve it before it goes live.` });
}

/**
 * The top bar's Publish button, which carries the state: "Publish" for a draft, "Live v3" once a version is live. A dot says
 * whether the draft still matches what is live (green) or has changes (amber), a warning mark that an app webhook failed,
 * and "awaiting approval" that a request waits for someone else.
 */
export function PublishButton({
  published,
  versionNumber,
  changes,
  awaiting,
  failing,
  open,
  disabled,
  title,
  onClick,
}: {
  published: boolean;
  versionNumber?: number;
  changes: boolean;
  awaiting?: boolean;
  failing?: boolean;
  open?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
}) {
  return (
    <Button variant={published ? 'outline' : 'primary'} onClick={onClick} aria-expanded={open} disabled={disabled} title={title}>
      {failing ? (
        <AlertTriangle className="size-3.5 text-warn" />
      ) : published ? (
        <span aria-hidden className={cn('size-1.5 rounded-full', changes ? 'bg-warn' : 'bg-gn')} />
      ) : (
        <Rocket className="size-3.5" />
      )}
      {publishLabel({ published, versionNumber })}
      {published && changes && <span className="sr-only">, with unpublished changes</span>}
      {awaiting && <span className="rounded-md border border-warnbd bg-warndim px-1 text-[10.5px] font-semibold leading-4 text-warn max-md:hidden">Awaiting approval</span>}
      <ChevronDown className="size-3 opacity-70" />
    </Button>
  );
}

export function PublishControl({ workflowId, onSave }: { workflowId: string; onSave: () => Promise<boolean> }) {
  const status = usePublication((s) => (s.workflowId === workflowId ? s.status : undefined));
  const dirty = useEditor((s) => s.dirty);
  const readOnly = useEditLock((s) => s.readOnly);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'publish' | 'unpublish'>();
  const requestsChanged = usePublication((s) => s.requests);
  const { list: requests, reload: reloadRequests } = usePublishRequests({ workflowId });
  const pending = requests?.requests ?? [];
  const { schedules, reload: reloadSchedules } = useSchedules(workflowId);
  const [scheduling, setScheduling] = useState(false);
  useEffect(() => {
    if (requestsChanged) void reloadRequests();
  }, [requestsChanged, reloadRequests]);

  // Reload after every save (dirty → clean): the draft moved.
  useEffect(() => {
    if (!dirty) void usePublication.getState().refresh(workflowId);
  }, [workflowId, dirty]);

  const published = status?.published;
  const changes = Boolean(published && (dirty || status?.unpublishedChanges));
  const failing = status?.appWebhooks.filter((hook) => hook.error) ?? [];

  const publish = useCallback(
    async (close: () => void) => {
      setBusy('publish');
      try {
        // Unsaved edits are saved first: what is published is always a saved version.
        if (useEditor.getState().dirty && !(await onSave())) return;
        const result = await publishVersion(workflowId, { ...(note.trim() && { note: note.trim() }) });
        setNote('');
        close();
        if (result.approvalRequired) return toastApprovalRequested(result);
        toast.success(`Published version ${result.published?.versionNumber ?? ''}`.trim(), { description: 'Production triggers run this version now' });
      } catch (e) {
        toast.error(`Publish failed: ${(e as Error).message}`);
      } finally {
        setBusy(undefined);
      }
    },
    [workflowId, note, onSave],
  );

  const unpublish = useCallback(
    async (close: () => void) => {
      setBusy('unpublish');
      try {
        const result = await api<PublishAnswer>(`/api/workflows/${workflowId}/unpublish`, { method: 'POST', json: {} });
        close();
        if (result.approvalRequired) {
          usePublication.setState((s) => ({ requests: s.requests + 1 }));
          return toastApprovalRequested(result);
        }
        usePublication.getState().apply(workflowId, result);
        toast.success('Unpublished', { description: 'Production triggers are off; the draft and its versions stay' });
        close();
      } catch (e) {
        toast.error(`Unpublish failed: ${(e as Error).message}`);
      } finally {
        setBusy(undefined);
      }
    },
    [workflowId],
  );

  const lines = [
    !published ? 'Production triggers are off until you publish' : changes ? `Version ${published.versionNumber ?? '?'} is live; the draft differs from it` : `Published ${timeAgo(published.publishedAt)}${published.publishedByName ? ` by ${published.publishedByName}` : ''}`,
    pending.length > 0 && `${pending.length} publish request${pending.length === 1 ? '' : 's'} waiting for approval`,
    ...failing.map((hook) => `${hook.nodeName}: ${hook.error}`),
  ].filter(Boolean);

  return (
    <div className="flex items-center gap-2">
      <Popover
        trigger={({ toggle, open }) => (
          <PublishButton
            published={Boolean(published)}
            versionNumber={published?.versionNumber}
            changes={changes}
            awaiting={pending.length > 0}
            failing={failing.length > 0}
            open={open}
            disabled={readOnly}
            title={lines.join('\n')}
            onClick={toggle}
          />
        )}
        className="w-[320px]"
      >
        {(close) => (
          <div className="flex flex-col gap-1">
            <MenuLabel>{published ? `Live: version ${published.versionNumber ?? '?'}` : 'Not published'}</MenuLabel>
            {published && (
              <div className="px-2.5 pb-1 text-[12px] leading-snug text-t3">
                {timeAgo(published.publishedAt)}
                {published.publishedByName ? ` by ${published.publishedByName}` : published.publishedBy === 'migration' ? ' (was active before draft and publish)' : ''}
                {published.note ? ` · “${published.note}”` : ''}
                {changes && <div className="text-warn">The draft has changes that are not live yet.</div>}
              </div>
            )}
            <div className="flex flex-col gap-2 px-2.5 pb-2 pt-1">
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                maxLength={2000}
                placeholder="What changed? (optional note)"
                aria-label="Publish note"
                className="text-[12px]"
              />
              <Button variant="primary" onClick={() => void publish(close)} loading={busy === 'publish'} disabled={Boolean(published && !changes)}>
                <Rocket className="size-3.5" /> {dirty ? 'Save and publish' : published && !changes ? 'Up to date' : `Publish version ${status?.draft?.versionNumber ?? ''}`.trim()}
              </Button>
              {scheduling ? (
                <ScheduleForm
                  workflowId={workflowId}
                  action="publish"
                  note={note}
                  label="Schedule publish"
                  beforeSchedule={async () => !useEditor.getState().dirty || onSave()}
                  onScheduled={() => {
                    setScheduling(false);
                    setNote('');
                    void reloadSchedules();
                    void reloadRequests();
                  }}
                />
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setScheduling(true)}>
                  <CalendarClock className="size-3.5" /> Publish at a chosen time…
                </Button>
              )}
              <div className="text-[11px] leading-snug text-t3">
                Manual runs in the editor use the draft. Roll back from the version history.{requests?.fourEyes.enabled && ' Publishing needs someone else’s approval.'}
              </div>
            </div>
            {(schedules ?? []).some((s) => s.status === 'pending' || s.status === 'awaiting_approval' || s.status === 'failed') && (
              <>
                <MenuSeparator />
                <MenuLabel>Scheduled</MenuLabel>
                <ScheduleRows schedules={(schedules ?? []).filter((s) => s.status !== 'done' && s.status !== 'canceled')} workflowId={workflowId} onChanged={() => void reloadSchedules()} className="px-2.5 pb-1" />
              </>
            )}
            {pending.length > 0 && (
              <>
                <MenuSeparator />
                <MenuLabel>Waiting for approval</MenuLabel>
                {pending.map((request) => (
                  <PublishRequestCard
                    key={request.id}
                    request={request}
                    className="px-2.5 py-1.5"
                    onChanged={() => {
                      void reloadRequests();
                      void usePublication.getState().refresh(workflowId);
                    }}
                  />
                ))}
              </>
            )}
            {(status?.appWebhooks.length ?? 0) > 0 && (
              <>
                <MenuSeparator />
                <MenuLabel>App webhooks</MenuLabel>
                {status!.appWebhooks.map((hook) => (
                  <div key={hook.nodeId} className="flex items-start gap-2 px-2.5 py-1 text-[12px]" title={hook.webhookUrl}>
                    <Webhook className={cn('mt-0.5 size-3.5 shrink-0', hook.error ? 'text-warn' : hook.registered ? 'text-gn' : 'text-t3')} />
                    <span className="min-w-0">
                      <span className="text-t1">{hook.nodeName}</span>{' '}
                      <span className="text-t3">{hook.error ? hook.error : hook.registered ? `registered ${hook.registeredAt ? timeAgo(hook.registeredAt) : ''}` : 'not registered'}</span>
                    </span>
                  </div>
                ))}
              </>
            )}
            {published && (
              <>
                <MenuSeparator />
                <div className="px-2.5 pb-1.5">
                  <ScheduleForm workflowId={workflowId} action="unpublish" label="Unpublish at" onScheduled={() => void reloadSchedules()} />
                </div>
                <MenuItem danger onClick={() => void unpublish(close)} disabled={busy === 'unpublish'}>
                  <CircleOff /> Unpublish
                </MenuItem>
              </>
            )}
          </div>
        )}
      </Popover>
    </div>
  );
}
