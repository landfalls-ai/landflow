'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ArrowRightLeft, MoreHorizontal, Plus, Share2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import { showHeaderAction } from '@/lib/client/list-page';
import { resourceCan, type ResourceOwnership } from '@/lib/shared/projects';
import type { CredentialSummary } from '@/lib/shared/types';
import { MoveToProjectDialog, ShareDialog } from '@/components/projects/share-dialog';
import { CredentialDialog, CredentialTypeIcon } from '@/components/credentials/credential-dialog';
import { useCredentialStore, useCredentials } from '@/components/credentials/use-credentials';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { MenuItem, Popover } from '@/components/ui/popover';

/** A listed credential with its project and the viewer's access (GET /api/credentials). */
type Listed = CredentialSummary & { ownership?: ResourceOwnership };

/** The list reads `?project=` with useSearchParams, so it renders inside a Suspense boundary. */
export default function CredentialsPage() {
  return (
    <Suspense>
      <CredentialsView />
    </Suspense>
  );
}

function CredentialsView() {
  const projectId = useSearchParams().get('project') ?? undefined;
  const { credentials: all, types, error } = useCredentials();
  // `?project=` (the project page's Overview links here) lists what that project owns or has shared with it: the API's
  // `?projectId=` read is exact, so the list asks it instead of filtering the viewer's whole list.
  const [scoped, setScoped] = useState<Listed[]>();
  const [scopedFor, setScopedFor] = useState<string>();
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    api<{ credentials: Listed[] }>(`/api/credentials?projectId=${encodeURIComponent(projectId)}`)
      .then((r) => live && (setScoped(r.credentials), setScopedFor(projectId)))
      .catch((e: Error) => toast.error(e.message));
    return () => {
      live = false;
    };
  }, [projectId, all]);
  const credentials = projectId ? (scopedFor === projectId ? scoped : undefined) : all;
  const isEmpty = credentials?.length === 0;
  const [dialog, setDialog] = useState<{ id?: string; type?: string } | null>(null);
  const [sharing, setSharing] = useState<{ kind: 'share' | 'move'; credential: Listed }>();
  const refresh = () => void useCredentialStore.getState().refresh();
  const typeOf = (type: string) => types?.find((t) => t.type === type);

  return (
    <>
      <PageHeader
        title="Credentials"
        meta={credentials && <span>{credentials.length} saved{projectId ? ' in this project' : ''}</span>}
        actions={
          showHeaderAction(Boolean(isEmpty)) && (
            <Button variant="primary" size="sm" onClick={() => setDialog({})}>
              <Plus className="size-3.5" /> New credential
            </Button>
          )
        }
      />
      <PageBody width="narrow">
        {error && <div className="mb-4 rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>}
        {isEmpty ? (
          <Card className="py-6">
            <EmptyState
              title="No credentials yet"
              hint="API keys, tokens and connection strings for the services your nodes talk to. They are encrypted on the host and sent only to the plugin node that uses them."
              action={
                <Button onClick={() => setDialog({})}>
                  <Plus className="size-3.5" /> New credential
                </Button>
              }
            />
          </Card>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-hair bg-sf">
            {((credentials ?? []) as Listed[]).map((credential, index) => {
              const info = typeOf(credential.type);
              const access = credential.ownership?.access;
              // Shared "can use" credentials open nothing: their settings stay with the project that owns them.
              const editable = !credential.ownership || resourceCan(access, 'update');
              return (
                <div key={credential.id} style={{ animationDelay: `${Math.min(index, 12) * 25}ms` }} className="group flex items-center border-b border-hair transition-colors last:border-b-0 hover:bg-acdim animate-fade-up">
                  <button
                    onClick={() => (editable ? setDialog({ id: credential.id }) : toast.info(`Shared with you by ${credential.ownership?.projectName}: you can use it in workflows, not view or change it`))}
                    className="flex min-w-0 flex-1 items-center gap-3.5 px-4 py-3 text-left max-md:flex-wrap max-md:gap-y-1"
                  >
                    <CredentialTypeIcon info={info} size={34} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold text-t1">{credential.name}</span>
                      <span className="block truncate text-[12px] text-t3">
                        {info ? `${info.descriptor.displayName} · ${info.pluginName}` : credential.type}
                      </span>
                    </span>
                    {/* On a phone the badges and the meta sit on a second line under the name; on a desktop this wrapper is
                        display: contents, so the row is unchanged. */}
                    <span className="contents max-md:flex max-md:min-w-0 max-md:basis-full max-md:flex-wrap max-md:items-center max-md:gap-x-2 max-md:gap-y-1 max-md:pl-12">
                      {credential.ownership?.shared && <Badge tone="muted" title={`Shared from ${credential.ownership.projectName}`}>Shared · can use</Badge>}
                      {!info && <Badge tone="warning" title="The plugin that publishes this type is not registered">plugin missing</Badge>}
                      {info && !info.available && <Badge tone="warning">plugin offline</Badge>}
                      {credential.oauth2 && (
                        <Badge
                          tone={credential.oauth2.error || (credential.oauth2.expired && !credential.oauth2.refreshable) ? 'warning' : credential.oauth2.connected ? 'success' : 'muted'}
                          title={credential.oauth2.error ?? (credential.oauth2.account ? `Connected as ${credential.oauth2.account}` : undefined)}
                        >
                          {credential.oauth2.connected ? (credential.oauth2.expired && !credential.oauth2.refreshable ? 'expired' : 'connected') : 'not connected'}
                        </Badge>
                      )}
                      <span className="w-40 shrink-0 truncate text-right text-[12px] text-t2 max-md:w-auto max-md:min-w-0 max-md:shrink max-md:text-left" title={credential.usedBy.map((u) => u.workflowName).join(', ')}>
                        {credential.usedBy.length ? `Used by ${credential.usedBy.length} workflow${credential.usedBy.length === 1 ? '' : 's'}` : 'Not used yet'}
                      </span>
                      <span className="w-28 shrink-0 text-right text-[12px] text-t3 max-md:w-auto max-md:text-left">Updated {timeAgo(credential.updatedAt)}</span>
                    </span>
                  </button>
                  <div className="pr-2.5">
                    <Popover
                      trigger={({ open, toggle }) => (
                        <Button variant="ghost" size="icon-sm" onClick={toggle} aria-label={`${credential.name} menu`} className={open ? 'text-t3' : 'text-t3 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 max-md:opacity-100'}>
                          <MoreHorizontal className="size-4" />
                        </Button>
                      )}
                    >
                      {(close) => (
                        <>
                          <MenuItem
                            onClick={() => {
                              close();
                              setSharing({ kind: 'share', credential });
                            }}
                          >
                            <Share2 /> {!credential.ownership || resourceCan(access, 'share') ? 'Share…' : 'Who has access…'}
                          </MenuItem>
                          {(!credential.ownership || resourceCan(access, 'move')) && (
                            <MenuItem
                              onClick={() => {
                                close();
                                setSharing({ kind: 'move', credential });
                              }}
                            >
                              <ArrowRightLeft /> Move to project…
                            </MenuItem>
                          )}
                        </>
                      )}
                    </Popover>
                  </div>
                </div>
              );
            })}
          </div>
        )}

      </PageBody>
      {sharing?.kind === 'share' && <ShareDialog kind="credential" id={sharing.credential.id} name={sharing.credential.name} onClose={() => setSharing(undefined)} onChanged={refresh} />}
      {sharing?.kind === 'move' && (
        <MoveToProjectDialog kind="credential" id={sharing.credential.id} name={sharing.credential.name} currentProjectId={sharing.credential.ownership?.projectId} onClose={() => setSharing(undefined)} onMoved={refresh} />
      )}
      {dialog && <CredentialDialog credentialId={dialog.id} projectId={dialog.id ? undefined : projectId} allowedTypes={dialog.type ? [dialog.type] : undefined} onClose={() => setDialog(null)} />}
    </>
  );
}
