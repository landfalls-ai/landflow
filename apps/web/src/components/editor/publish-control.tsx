'use client';
/**
 * Draft and publish in the editor header (lib/server/publish.ts): saves are drafts; Publish puts the saved draft live
 * for production triggers (webhooks, forms, schedules, polls, app webhooks, MCP, error workflows and sub-workflow
 * calls), with an optional note. The chip says whether the editor shows what is live ("Published · v4") or has
 * unpublished changes; the menu unpublishes and lists where app webhook triggers stand. Older versions are published
 * (rolled back to) from the version history.
 */
import { useCallback, useEffect, useState } from 'react';
import { create } from 'zustand';
import { AlertTriangle, ChevronDown, CircleOff, Rocket, Webhook } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import type { PublicationStatus, PublishResult } from '@/lib/shared/publish';
import { Button } from '../ui/button';
import { Textarea } from '../ui/inputs';
import { MenuItem, MenuLabel, MenuSeparator, Popover } from '../ui/popover';
import { useEditLock } from './edit-lock';
import { useEditor } from './store';

interface PublicationStore {
  workflowId?: string;
  status?: PublicationStatus;
  refresh(workflowId: string): Promise<PublicationStatus | undefined>;
  /** After a publish or unpublish (here or from the version history): the new status, and the editor's active flag in step. */
  apply(workflowId: string, result: PublishResult): void;
}

export const usePublication = create<PublicationStore>((set, get) => ({
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
    for (const failure of result.triggerErrors ?? []) toast.warning(`${failure.nodeName}: ${failure.message}`, { description: 'The trigger is retried every minute.' });
  },
}));

/** Publish a version (default: the saved draft); the version history uses it for rollbacks. */
export async function publishVersion(workflowId: string, options: { versionId?: string; note?: string } = {}): Promise<PublishResult> {
  const result = await api<PublishResult>(`/api/workflows/${workflowId}/publish`, { method: 'POST', json: options });
  usePublication.getState().apply(workflowId, result);
  return result;
}

export function PublishControl({ workflowId, onSave }: { workflowId: string; onSave: () => Promise<boolean> }) {
  const status = usePublication((s) => (s.workflowId === workflowId ? s.status : undefined));
  const dirty = useEditor((s) => s.dirty);
  const readOnly = useEditLock((s) => s.readOnly);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'publish' | 'unpublish'>();

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
        toast.success(`Published version ${result.published?.versionNumber ?? ''}`.trim(), { description: 'Production triggers run this version now' });
        setNote('');
        close();
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
        const result = await api<PublishResult>(`/api/workflows/${workflowId}/unpublish`, { method: 'POST', json: {} });
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

  const chip = !published ? (
    <span className="flex items-center gap-1.5 text-[12px] text-t3" title="Production triggers are off until you publish">
      <span className="size-1.5 rounded-full bg-t3" /> Not published
    </span>
  ) : changes ? (
    <span className="flex items-center gap-1.5 text-[12px] text-warn" title={`Version ${published.versionNumber ?? '?'} is live; the draft differs from it`}>
      <span className="size-1.5 rounded-full bg-warn" /> Unpublished changes
    </span>
  ) : (
    <span className="flex items-center gap-1.5 text-[12px] text-gn" title={`Published ${timeAgo(published.publishedAt)}${published.publishedByName ? ` by ${published.publishedByName}` : ''}`}>
      <span className="size-1.5 rounded-full bg-gn" /> Published{published.versionNumber ? ` · v${published.versionNumber}` : ''}
    </span>
  );

  return (
    <div className="flex items-center gap-2">
      {failing.length > 0 && (
        <span className="text-warn" title={failing.map((hook) => `${hook.nodeName}: ${hook.error}`).join('\n')}>
          <AlertTriangle className="size-3.5" />
        </span>
      )}
      {chip}
      <Popover
        trigger={({ toggle, open }) => (
          <Button variant={!published || changes ? 'primary' : 'outline'} onClick={toggle} aria-expanded={open} disabled={readOnly} title="Publish the saved draft for production triggers">
            <Rocket className="size-3.5" /> Publish <ChevronDown className="size-3 opacity-70" />
          </Button>
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
              <div className="text-[11px] leading-snug text-t3">Manual runs in the editor use the draft. Roll back from the version history.</div>
            </div>
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
