/**
 * Runs poll triggers (`triggerSource: "poll"`) of active workflows: every
 * `pollInterval` seconds it calls the trigger's Execute with mode "poll" and the
 * state its previous poll returned, saves the new state, and starts an
 * execution when the poll found items. The first poll after activation, or after
 * the trigger's parameters or credentials change, only sets the baseline.
 * Single-process, like the scheduler.
 */
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import { PROTOCOL_VERSION, type ExecuteRequest, type JsonObject, type NodeItem } from '@landflow/protocol';
import { ExpressionResolver, type ResolvedNodeType, type Workflow, type WorkflowNode } from '@landflow/engine';
import type { PollStatus } from '../shared/types';
import { credentials } from './credentials/vault';
import { registry } from './plugins/registry';
import { runWorkflow } from './runner';
import { singleton } from './singleton';
import { store, type PollRecord } from './store';
import { fireTrigger, logger, tracePoll } from './telemetry';
import { variables } from './variables';

const MIN_INTERVAL_SECONDS = 10;
const POLL_TIMEOUT_MS = 60_000;

const keyOf = (workflowId: string, nodeId: string) => `${workflowId}:${nodeId}`;

function intervalOf(node: WorkflowNode): number {
  const seconds = Number(node.parameters.pollInterval ?? 60);
  return Math.max(MIN_INTERVAL_SECONDS, Number.isFinite(seconds) ? seconds : 60);
}

/** What the poll depends on; the interval itself can change without losing the state. */
function configHash(node: WorkflowNode): string {
  const { pollInterval: _interval, ...parameters } = node.parameters;
  const refs = Object.fromEntries(Object.entries(node.credentials ?? {}).map(([name, ref]) => [name, ref.id]));
  return createHash('sha256').update(JSON.stringify([node.type, parameters, refs])).digest('hex').slice(0, 16);
}

function isPollTrigger(resolved: ResolvedNodeType | { error: string }): resolved is ResolvedNodeType {
  return !('error' in resolved) && resolved.descriptor.kind === 'trigger' && resolved.descriptor.triggerSource === 'poll';
}

function buildRequest(workflow: Workflow, node: WorkflowNode, resolved: ResolvedNodeType, state: JsonObject | undefined): ExecuteRequest {
  const executionId = `poll_${nanoid(10)}`;
  const skip = new Set(resolved.descriptor.properties.filter((p) => p.noDataExpression || p.type === 'code').map((p) => p.name));
  const resolver = new ExpressionResolver({
    items: [],
    nodeOutputs: {},
    workflow: { id: workflow.id, name: workflow.name },
    execution: { id: executionId, mode: 'poll' },
    parameters: node.parameters,
    variables: variables.record(),
  });
  const data = credentials.resolveFor(node, resolved.descriptor);
  return {
    protocol: PROTOCOL_VERSION,
    executionId,
    workflowId: workflow.id,
    mode: 'poll',
    node: { id: node.id, name: node.name, type: node.type, typeVersion: node.typeVersion },
    parameters: resolver.resolveParameters(node.parameters, 0, skip) as JsonObject,
    itemParameters: [],
    inputs: [],
    ...(Object.keys(data).length > 0 && { credentials: data }),
    ...(state && { pollState: state }),
  };
}

