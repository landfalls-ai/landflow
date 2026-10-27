/**
 * n8n's Execute Workflow: runs another workflow from its "When Called by a Workflow or Agent"
 * trigger and returns the output of its last node. The child is saved as its own execution, linked
 * to the parent (`parentExecutionId`, the parent's `subExecutions`), at most 10 levels deep. A child
 * that starts waiting puts the parent into "waiting" too; the runner resumes the parent with the
 * child's final output. In "each" mode up to EACH_CONCURRENCY children (the node's "Sub-Workflows at Once") run at a
 * time; the parent waits for every child that waits, and resumes once the last one finished, with the outputs in item
 * order (lib/server/sub-executions.ts).
 */
import { defineNode, NodeOperationError, type IExecuteContext, type JsonObject, type NodeItem } from '@landflow/sdk';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import { shareBinaryScope } from '../binary/access';
import { workflowForCall } from '../publish';
import { store } from '../store';
import { cancelSubExecutions, capInlineOutputs, childFailure, eachOutput, finishedEntry, type EachChild, type EachWait } from '../sub-executions';

const main = [{ type: 'main' as const }];
export const WORKFLOW_TRIGGER = 'core.workflowTrigger';
const TRIGGER_NAME = 'When Called by a Workflow or Agent';
/** "Run Once for Each Item" with waiting: how many sub-executions run at once unless the node says otherwise. */
export const EACH_CONCURRENCY = 4;

interface TriggerField {
  name?: string;
  type?: string;
  description?: string;
  required?: boolean;
}

/** n8n stores the workflow as a resource locator (`{ __rl, value, mode }`); Landflow as the id. */
const workflowIdOf = (value: unknown) => String((value && typeof value === 'object' ? (value as { value?: unknown }).value : value) ?? '').trim();

export const triggerOf = (workflow: Workflow): WorkflowNode | undefined => workflow.nodes.find((n) => n.type === WORKFLOW_TRIGGER && !n.disabled);

const triggerFields = (trigger: WorkflowNode | undefined): TriggerField[] =>
  ((trigger?.parameters.inputs as { fields?: TriggerField[] } | undefined)?.fields ?? []).filter((f) => f.name?.trim());

/** Whether `callerId` may run `target` (its Settings → "This workflow can be called by"). */
export function callerAllowed(target: Workflow, callerId: string | undefined): boolean {
  const policy = target.settings?.callerPolicy ?? 'any';
  if (policy === 'none') return false;
  if (policy === 'list') return Boolean(callerId && (target.settings?.callerIds ?? []).includes(callerId));
  return true;
}

/** Everything that would stop the child from running, as one message. */
function loadTarget(ctx: IExecuteContext): { workflow: Workflow; trigger: WorkflowNode } {
  const id = workflowIdOf(ctx.getNodeParameter('workflowId', 0));
  if (!id) throw new NodeOperationError('Choose the workflow to run');
  // A manual run calls the child's draft; production runs call its published version (draft and publish).
  const workflow = workflowForCall(id, ctx.mode);
  if (!workflow) throw new NodeOperationError(`Workflow ${id} not found`, { description: 'It may have been deleted. Choose the workflow again.' });
  const trigger = triggerOf(workflow);
  if (!trigger) throw new NodeOperationError(`“${workflow.name}” has no “${TRIGGER_NAME}” trigger`, { description: 'Add that trigger to the workflow so other workflows can run it.' });
  if (!callerAllowed(workflow, ctx.getWorkflowId())) {
    throw new NodeOperationError(`“${workflow.name}” doesn’t allow this workflow to call it`, { description: 'Change “This workflow can be called by” in that workflow’s settings.' });
  }
  return { workflow, trigger };
}

interface MappedInput {
  name?: string;
  value?: unknown;
}

/** The items the child starts with: the input as it is, or the mapped arguments per item. */
function childItems(ctx: IExecuteContext, indexes: number[]): NodeItem[] {
  const items = ctx.getInputData();
  if (ctx.getNodeParameter('inputSource', 0) !== 'map') return indexes.map((i) => ({ json: items[i].json, ...(items[i].binary && { binary: items[i].binary }) }));
  return indexes.map((i) => {
    const json: JsonObject = {};
    for (const input of ctx.getNodeParameter<{ values?: MappedInput[] }>('workflowInputs', i)?.values ?? []) {
      const name = String(input.name ?? '').trim();
      if (name) json[name] = (input.value ?? null) as JsonObject[string];
    }
    return { json };
  });
}

