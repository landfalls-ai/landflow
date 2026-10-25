'use client';
import { useState } from 'react';
import Link from 'next/link';
import { KeyRound, Plus } from 'lucide-react';
import { timeAgo } from '@/lib/client/format';
import { CredentialDialog, CredentialTypeIcon } from '@/components/credentials/credential-dialog';
import { useCredentials } from '@/components/credentials/use-credentials';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { SectionLabel } from '@/components/ui/inputs';

export default function CredentialsPage() {
  const { credentials, types, error } = useCredentials();
  const [dialog, setDialog] = useState<{ id?: string; type?: string } | null>(null);
  const typeOf = (type: string) => types?.find((t) => t.type === type);

  return (
    <>
      <PageHeader
        title="Credentials"
        meta={credentials && <span>{credentials.length} saved · {types?.length ?? 0} types from plugins</span>}
        actions={
          <Button variant="primary" onClick={() => setDialog({})}>
            <Plus className="size-3.5" /> Add credential
          </Button>
        }
      />
      <PageBody className="max-w-[980px]">
        {error && <div className="mb-4 rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>}
        {credentials && credentials.length === 0 ? (
          <Card className="py-6">
            <EmptyState
              title="No credentials yet"
              hint="API keys, tokens and connection strings for the services your nodes talk to. They are encrypted on the host and sent only to the plugin node that uses them."
              action={
                <Button variant="primary" onClick={() => setDialog({})}>
                  <KeyRound className="size-3.5" /> Add your first credential
                </Button>
              }
            />
          </Card>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-hair bg-sf">
            {(credentials ?? []).map((credential, index) => {
              const info = typeOf(credential.type);
              return (
                <button
                  key={credential.id}
                  onClick={() => setDialog({ id: credential.id })}
                  style={{ animationDelay: `${Math.min(index, 12) * 25}ms` }}
                  className="flex w-full items-center gap-3.5 border-b border-hair px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-acdim animate-fade-up"
                >
                  <CredentialTypeIcon info={info} size={34} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold text-t1">{credential.name}</span>
                    <span className="block truncate text-[12px] text-t3">
                      {info ? `${info.descriptor.displayName} · ${info.pluginName}` : credential.type}
                    </span>
                  </span>
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
      {dialog && <CredentialDialog credentialId={dialog.id} allowedTypes={dialog.type ? [dialog.type] : undefined} onClose={() => setDialog(null)} />}
    </>
  );
}
