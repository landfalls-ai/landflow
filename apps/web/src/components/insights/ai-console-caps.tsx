'use client';
/** The AI page's caps and requests (docs/llm-gateway.md, "The AI page"): how near each cap is, Ask for more, the requests. */
import { useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api, ApiError } from '@/lib/client/api';
import { CAP_BAR_CLASS, REQUEST_STATUS, barPercent, capPeriodLabel, capTone, checkRaise, formatCapAmount, formatPercent, isOpenRequest } from '@/lib/client/ai-console';
import { formatCost } from '@/lib/shared/ai-usage';
import type { AiConsoleCap, AiConsoleReport, CapRaiseInput, CapRaiseRequest } from '@/lib/shared/llm-gateway';
import { Card } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, Field } from '@/components/ui/dialog';
import { Input, SectionLabel, Textarea } from '@/components/ui/inputs';

function AskDialog({ cap, onClose, onSent }: { cap: AiConsoleCap; onClose: () => void; onSent: () => void }) {
  const [max, setMax] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const send = async () => {
    const check = checkRaise(max, cap.max);
    if (check.error || check.value === undefined) return setMessage(check.error);
    if (!reason.trim()) return setMessage('Say why you need more');
    setBusy(true);
    setMessage(undefined);
    try {
      const input: CapRaiseInput = { capId: cap.id, requested: check.value, reason: reason.trim() };
      await api('/api/ai/cap-requests', { method: 'POST', json: input });
      toast.success('Request sent');
      onSent();
      onClose();
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : 'Could not send the request: cap requests are not available on this server');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Ask for more"
      subtitle={`${cap.subject}: ${formatCapAmount(cap, cap.max)} ${capPeriodLabel(cap.period)}`}
      onClose={onClose}
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} className="max-md:min-h-11">
            Cancel
          </Button>
          <Button variant="primary" onClick={send} loading={busy} className="max-md:min-h-11">
            Send
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field id="cap-new-max" label={cap.metric === 'cost' ? 'New maximum (dollars)' : 'New maximum (tokens)'} hint={`It is ${formatCapAmount(cap, cap.max)} now. A person decides.`}>
          <Input id="cap-new-max" inputMode="decimal" value={max} onChange={(e) => setMax(e.target.value)} className="max-md:h-11" autoFocus />
        </Field>
        <Field id="cap-reason" label="Why">
          <Textarea id="cap-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
        </Field>
        {message && (
          <div role="alert" className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2 text-[13px] text-rd">
            {message}
          </div>
        )}
      </div>
    </Dialog>
  );
}

