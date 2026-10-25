/**
 * IMAP IDLE for the Email Trigger (IMAP) with "Listen: IDLE": one open connection per published trigger, idling on
 * its mailbox. When the server announces new mail (EXISTS grows) the trigger is polled right away through the poller
 * (lib/server/poller.ts), so state, runs and post-processing stay in one place; the poll interval remains the
 * fallback. Watches are reconciled when a workflow is published or unpublished and every 30 seconds; a dropped
 * connection reconnects with backoff (5 s doubling to 5 min).
 */
import { createHash } from 'node:crypto';
import type { ImapFlow } from 'imapflow';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import { credentials } from './credentials/vault';
import { closeQuietly, imapClient, imapErrorText, type ImapCredential } from './nodes/email-imap';
import { registry } from './plugins/registry';
import { onPublicationChanged } from './publications';
import { productionWorkflows } from './publish';
import { singleton } from './singleton';
import { logger } from './telemetry';

const NODE_TYPE = 'core.emailReadImap';
const RECONCILE_MS = 30_000;
const DEBOUNCE_MS = 500;
const MAX_BACKOFF_MS = 300_000;

interface Watch {
  key: string;
  hash: string;
  workflowId: string;
  nodeId: string;
  client?: ImapFlow;
  stopped: boolean;
  failures: number;
  retry?: NodeJS.Timeout;
  debounce?: NodeJS.Timeout;
  lastError?: string;
}

export interface IdleWatchStatus {
  workflowId: string;
  nodeId: string;
  connected: boolean;
  lastError?: string;
}

function watched(): { workflow: Workflow; node: WorkflowNode }[] {
  const out: { workflow: Workflow; node: WorkflowNode }[] = [];
  for (const workflow of productionWorkflows()) {
    for (const node of workflow.nodes) if (node.type === NODE_TYPE && !node.disabled && node.parameters.listen === 'idle') out.push({ workflow, node });
  }
  return out;
}

function hashOf(node: WorkflowNode): string {
  const refs = Object.fromEntries(Object.entries(node.credentials ?? {}).map(([name, ref]) => [name, ref.id]));
  return createHash('sha256').update(JSON.stringify([node.parameters.mailbox ?? 'INBOX', refs])).digest('hex').slice(0, 16);
}

export const imapIdle = singleton('imap-idle', () => {
  const watches = new Map<string, Watch>();
  let timer: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;

  function stop(watch: Watch) {
    watch.stopped = true;
    clearTimeout(watch.retry);
    clearTimeout(watch.debounce);
    if (watch.client) void closeQuietly(watch.client);
    watch.client = undefined;
  }

  /** Poll the trigger through the poller (it skips a poll already in flight). */
  function trigger(watch: Watch) {
    clearTimeout(watch.debounce);
    watch.debounce = setTimeout(() => {
      void import('./poller')
        .then(({ poller }) => poller.pollNow(watch.workflowId, watch.nodeId))
        .catch((error) => logger.warn('IMAP IDLE poll failed', { 'landflow.workflow.id': watch.workflowId, error: (error as Error).message }));
    }, DEBOUNCE_MS);
    watch.debounce.unref?.();
  }

  function scheduleReconnect(watch: Watch, node: WorkflowNode) {
    if (watch.stopped) return;
    watch.failures++;
    const delay = Math.min(MAX_BACKOFF_MS, 5_000 * 2 ** Math.min(watch.failures - 1, 10));
    clearTimeout(watch.retry);
    watch.retry = setTimeout(() => void connect(watch, node), delay);
    watch.retry.unref?.();
  }

  async function connect(watch: Watch, node: WorkflowNode) {
    if (watch.stopped) return;
    const resolved = registry.resolve(node.type);
    if ('error' in resolved) return scheduleReconnect(watch, node);
    let client: ImapFlow;
    try {
      const data = credentials.resolveFor(node, resolved.descriptor).imap as ImapCredential | undefined;
      if (!data?.host) throw new Error('no IMAP credential');
      // IDLE starts a second after the mailbox opened, and is renewed every 5 minutes.
      client = imapClient(data, { autoIdleDelay: 1_000, maxIdleTime: 5 * 60_000 });
    } catch (error) {
      watch.lastError = (error as Error).message;
      return scheduleReconnect(watch, node);
    }
    watch.client = client;
    client.on('exists', (event: { count: number; prevCount: number }) => {
      if (event.count > event.prevCount) trigger(watch);
    });
    client.on('error', (error: unknown) => {
      watch.lastError = imapErrorText(error);
    });
    client.on('close', () => {
      if (watch.client !== client) return;
      watch.client = undefined;
      scheduleReconnect(watch, node);
    });
    try {
      await client.connect();
      await client.mailboxOpen(String(node.parameters.mailbox || 'INBOX'), { readOnly: true });
      watch.failures = 0;
      watch.lastError = undefined;
      // Mail that arrived while disconnected is picked up by a poll now.
      trigger(watch);
      // ImapFlow idles on its own while no command runs (auto-IDLE).
    } catch (error) {
      watch.lastError = imapErrorText(error);
      logger.warn('IMAP IDLE connection failed', { 'landflow.workflow.id': watch.workflowId, 'landflow.node.name': node.name, error: watch.lastError });
      if (watch.client === client) watch.client = undefined;
      await closeQuietly(client);
      scheduleReconnect(watch, node);
    }
  }

  function reconcile() {
    const live = new Set<string>();
    for (const { workflow, node } of watched()) {
      const key = `${workflow.id}:${node.id}`;
      const hash = hashOf(node);
      live.add(key);
      const existing = watches.get(key);
      if (existing && existing.hash === hash) continue;
      if (existing) stop(existing);
      const watch: Watch = { key, hash, workflowId: workflow.id, nodeId: node.id, stopped: false, failures: 0 };
      watches.set(key, watch);
      void connect(watch, node);
    }
    for (const [key, watch] of watches) {
      if (live.has(key)) continue;
      stop(watch);
      watches.delete(key);
    }
  }

  return {
    start() {
      if (timer) return;
      unsubscribe = onPublicationChanged(() => setImmediate(reconcile));
      timer = setInterval(reconcile, RECONCILE_MS);
      timer.unref?.();
      reconcile();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
      unsubscribe?.();
      for (const watch of watches.values()) stop(watch);
      watches.clear();
    },
    status(): IdleWatchStatus[] {
      return [...watches.values()].map((w) => ({ workflowId: w.workflowId, nodeId: w.nodeId, connected: Boolean(w.client?.usable), ...(w.lastError && { lastError: w.lastError }) }));
    },
    /** Reconcile now (tests). */
    reconcile,
  };
});
