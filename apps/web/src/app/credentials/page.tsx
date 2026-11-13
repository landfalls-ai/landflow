'use client';
import { useState } from 'react';
import Link from 'next/link';
import { ArrowRightLeft, MoreHorizontal, Plus, Share2 } from 'lucide-react';
import { toast } from 'sonner';
import { plural, timeAgo } from '@/lib/client/format';
import { resourceCan, type ResourceOwnership } from '@/lib/shared/projects';
import type { CredentialSummary } from '@/lib/shared/types';
import { MoveToProjectDialog, ShareDialog } from '@/components/projects/share-dialog';
import { CredentialDialog, CredentialTypeIcon } from '@/components/credentials/credential-dialog';
import { useCredentialStore, useCredentials } from '@/components/credentials/use-credentials';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { SectionLabel } from '@/components/ui/inputs';
import { MenuItem, Popover } from '@/components/ui/popover';

/** A listed credential with its project and the viewer's access (GET /api/credentials). */
type Listed = CredentialSummary & { ownership?: ResourceOwnership };

export default function CredentialsPage() {
  const { credentials, types, error } = useCredentials();
  const [dialog, setDialog] = useState<{ id?: string; type?: string } | null>(null);
  const [sharing, setSharing] = useState<{ kind: 'share' | 'move'; credential: Listed }>();
  const refresh = () => void useCredentialStore.getState().refresh();
  const typeOf = (type: string) => types?.find((t) => t.type === type);

  return (
    <>
      <PageHeader
        title="Credentials"
        meta={credentials && <span>{credentials.length} saved · {plural(types?.length ?? 0, 'type')} from plugins</span>}
        actions={
          <Button variant="primary" size="sm" onClick={() => setDialog({})}>
            <Plus className="size-3.5" /> New credential
          </Button>
        }
      />
      <PageBody width="narrow">
        {error && <div className="mb-4 rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>}
        {credentials && credentials.length === 0 ? (
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
                    className="flex min-w-0 flex-1 items-center gap-3.5 px-4 py-3 text-left"
                  >
                    <CredentialTypeIcon info={info} size={34} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold text-t1">{credential.name}</span>
                      <span className="block truncate text-[12px] text-t3">
                        {info ? `${info.descriptor.displayName} · ${info.pluginName}` : credential.type}
                      </span>
                    </span>
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
                    <span className="w-40 shrink-0 truncate text-right text-[12px] text-t2" title={credential.usedBy.map((u) => u.workflowName).join(', ')}>
                      {credential.usedBy.length ? `Used by ${credential.usedBy.length} workflow${credential.usedBy.length === 1 ? '' : 's'}` : 'Not used yet'}
                    </span>
                    <span className="w-28 shrink-0 text-right text-[12px] text-t3">Updated {timeAgo(credential.updatedAt)}</span>
                  </button>
                  <div className="pr-2.5">
                    <Popover
                      trigger={({ open, toggle }) => (
                        <Button variant="ghost" size="icon-sm" onClick={toggle} aria-label={`${credential.name} menu`} className={open ? 'text-t3' : 'text-t3 opacity-0 focus-visible:opacity-100 group-hover:opacity-100'}>
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

        {types && types.length > 0 && (
          <section className="mt-8">
            <SectionLabel className="mb-3">Credential types published by plugins</SectionLabel>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
              {types.map((info) => (
                <button
                  key={info.type}
                  onClick={() => setDialog({ type: info.type })}
                  title={`New ${info.descriptor.displayName} credential`}
                  className="flex items-center gap-2.5 rounded-xl border border-hair bg-sf px-3 py-2.5 text-left transition-colors hover:border-ac"
                >
                  <CredentialTypeIcon info={info} size={28} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-semibold text-t1">{info.descriptor.displayName}</span>
                    <span className="block truncate text-[11px] text-t3">
                      {info.pluginName} · {info.nodeTypes.length} node{info.nodeTypes.length === 1 ? '' : 's'}
                      {info.descriptor.testable && ' · testable'}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            <p className="mt-3 text-[12px] text-t3">
              Plugins declare credential types in their manifest; see <Link href="/developers" className="text-t2 underline-offset-2 hover:text-ac hover:underline">Build a plugin</Link>.
            </p>
          </section>
        )}
      </PageBody>
      {sharing?.kind === 'share' && <ShareDialog kind="credential" id={sharing.credential.id} name={sharing.credential.name} onClose={() => setSharing(undefined)} onChanged={refresh} />}
      {sharing?.kind === 'move' && (
        <MoveToProjectDialog kind="credential" id={sharing.credential.id} name={sharing.credential.name} currentProjectId={sharing.credential.ownership?.projectId} onClose={() => setSharing(undefined)} onMoved={refresh} />
      )}
      {dialog && <CredentialDialog credentialId={dialog.id} allowedTypes={dialog.type ? [dialog.type] : undefined} onClose={() => setDialog(null)} />}
    </>
  );
}
