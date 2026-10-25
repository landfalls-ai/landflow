'use client';
/**
 * "Listen for test event" (n8n's): while the editor listens, the test URL of a Webhook or Form trigger
 * (/api/webhook-test/<path>, /form-test/<path>) answers for 120 s, and the call runs the editor's current workflow as a
 * manual run that streams onto the canvas like Execute does (POST /api/workflows/:id/listen, lib/server/test-webhooks.ts).
 * Started from the trigger panel, by Execute when the workflow starts at such a trigger without test data, and by
 * "Open test form". Stop (or closing the editor) ends it, and stops a test run that is still going.
 */
import { useEffect, useState } from 'react';
import { Copy, ExternalLink, Radio, Square } from 'lucide-react';
import { toast } from 'sonner';
import { create } from 'zustand';
import { streamEvents } from '@/lib/client/api';
import type { ExecutionEvent } from '@/lib/shared/types';
import { Button } from '../ui/button';
import { useEditor, type RunCommand } from './store';

/** Trigger types with a test URL, and where it is served. */
export const TEST_URL_PREFIX: Record<string, string> = { 'core.webhook': '/api/webhook-test/', 'core.formTrigger': '/form-test/' };

interface Listening {
  nodeId: string;
  kind: 'webhook' | 'form';
  method?: string;
  path: string;
  /** Client clock (ms) when the listener times out. */
  deadline: number;
}

interface TestListenerState {
  /** Waiting for the test event. */
  listening?: Listening;
  /** The last test event that arrived: node and time. */
  received?: { nodeId: string; at: number };
}

export const useTestListener = create<TestListenerState>(() => ({}));

let controller: AbortController | undefined;

/** The test URL of a trigger on this host (`origin` defaults to the page's). */
export function testUrlOf(type: string, path: unknown, origin = typeof window === 'undefined' ? '' : window.location.origin): string | undefined {
  const prefix = TEST_URL_PREFIX[type];
  const clean = String(path ?? '')
    .trim()
    .replace(/^\/+|\/+$/g, '');
  return prefix && clean ? `${origin}${prefix}${clean}` : undefined;
}

/**
 * The trigger a run command should listen on instead of running: Execute on a workflow that starts at a Webhook or Form
 * trigger (as the server picks it: a manual trigger wins), or running such a trigger itself, when it has no pinned data.
 */
export function testTriggerFor(command: RunCommand): string | undefined {
  const { nodes, nodeTypes, pinData } = useEditor.getState();
  const triggerOf = (source: string) => nodes.find((n) => !n.data.wf.disabled && nodeTypes[n.data.wf.type]?.descriptor.kind === 'trigger' && nodeTypes[n.data.wf.type]?.descriptor.triggerSource === source);
  let node;
  if (command.kind === 'run') node = triggerOf('manual') ? undefined : triggerOf('webhook');
  else if (command.kind === 'node') node = nodes.find((n) => n.id === command.nodeId && !n.data.wf.disabled);
  if (!node || !(node.data.wf.type in TEST_URL_PREFIX) || pinData[node.id]) return undefined;
  return node.id;
}

export const isListening = () => Boolean(controller);

/** Stop listening (and a test run that is going). */
export function stopListening() {
  controller?.abort();
}

/**
 * Listen for a test event on `nodeId`'s test URL, then follow the run it starts on the canvas. `tab`: a window opened for
 * "Open test form", sent to the form once it answers.
 */
export async function listenForTestEvent(nodeId: string, tab?: Window | null): Promise<void> {
  const state = useEditor.getState();
  if (controller || state.running) {
    tab?.close();
    return;
  }
  const own = new AbortController();
  controller = own;
  let following = false;
  let outcome: { status: string; error?: { message: string } } | undefined;
  let note: string | undefined;
  try {
    await streamEvents(
      `/api/workflows/${state.workflowId}/listen`,
      { nodeId, workflow: state.toWorkflow() },
      (event, data) => {
        if (event === 'listening') {
          const info = data as Omit<Listening, 'deadline'> & { timeoutMs: number };
          useTestListener.setState({ listening: { nodeId, kind: info.kind, method: info.method, path: info.path, deadline: Date.now() + info.timeoutMs } });
          const url = testUrlOf(useEditor.getState().nodes.find((n) => n.id === nodeId)?.data.wf.type ?? '', info.path);
          if (tab && url) tab.location.href = url;
        }
        if (event === 'execution') {
          const update = data as ExecutionEvent;
          if (!following) {
            following = true;
            useTestListener.setState({ listening: undefined, received: { nodeId, at: Date.now() } });
            useEditor.getState().startRun();
          } else if (update.type === 'execution.started') {
            // The next page of a test form was submitted: the run goes on.
            useEditor.setState({ running: true, runStatus: 'running' });
          }
          useEditor.getState().applyEvent(update);
        }
        if (event === 'result') outcome = data as typeof outcome;
        if (event === 'timeout' || event === 'stopped') note = (data as { message: string }).message;
      },
      own.signal,
    );
  } catch (e) {
    tab?.close();
    if ((e as Error).name !== 'AbortError') toast.error(`Could not listen for a test event: ${(e as Error).message}`);
  } finally {
    if (controller === own) controller = undefined;
    useTestListener.setState({ listening: undefined });
    if (following) useEditor.getState().finishRun();
  }
  if (note) toast(note);
  if (!outcome) return;
  if (outcome.status === 'success') toast.success('Test run succeeded');
  else if (outcome.status === 'waiting') toast('Test run is waiting; it continues in the background');
  else if (outcome.status === 'canceled') toast('Test run stopped');
  else toast.error(`Test run failed${outcome.error?.message ? `: ${outcome.error.message}` : ''}`);
}

/** Seconds left until `deadline`, ticking. */
export function useCountdown(deadline: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [deadline]);
  return deadline === undefined ? 0 : Math.max(0, Math.ceil((deadline - now) / 1000));
}

export const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/** The Execute bar while listening: what it waits for, the countdown, the test form or URL, and Stop. */
export function ListeningBar() {
  const listening = useTestListener((s) => s.listening);
  const seconds = useCountdown(listening?.deadline);
  if (!listening) return null;
  const url = testUrlOf(listening.kind === 'form' ? 'core.formTrigger' : 'core.webhook', listening.path);
  return (
    <>
      <span className="flex items-center gap-2 px-3 text-[13px] text-t1">
        <Radio className="size-3.5 animate-pulse text-gn" />
        Waiting for a test {listening.kind === 'form' ? 'form submission' : 'event'}
        <span className="font-mono text-[12px] tabular-nums text-t3">{clock(seconds)}</span>
      </span>
      {url && listening.kind === 'form' && (
        <Button onClick={() => window.open(url, '_blank', 'noopener')}>
          <ExternalLink className="size-3.5" /> Open form
        </Button>
      )}
      {url && listening.kind === 'webhook' && (
        <Button onClick={() => void navigator.clipboard.writeText(url).then(() => toast.success('Test URL copied'))} title={url}>
          <Copy className="size-3.5" /> Copy URL
        </Button>
      )}
      <Button variant="danger" onClick={stopListening}>
        <Square className="size-3" fill="currentColor" /> Stop listening
      </Button>
    </>
  );
}