export function CapBar({ cap }: { cap: Pick<AiConsoleCap, 'ratio' | 'subject'> }) {
  const tone = capTone(cap.ratio);
  return (
    <div role="progressbar" aria-label={`${cap.subject}: ${formatPercent(cap.ratio)} of the cap used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(cap.ratio * 100))} className="h-2 w-full overflow-hidden rounded-full bg-nudim">
      <div className={cn('h-full rounded-full', CAP_BAR_CLASS[tone])} style={{ width: `${barPercent(cap.ratio)}%` }} />
    </div>
  );
}

/** The path only: the current origin may differ from LANDFLOW_PUBLIC_URL (dev ports, a proxy). */
const pathOf = (link: string): string => {
  try {
    const url = new URL(link, 'http://x.invalid');
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return link;
  }
};

/** One cap: a card on a phone and a row of the same card on desktop (the bar fills the width either way). */
export function CapItem({ cap, admin, requestStatus, onAsk }: { cap: AiConsoleCap; admin: boolean; requestStatus?: string; onAsk: (cap: AiConsoleCap) => void }) {
  const tone = capTone(cap.ratio);
  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="min-w-0 flex-1 text-[13px] font-medium text-t1 max-md:basis-full">{cap.subject}</span>
        <span className="text-[12px] text-t3">
          {cap.metric === 'cost' ? 'Cost' : 'Tokens'} {capPeriodLabel(cap.period)}
        </span>
        <span className={cn('ml-auto text-[13px] font-semibold tabular-nums', tone === 'full' ? 'text-rd' : tone === 'near' ? 'text-warn' : 'text-t1')}>
          {formatCapAmount(cap, cap.used)} of {formatCapAmount(cap, cap.max)} · {formatPercent(cap.ratio)}
        </span>
      </div>
      <CapBar cap={cap} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-t3">
        <span>
          Set in{' '}
          {admin || !cap.id.startsWith('user:') ? (
            <a href={pathOf(cap.link)} className="text-ac hover:underline">
              {cap.setIn}
            </a>
          ) : (
            cap.setIn
          )}
        </span>
        {cap.backstop && (
          <span title="The budget the gateway holds as a backstop">
            In LiteLLM: {formatCost(cap.backstop.maxBudget)} per {cap.backstop.duration === '1d' ? 'day' : '30 days'}
          </span>
        )}
        {cap.pendingRequestId ? (
          <Badge tone="warning" className="ml-auto">
            Asked{requestStatus ? ` · ${requestStatus}` : ''}
          </Badge>
        ) : (
          cap.canRequest && (
            <Button size="sm" variant="outline" className="ml-auto max-md:min-h-11 max-md:px-4" onClick={() => onAsk(cap)}>
              Ask for more
            </Button>
          )
        )}
      </div>
    </li>
  );
}

export function CapsCard({ report, onChanged }: { report: AiConsoleReport; onChanged: () => void }) {
  const [asking, setAsking] = useState<AiConsoleCap>();
  const [busy, setBusy] = useState(false);
  const status = (id?: string) => (id ? REQUEST_STATUS[report.requests.find((r) => r.id === id)?.status ?? 'pending'].label : undefined);
  const mayAsk = report.caps.some((c) => c.canRequest);
  const turnOn = async () => {
    setBusy(true);
    try {
      await api('/api/ai/cap-requests/setup', { method: 'POST' });
      toast.success('Cap requests are on');
      onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not turn on cap requests');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="px-4 py-3.5">
      <div className="mb-3 flex items-center gap-3">
        <SectionLabel>Caps</SectionLabel>
        <span className="text-[12px] text-t3">how near each one is</span>
      </div>
      {report.caps.length === 0 ? (
        <p className="text-[13px] text-t3">No caps are set{report.viewer.admin ? ' (Settings → AI caps, an agent’s Guardrails, a workflow’s AI usage limits).' : '.'}</p>
      ) : (
        <ul className="divide-y divide-hair">
          {report.caps.map((cap) => (
            <CapItem key={cap.id} cap={cap} admin={report.viewer.admin} requestStatus={status(cap.pendingRequestId)} onAsk={setAsking} />
          ))}
        </ul>
      )}
      {!report.capRaise.active && (report.viewer.admin || mayAsk) && (
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-hair pt-3 text-[12px] text-t3">
          {report.viewer.admin ? (
            <>
              <span className="min-w-0 flex-1 max-md:basis-full">Installs a flow that asks a person to approve each request, and publishes it.</span>
              <Button size="sm" variant="primary" onClick={turnOn} loading={busy} className="max-md:min-h-11 max-md:w-full">
                Turn on cap requests
              </Button>
            </>
          ) : (
            <span>Asking for more is off: an admin can turn it on here.</span>
          )}
        </div>
      )}
      {asking && <AskDialog cap={asking} onClose={() => setAsking(undefined)} onSent={onChanged} />}
    </Card>
  );
}

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function RequestItem({ request, viewerId, admin, onCancel }: { request: CapRaiseRequest; viewerId?: string; admin: boolean; onCancel: (id: string) => void }) {
  const status = REQUEST_STATUS[request.status];
  const mine = request.requestedBy === viewerId;
  const who = mine ? 'you' : request.requestedByName;
  return (
    <li className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 flex-1 text-[13px] font-medium text-t1 max-md:basis-full">{request.subject}</span>
        <Badge tone={status.tone}>{status.label}</Badge>
        <span className="text-[12px] tabular-nums text-t2">
          {formatCapAmount(request, request.current)} → {formatCapAmount(request, request.requested)} {capPeriodLabel(request.period)}
        </span>
      </div>
      <div className="text-[12px] text-t3">
        {[who && admin ? `Asked by ${who}` : who ? 'Asked by you' : 'Asked', when(request.createdAt)].filter(Boolean).join(' · ')}
        {request.decidedByName && request.decidedAt ? ` · decided by ${request.decidedByName}, ${when(request.decidedAt)}` : ''}
      </div>
      {request.reason && <div className="text-[12px] text-t2">{request.reason}</div>}
      {request.note && <div className="text-[12px] text-t2">Note: {request.note}</div>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-t3">
        {request.gateway && <span>In LiteLLM: {request.gateway}</span>}
        {request.executionId && (
          <Link href={`/executions/${request.executionId}`} className="text-ac hover:underline">
            Open the run
          </Link>
        )}
        {mine && isOpenRequest(request.status) && (
          <Button size="sm" variant="ghost" className="ml-auto max-md:min-h-11" onClick={() => onCancel(request.id)}>
            Withdraw
          </Button>
        )}
      </div>
    </li>
  );
}

export function RequestsCard({ report, onChanged }: { report: AiConsoleReport; onChanged: () => void }) {
  if (report.requests.length === 0) return null;
  const cancel = async (id: string) => {
    try {
      await api(`/api/ai/cap-requests/${id}/cancel`, { method: 'POST' });
      onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not withdraw the request');
    }
  };
  return (
    <Card className="px-4 py-3.5">
      <div className="mb-3 flex items-center gap-3">
        <SectionLabel>Requests</SectionLabel>
        <span className="text-[12px] text-t3">{report.viewer.admin ? 'the last 30 days' : 'yours, the last 30 days'}</span>
      </div>
      <ul className="divide-y divide-hair">
        {report.requests.map((request) => (
          <RequestItem key={request.id} request={request} viewerId={report.viewer.userId} admin={report.viewer.admin} onCancel={cancel} />
        ))}
      </ul>
    </Card>
  );
}
