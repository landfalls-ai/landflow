'use client';
/**
 * The production URL of a trigger that listens on this host (Webhook, Form Trigger, MCP Server
 * Trigger), with a copy button. Landflow has no test URLs: the URL answers once the workflow is active.
 */
import { useEffect, useState } from 'react';
import { Link2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CopyButton } from '../ui/copy-button';
import { SectionLabel } from '../ui/inputs';

const clean = (path: unknown) =>
  String(path ?? '')
    .trim()
    .replace(/^\/+|\/+$/g, '');

/** Node types with a URL of their own: where it is served and how to describe it. */
const TRIGGERS: Record<string, { prefix: string; label: string; hint: string; method?: (parameters: Record<string, unknown>) => string }> = {
  'core.webhook': { prefix: '/api/webhook/', label: 'Production URL', hint: 'Requests run the workflow', method: (p) => String(p.method ?? 'POST') },
  'core.formTrigger': { prefix: '/form/', label: 'Form URL', hint: 'Opening it shows the form' },
  'core.mcpTrigger': { prefix: '/mcp/', label: 'MCP server URL', hint: 'Streamable HTTP; MCP clients list and call the tools connected below' },
};

export const hasTriggerUrl = (type: string) => type in TRIGGERS;

export function TriggerUrl({ type, parameters, active, dirty }: { type: string; parameters: Record<string, unknown>; active: boolean; dirty: boolean }) {
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);
  const trigger = TRIGGERS[type];
  if (!trigger) return null;
  const path = clean(parameters.path);
  const url = `${origin}${trigger.prefix}${path}`;
  const method = trigger.method?.(parameters);

  return (
    <div className="mb-4 rounded-[10px] border border-hair bg-wl px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <Link2 className="size-3.5 text-t3" />
        <SectionLabel>{trigger.label}</SectionLabel>
        <span className={cn('ml-auto text-[11px]', active ? 'text-gn' : 'text-t3')}>{active ? (dirty ? 'Active · save to apply changes' : 'Active') : 'Inactive'}</span>
      </div>
      <div className="flex items-center gap-1.5">
        {method && <span className="shrink-0 rounded-md border border-hair bg-sf px-1.5 py-px font-mono text-[10px] font-semibold text-t2">{method}</span>}
        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-t1" title={url}>
          {path ? url : `${origin}${trigger.prefix}…`}
        </code>
        {path && <CopyButton text={url} label={`Copy ${trigger.label.toLowerCase()}`} />}
      </div>
      <p className="mt-1 text-[11px] leading-snug text-t3">{active ? trigger.hint : `${trigger.hint} once the workflow is active.`}</p>
    </div>
  );
}
