'use client';
/** The AI page's gateway card: its health, its models and, for admins, the way into LiteLLM (docs/llm-gateway.md). */
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { GATEWAY_WORDS } from '@/lib/client/ai-console';
import type { GatewayStatus } from '@/lib/shared/llm-gateway';
import { Card } from '@/components/shell/page-header';
import { buttonClass } from '@/components/ui/button';
import { Chip } from '@/components/ui/badge';
import { SectionLabel } from '@/components/ui/inputs';

function ago(iso?: string): string {
  const time = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(time)) return 'never';
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

export function GatewayCard({ status, admin }: { status?: GatewayStatus; admin: boolean }) {
  if (!status) {
    return (
      <Card>
        <SectionLabel>Gateway</SectionLabel>
        <div className="mt-3 h-4 w-40 rounded bg-acdim animate-pulse-soft" />
      </Card>
    );
  }
  if (!status.configured) {
    return (
      <Card>
        <SectionLabel>Gateway</SectionLabel>
        <p className="mt-2 text-[13px] text-t2">
          No LLM gateway.{' '}
          {admin ? (
            <>
              An admin can set one in{' '}
              <Link href="/settings#llm-gateway" className="text-ac hover:underline">
                Settings → AI → LLM gateway
              </Link>
              .
            </>
          ) : (
            'An admin can set one in Settings → AI → LLM gateway.'
          )}
        </p>
      </Card>
    );
  }
  const words = GATEWAY_WORDS[status.health];
  const details = status.admin;
  return (
    <Card className="px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <SectionLabel>Gateway</SectionLabel>
        <span className="inline-flex items-center gap-2 text-[13px] font-medium text-t1">
          <span aria-hidden className={cn('size-2.5 rounded-full', words.dot)} />
          {words.label}
        </span>
        {status.health === 'ok' && <span className="sr-only">ok</span>}
        {admin && details && (
          <div className="ml-auto flex items-center gap-2 max-md:ml-0 max-md:w-full">
            <a href={details.uiUrl} target="_blank" rel="noreferrer" className={buttonClass('outline', 'sm', 'max-md:min-h-11 max-md:flex-1 max-md:px-4')}>
              Open LiteLLM
              <ExternalLink className="size-3.5" />
            </a>
            <Link href="/settings#llm-gateway" className={buttonClass('ghost', 'sm', 'max-md:min-h-11 max-md:flex-1 max-md:px-4')}>
              Settings
            </Link>
          </div>
        )}
      </div>
      {status.error && <p className="mt-2 break-words text-[12px] text-rd">{status.error}</p>}
      <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Models">
        {status.models.length === 0 ? <span className="text-[12px] text-t3">No models listed</span> : status.models.map((m) => <Chip key={m.id} mono>{m.id}</Chip>)}
      </div>
      {admin && details && (
        <dl className="mt-3 grid gap-x-6 gap-y-1 border-t border-hair pt-3 text-[12px] text-t2 md:grid-cols-2">
          <div className="flex gap-2">
            <dt className="text-t3">Spend import</dt>
            <dd>
              {details.ingest.enabled ? `${details.ingest.imported} imported, last run ${ago(details.ingest.lastRunAt)}` : 'off'}
              {details.ingest.error ? ` · ${details.ingest.error}` : ''}
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-t3">Budgets sync</dt>
            <dd>{details.sync ? `${ago(details.sync.at)}${details.sync.errors.length ? ` · ${details.sync.errors.length} errors` : ''}` : 'not run'}</dd>
          </div>
        </dl>
      )}
    </Card>
  );
}
