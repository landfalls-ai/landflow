'use client';
/**
 * AG23: what a run nobody watches will refuse, said before publishing. One muted line per tool that asks first (`unattendedLine`,
 * from GET /api/workflows/:id/unattended-approvals): "In production nobody approves “Send Email”: a webhook run refuses it. …".
 * Shown on Spotlight's publish card and in the Publish menu; nothing when no such tool is bound to a trigger that runs unattended.
 */
import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import type { UnattendedApproval } from '@/lib/shared/unattended';

export function UnattendedLines({ workflowId, version, update, className }: { workflowId: string; version?: number | 'draft'; update?: string[]; className?: string }) {
  const [lines, setLines] = useState<UnattendedApproval[]>([]);
  const updateKey = update?.join(',') ?? '';
  useEffect(() => {
    let live = true;
    const query = [version === undefined ? '' : `version=${version}`, updateKey ? `update=${encodeURIComponent(updateKey)}` : ''].filter(Boolean).join('&');
    api<UnattendedApproval[]>(`/api/workflows/${encodeURIComponent(workflowId)}/unattended-approvals${query ? `?${query}` : ''}`, { background: true })
      .then((answer) => live && setLines(Array.isArray(answer) ? answer : []))
      .catch(() => live && setLines([]));
    return () => {
      live = false;
    };
  }, [workflowId, version, updateKey]);
  if (!lines.length) return null;
  return (
    <div data-testid="unattended-lines" className={cn('flex flex-col gap-1 text-[11px] leading-snug text-t3', className)}>
      {lines.map((l) => (
        <div key={`${l.node}|${l.tool}|${l.trigger}`} className="flex items-start gap-1.5 [overflow-wrap:anywhere]">
          <ShieldAlert className="mt-px size-3 shrink-0" aria-hidden />
          <span>{l.line}</span>
        </div>
      ))}
    </div>
  );
}