export const executeWorkflowNode = defineNode({
  description: {
    name: 'executeWorkflow',
    displayName: 'Execute Workflow',
    description: 'Run another workflow and use the output of its last node',
    version: 1,
    kind: 'action',
    categories: ['Flow'],
    icon: 'lucide:workflow',
    color: '#22c55e',
    subtitle: '{{mode}}',
    keywords: ['sub-workflow', 'subworkflow', 'call workflow', 'run workflow', 'execute workflow', 'reuse'],
    usableAsTool: true,
    inputs: main,
    outputs: main,
    properties: [
      {
        name: 'workflowId',
        displayName: 'Workflow',
        type: 'options',
        default: '',
        required: true,
        noDataExpression: true,
        typeOptions: { loadOptionsMethod: 'workflows' },
        description: `It needs a “${TRIGGER_NAME}” trigger`,
      },
      {
        name: 'inputSource',
        displayName: 'Workflow Inputs',
        type: 'options',
        default: 'passthrough',
        noDataExpression: true,
        options: [
          { name: 'Pass Items Through', value: 'passthrough', description: 'Send the input items as they are' },
          { name: 'Map Arguments', value: 'map', description: 'Set each argument of the workflow’s trigger, with expressions' },
        ],
      },
      {
        name: 'workflowInputs',
        displayName: 'Arguments',
        type: 'fixedCollection',
        typeOptions: { multipleValues: true },
        placeholder: 'Add argument',
        default: {},
        displayOptions: { show: { inputSource: ['map'] } },
        groups: [
          {
            name: 'values',
            displayName: 'Argument',
            values: [
              { name: 'name', displayName: 'Name', type: 'options', default: '', typeOptions: { loadOptionsMethod: 'arguments', loadOptionsDependsOn: ['workflowId'] } },
              { name: 'value', displayName: 'Value', type: 'string', default: '', placeholder: '{{ $json.id }}' },
            ],
          },
        ],
      },
      {
        name: 'mode',
        displayName: 'Mode',
        type: 'options',
        default: 'once',
        noDataExpression: true,
        options: [
          { name: 'Run Once with All Items', value: 'once', description: 'One execution gets every item' },
          { name: 'Run Once for Each Item', value: 'each', description: 'One execution per item, several at once; the output keeps the item order' },
        ],
      },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          {
            name: 'waitForSubWorkflow',
            displayName: 'Wait for Sub-Workflow Completion',
            type: 'boolean',
            default: true,
            description: 'Off: start it and pass the input items on straight away',
          },
          {
            name: 'concurrency',
            displayName: 'Sub-Workflows at Once',
            type: 'number',
            default: EACH_CONCURRENCY,
            typeOptions: { minValue: 1, maxValue: 32 },
            description: 'Run Once for Each Item: how many sub-executions run at the same time (1: one after another). The output keeps the item order.',
          },
        ],
      },
    ],
  },
  methods: {
    loadOptions: {
      workflows: () =>
        store
          .listWorkflows()
          .map((w) => ({ name: w.name, value: w.id, ...(!triggerOf(w) && { description: `Needs a “${TRIGGER_NAME}” trigger` }) }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      arguments: (ctx) => {
        const workflow = store.getWorkflow(workflowIdOf(ctx.getNodeParameter('workflowId', '')));
        return triggerFields(workflow && triggerOf(workflow)).map((f) => ({
          name: f.name!.trim(),
          value: f.name!.trim(),
          description: [f.type ?? 'string', f.required !== false ? 'required' : '', f.description ?? ''].filter(Boolean).join(' · '),
        }));
      },
    },
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    const { workflow, trigger } = loadTarget(ctx);
    const options = ctx.getNodeParameter<{ waitForSubWorkflow?: boolean; concurrency?: number }>('options', 0) ?? {};
    const wait = options.waitForSubWorkflow !== false;
    const each = ctx.getNodeParameter('mode', 0) === 'each';
    const groups = each ? items.map((_, i) => [i]) : [items.map((_, i) => i)];
    // Loaded lazily: the runner needs the registry this plugin is part of.
    const { runWorkflow, lastNodeItems } = await import('../runner');
    const parent = { executionId: ctx.getExecutionId(), nodeId: ctx.getNode().id };
    // A poll-started parent's children are ordinary trigger runs (only the trigger polls).
    const mode = ctx.mode === 'poll' ? 'trigger' : ctx.mode;
    // A child this run waits for writes its files into this run's scope, so the files it returns outlive it.
    const onChildStart = (id: string, onStart?: (id: string) => void) => {
      if (wait) shareBinaryScope(id, parent.executionId);
      onStart?.(id);
    };
    // A child this run waits for gets its signal (it runs in this process, and stops with this run).
    const start = (indexes: number[], onStart?: (id: string) => void, signal = ctx.signal) =>
      runWorkflow({ workflow, mode, startNodeId: trigger.id, triggerItems: childItems(ctx, indexes), parent, ...(wait && signal && { signal }), onStart: (id) => onChildStart(id, onStart) }).catch(
        (error: Error) => {
          throw new NodeOperationError(error.message);
        },
      );
    const stopped = () => new NodeOperationError('Execution canceled');
    const waitingInTool = (id: string) =>
      new NodeOperationError('Sub-workflow is waiting; turn off ‘Wait for Sub-Workflow Completion’ or remove the Wait', {
        description: `Execution ${id} waits (it goes on by itself). Only a workflow execution can wait for it, not a tool call.`,
      });

    if (!wait) {
      for (const indexes of groups) {
        const id = await new Promise<string>((resolve, reject) => {
          start(indexes, resolve).catch(reject);
        });
        ctx.logger.info(`Started sub-execution ${id} of “${workflow.name}”`);
      }
      return [items.map((item, index) => ({ ...item, pairedItem: { item: index } }))];
    }

    if (!each) {
      if (ctx.signal?.aborted) throw stopped();
      const child = await start(groups[0]);
      ctx.logger.info(`Sub-execution ${child.executionId} of “${workflow.name}”: ${child.status}`);
      if (child.status === 'waiting') {
        if (!ctx.putExecutionToWait) throw waitingInTool(child.executionId);
        // The parent waits as well; the runner resumes it with the child's final output (or fails it).
        ctx.putExecutionToWait({ resume: 'subworkflow', data: { executionId: child.executionId, workflowId: workflow.id } });
        return [items];
      }
      shareBinaryScope(child.executionId, undefined);
      if (child.status !== 'success') throw new NodeOperationError(childFailure(child));
      return [lastNodeItems(child).map((item) => ({ json: item.json, ...(item.binary && { binary: item.binary }), pairedItem: { item: 0 } }))];
    }

    // "each": one entry per item (in item order); a waiting child's stays open until it finishes (lib/server/sub-executions.ts).
    const children: EachChild[] = [];
    const continueOnFail = ctx.continueOnFail();
    const open = () => children.filter((child) => child && !child.status).map((child) => child.executionId);
    // Up to `limit` children run at once. The first failure (or the run stopping) starts no more and stops those running.
    const limit = Math.max(1, Math.floor(Number(options.concurrency) || EACH_CONCURRENCY));
    const halt = new AbortController();
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, halt.signal]) : halt.signal;
    let failure: unknown;
    let next = 0;
    const lane = async () => {
      while (next < groups.length && failure === undefined && !signal.aborted) {
        const index = next++;
        try {
          const child = await start(groups[index], undefined, signal);
          ctx.logger.info(`Sub-execution ${child.executionId} of “${workflow.name}” (item ${index}): ${child.status}`);
          if (child.status === 'waiting') {
            if (!ctx.putExecutionToWait) throw waitingInTool(child.executionId);
            children[index] = { item: index, executionId: child.executionId };
            continue;
          }
          shareBinaryScope(child.executionId, undefined);
          // A sibling stopped by the first failure comes back canceled: the node reports that first failure.
          if (child.status !== 'success' && !continueOnFail) throw new NodeOperationError(childFailure(child));
          children[index] = { item: index, executionId: child.executionId, ...finishedEntry(child, lastNodeItems(child)) };
        } catch (error) {
          failure ??= error;
          halt.abort();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, groups.length) }, lane));
    if (failure !== undefined || ctx.signal?.aborted) {
      // The node fails (or the run stopped): nothing waits for the children still waiting.
      void cancelSubExecutions(open()).catch(() => {});
      throw failure ?? stopped();
    }
    if (open().length) {
      // The parent waits for the children that wait; the last one to finish resumes it with every item's output.
      capInlineOutputs(children);
      const data: EachWait = { mode: 'each', workflowId: workflow.id, children, ...(continueOnFail && { continueOnFail: true }) };
      ctx.putExecutionToWait!({ resume: 'subworkflow', data: data as unknown as JsonObject });
      ctx.logger.info(`Waiting for ${open().length} of ${children.length} sub-executions of “${workflow.name}”`);
      return [items];
    }
    return [eachOutput(children)];
  },
});