export const poller = singleton('poller', () => {
  const inFlight = new Set<string>();
  let timer: NodeJS.Timeout | undefined;

  async function poll(workflow: Workflow, node: WorkflowNode, resolved: ResolvedNodeType) {
    const key = keyOf(workflow.id, node.id);
    const hash = configHash(node);
    const previous = store.getPoll(key);
    const baseline = !previous?.ready || previous.configHash !== hash;
    const kept = baseline ? undefined : previous;
    const record: PollRecord = {
      configHash: hash,
      ready: !baseline,
      polls: (kept?.polls ?? 0) + 1,
      lastPolledAt: new Date().toISOString(),
      ...(kept?.state && { state: kept.state }),
      ...(kept?.lastExecutionId && { lastExecutionId: kept.lastExecutionId }),
    };

    try {
      // trigger.poll {type} is the root of each poll; a run it starts gets its own trace, linked to it.
      await tracePoll({ workflowId: workflow.id, nodeName: node.name, nodeType: node.type, first: baseline }, async () => {
        const response = await resolved.execute(buildRequest(workflow, node, resolved, record.state), { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
        if (response.error) throw new Error(response.error.message);
        // The baseline poll never starts a run, even if the node returned items.
        const items = baseline ? [] : (response.outputs[0] ?? []);
        if (response.pollState) record.state = response.pollState;
        store.setPoll(key, { ...record, ready: true, lastItems: items.length });
        if (items.length) await startRun(workflow, node, key, items);
        return items;
      });
    } catch (error) {
      // Keep the old state (and a pending baseline): the next interval retries from the same point.
      store.setPoll(key, { ...record, lastItems: 0, lastError: (error as Error).message });
      logger.warn('poll failed', { 'landflow.workflow.id': workflow.id, 'landflow.node.name': node.name, 'landflow.node.type': node.type, error: (error as Error).message });
    }
  }

  /** Start the run for a poll's new items; resolves once the execution has an id. */
  function startRun(workflow: Workflow, node: WorkflowNode, key: string, items: NodeItem[]) {
    return new Promise<void>((resolve) => {
      void fireTrigger({ source: 'poll', workflowId: workflow.id, nodeName: node.name }, () =>
        runWorkflow({
          workflow,
          mode: 'poll',
          startNodeId: node.id,
          triggerOutput: { nodeId: node.id, items },
          onStart: (executionId) => {
            const current = store.getPoll(key);
            if (current) store.setPoll(key, { ...current, lastExecutionId: executionId });
            resolve();
          },
        }),
      )
        .catch((error) => logger.warn('poll-triggered run failed', { 'landflow.workflow.id': workflow.id, error: (error as Error).message }))
        .finally(resolve);
    });
  }

  function due(workflow: Workflow, node: WorkflowNode, now: number) {
    const record = store.getPoll(keyOf(workflow.id, node.id));
    if (!record?.lastPolledAt || record.configHash !== configHash(node)) return true;
    return now - Date.parse(record.lastPolledAt) >= intervalOf(node) * 1000;
  }

  function tick() {
    const now = Date.now();
    const live = new Set<string>();
    for (const workflow of store.listWorkflows()) {
      if (!workflow.active) continue;
      for (const node of workflow.nodes) {
        if (node.disabled) continue;
        const key = keyOf(workflow.id, node.id);
        const resolved = registry.resolve(node.type);
        // An offline plugin keeps its state until it comes back.
        if ('error' in resolved) {
          if (store.getPoll(key)) live.add(key);
          continue;
        }
        if (!isPollTrigger(resolved)) continue;
        live.add(key);
        if (inFlight.has(key) || !due(workflow, node, now)) continue;
        inFlight.add(key);
        void poll(workflow, node, resolved).finally(() => inFlight.delete(key));
      }
    }
    // Deactivated workflows and removed triggers start from a fresh baseline next time.
    for (const key of store.pollKeys()) if (!live.has(key) && !inFlight.has(key)) store.setPoll(key, undefined);
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, 1_000);
      timer.unref?.();
    },

    /** Poll a trigger now instead of waiting for its interval. */
    async pollNow(workflowId: string, nodeId: string): Promise<PollStatus> {
      const workflow = store.getWorkflow(workflowId);
      const node = workflow?.nodes.find((n) => n.id === nodeId);
      if (!workflow || !node) throw new Error('Workflow or node not found');
      if (!workflow.active) throw new Error('Activate the workflow to poll its trigger');
      const resolved = registry.resolve(node.type);
      if ('error' in resolved) throw new Error(resolved.error);
      if (!isPollTrigger(resolved)) throw new Error(`${node.name} is not a polling trigger`);
      const key = keyOf(workflowId, nodeId);
      if (!inFlight.has(key)) {
        inFlight.add(key);
        await poll(workflow, node, resolved).finally(() => inFlight.delete(key));
      }
      return this.status(workflowId).find((s) => s.nodeId === nodeId)!;
    },

    status(workflowId: string): PollStatus[] {
      const workflow = store.getWorkflow(workflowId);
      if (!workflow) return [];
      return workflow.nodes
        .filter((node) => !node.disabled && isPollTrigger(registry.resolve(node.type)))
        .map((node) => {
          const record = store.getPoll(keyOf(workflow.id, node.id));
          const intervalSeconds = intervalOf(node);
          const current = record?.configHash === configHash(node) ? record : undefined;
          return {
            nodeId: node.id,
            nodeName: node.name,
            intervalSeconds,
            baseline: !current?.ready,
            polls: current?.polls ?? 0,
            ...(current?.lastPolledAt && { lastPolledAt: current.lastPolledAt }),
            ...(workflow.active &&
              current?.lastPolledAt && { nextPollAt: new Date(Date.parse(current.lastPolledAt) + intervalSeconds * 1000).toISOString() }),
            ...(current?.lastItems !== undefined && { lastItems: current.lastItems }),
            ...(current?.lastError && { lastError: current.lastError }),
            ...(current?.lastExecutionId && { lastExecutionId: current.lastExecutionId }),
          };
        });
    },
  };
});
