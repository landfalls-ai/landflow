'use client';
/**
 * The URLs of a trigger that listens on this host, with copy buttons. The Webhook and Form triggers have two, as in
 * n8n: the test URL answers while the editor listens (**Listen for test event**, or **Open test form**: see
 * ./test-listener.tsx) and runs the workflow as it is in the editor, saved or not; the production URL answers once the
 * workflow is published and runs the published version. The MCP Server Trigger has only its production URL.
 */
import { useEffect, useState } from 'react';
import { ExternalLink, FlaskConical, Link2, Radio } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { CopyButton } from '../ui/copy-button';
import { SectionLabel } from '../ui/inputs';
import { useEditor } from './store';
import { clock, listenForTestEvent, stopListening, TEST_URL_PREFIX, useCountdown, useTestListener } from './test-listener';

const clean = (path: unknown) =>
  String(path ?? '')
    .trim()
    .replace(/^\/+|\/+$/g, '');

/** Node types with a URL of their own: where it is served and how to describe it. */
const TRIGGERS: Record<string, { prefix: string; label: string; hint: string; method?: (parameters: Record<string, unknown>) => string }> = {
  'core.webhook': { prefix: '/api/webhook/', label: 'Production URL', hint: 'Requests run the workflow', method: (p) => String(p.method ?? 'POST') },
  'core.formTrigger': { prefix: '/form/', label: 'Production URL', hint: 'Opening it shows the form' },
  'core.mcpTrigger': { prefix: '/mcp/', label: 'MCP server URL', hint: 'Streamable HTTP; MCP clients list and call the tools connected below' },
};

export const hasTriggerUrl = (type: string) => type in TRIGGERS;

/** A URL with its method and a copy button (an ellipsis until the path is set). */
function UrlLine({ base, path, method, label }: { base: string; path: string; method?: string; label: string }) {
  const url = `${base}${path}`;
  return (
    <div className="flex items-center gap-1.5">
      {method && <span className="shrink-0 rounded-md border border-hair bg-sf px-1.5 py-px font-mono text-[10px] font-semibold text-t2">{method}</span>}
      <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-t1" title={url}>
        {path ? url : `${base}…`}
      </code>
      {path && <CopyButton text={url} label={`Copy ${label.toLowerCase()}`} />}
    </div>
  );
}

/** The test URL: Listen for test event (with the countdown and Stop), Open test form, and what arrived. */
function TestUrl({ nodeId, type, path, method, origin }: { nodeId: string; type: string; path: string; method?: string; origin: string }) {
  const listening = useTestListener((s) => (s.listening?.nodeId === nodeId ? s.listening : undefined));
  const busyElsewhere = useTestListener((s) => Boolean(s.listening && s.listening.nodeId !== nodeId));
  const received = useTestListener((s) => (s.received?.nodeId === nodeId ? s.received.at : undefined));
  const running = useEditor((s) => s.running);
  const seconds = useCountdown(listening?.deadline);
  const base = `${origin}${TEST_URL_PREFIX[type]}`;
  const form = type === 'core.formTrigger';
  const blocked = !path || running || busyElsewhere;
  const why = !path ? 'Set the path first' : running ? 'A run is going' : busyElsewhere ? 'The editor is listening on another trigger' : undefined;

  const openForm = () => {
    if (listening) return void window.open(`${base}${path}`, '_blank', 'noopener');
    // Opened during the click (popup blockers allow that) and sent to the form once the listener answers.
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    void listenForTestEvent(nodeId, tab);
  };

  return (
    <div className="mb-2.5 border-b border-hair pb-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <FlaskConical className="size-3.5 text-t3" />
        <SectionLabel>Test URL</SectionLabel>
        <div className="ml-auto flex items-center gap-1.5">
          {listening ? (
            <>
              <span className="flex items-center gap-1 text-[11px] text-gn">
                <Radio className="size-3 animate-pulse" /> Listening <span className="font-mono tabular-nums">{clock(seconds)}</span>
              </span>
              <Button size="sm" variant="danger" onClick={stopListening}>
                Stop
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => void listenForTestEvent(nodeId)} disabled={blocked} title={why ?? 'The test URL answers for 120 s and runs the workflow as it is here'}>
              <Radio className="size-3.5" /> Listen for test event
            </Button>
          )}
          {form && (
            <Button size="sm" variant="ghost" onClick={openForm} disabled={!path || running || busyElsewhere} title={why ?? 'Listen, and open the test form in a new tab'}>
              <ExternalLink className="size-3.5" /> Open test form
            </Button>
          )}
        </div>
      </div>
      <UrlLine base={base} path={path} method={method} label="Test URL" />
      <p className={cn('mt-1 text-[11px] leading-snug', listening ? 'text-t2' : 'text-t3')}>
        {listening
          ? form
            ? 'Submit the test form: the submission runs the workflow as it is in the editor, shown live on the canvas.'
            : `Send a ${method ?? 'POST'} request to the test URL: it runs the workflow as it is in the editor, shown live on the canvas.`
          : received
            ? `Test event received at ${new Date(received).toLocaleTimeString()}: its data is under Output.`
            : `Answers ${form ? 'while the editor listens (120 s, then until the run ends)' : 'one call while the editor listens (120 s)'} and runs the workflow as it is in the editor, saved or not.`}
      </p>
    </div>
  );
}

export function TriggerUrl({ type, parameters, active, dirty, nodeId }: { type: string; parameters: Record<string, unknown>; active: boolean; dirty: boolean; nodeId?: string }) {
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);
  const trigger = TRIGGERS[type];
  if (!trigger) return null;
  const path = clean(parameters.path);
  const method = trigger.method?.(parameters);

  return (
    <div className="mb-4 rounded-[10px] border border-hair bg-wl px-3 py-2.5">
      {nodeId && type in TEST_URL_PREFIX && <TestUrl nodeId={nodeId} type={type} path={path} method={method} origin={origin} />}
      <div className="mb-1.5 flex items-center gap-2">
        <Link2 className="size-3.5 text-t3" />
        <SectionLabel>{trigger.label}</SectionLabel>
        <span className={cn('ml-auto text-[11px]', active ? 'text-gn' : 'text-t3')}>{active ? (dirty ? 'Published · save and publish to apply changes' : 'Published') : 'Not published'}</span>
      </div>
      <UrlLine base={`${origin}${trigger.prefix}`} path={path} method={method} label={trigger.label} />
      <p className="mt-1 text-[11px] leading-snug text-t3">{active ? `${trigger.hint} (the published version).` : `${trigger.hint} once the workflow is published.`}</p>
    </div>
  );
}
