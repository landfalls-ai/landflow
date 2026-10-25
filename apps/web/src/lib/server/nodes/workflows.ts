/**
 * n8n's Execute Workflow: runs another workflow from its "When Called by a Workflow or Agent"
 * trigger and returns the output of its last node. The child is saved as its own execution, linked
 * to the parent (`parentExecutionId`, the parent's `subExecutions`), at most 10 levels deep. A child
 * that starts waiting puts the parent into "waiting" too (in "once" mode); the runner resumes the
 * parent with the child's final output.
 */
import { defineNode, NodeOperationError, type IExecuteContext, type JsonObject, type NodeItem } from '@landflow/sdk';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { ExecutionRecord } from '../../shared/types';
import { shareBinaryScope } from '../binary/access';
import { store } from '../store';

const main = [{ type: 'main' as const }];
const WORKFLOW_TRIGGER = 'core.workflowTrigger';
const TRIGGER_NAME = 'When Called by a Workflow or Agent';

interface TriggerField {
  name?: string;
  type?: string;
  description?: string;
  required?: boolean;
}

/** n8n stores the workflow as a resource locator (`{ __rl, value, mode }`); Landflow as the id. */
const workflowIdOf = (value: unknown) => String((value && typeof value === 'object' ? (value as { value?: unknown }).value : value) ?? '').trim();

const triggerOf = (workflow: Workflow): WorkflowNode | undefined => workflow.nodes.find((n) => n.type === WORKFLOW_TRIGGER && !n.disabled);

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
  const workflow = store.getWorkflow(id);
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

const failure = (child: ExecutionRecord) =>
  child.status === 'canceled' ? `The sub-workflow was canceled (execution ${child.executionId})` : `Sub-workflow failed: ${child.error?.message ?? 'unknown error'} (execution ${child.executionId})`;

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
          { name: 'Run Once for Each Item', value: 'each', description: 'One execution per item, one after another' },
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
    const wait = ctx.getNodeParameter<{ waitForSubWorkflow?: boolean }>('options', 0)?.waitForSubWorkflow !== false;
    const each = ctx.getNodeParameter('mode', 0) === 'each';
    const groups = each ? items.map((_, i) => [i]) : [items.map((_, i) => i)];
    // Loaded lazily: the runner needs the registry this plugin is part of.
    const { runWorkflow } = await import('../runner');
    const parent = { executionId: ctx.getExecutionId(), nodeId: ctx.getNode().id };
    // A poll-started parent's children are ordinary trigger runs (only the trigger polls).
    const mode = ctx.mode === 'poll' ? 'trigger' : ctx.mode;
    // A child this run waits for writes its files into this run's scope, so the files it returns outlive it.
    const onChildStart = (id: string, onStart?: (id: string) => void) => {
      if (wait) shareBinaryScope(id, parent.executionId);
      onStart?.(id);
    };
    const start = (indexes: number[], onStart?: (id: string) => void) =>
      runWorkflow({ workflow, mode, startNodeId: trigger.id, triggerItems: childItems(ctx, indexes), parent, ...(wait && ctx.signal && { signal: ctx.signal }), onStart: (id) => onChildStart(id, onStart) }).catch(
        (error: Error) => {
          throw new NodeOperationError(error.message);
        },
      );

    if (!wait) {
      for (const indexes of groups) {
        const id = await new Promise<string>((resolve, reject) => {
          start(indexes, resolve).catch(reject);
        });
        ctx.logger.info(`Started sub-execution ${id} of “${workflow.name}”`);
      }
      return [items.map((item, index) => ({ ...item, pairedItem: { item: index } }))];
    }

    const output: NodeItem[] = [];
    for (const indexes of groups) {
      const child = await start(indexes);
      ctx.logger.info(`Sub-execution ${child.executionId} of “${workflow.name}”: ${child.status}`);
      if (child.status === 'waiting') {
        if (each || !ctx.putExecutionToWait) {
          throw new NodeOperationError('Sub-workflow is waiting; turn off ‘Wait for Sub-Workflow Completion’ or remove the Wait', {
            description: `Execution ${child.executionId} waits (it goes on by itself). Only “Run Once with All Items”, in a workflow execution, can wait for it.`,
          });
        }
        // The parent waits as well; the runner resumes it with the child's final output (or fails it).
        ctx.putExecutionToWait({ resume: 'subworkflow', data: { executionId: child.executionId, workflowId: workflow.id } });
        return [items];
      }
      shareBinaryScope(child.executionId, undefined);
      if (child.status !== 'success') throw new NodeOperationError(failure(child));
      const { lastNodeItems } = await import('../runner');
      for (const item of lastNodeItems(child)) output.push({ json: item.json, ...(item.binary && { binary: item.binary }), pairedItem: { item: indexes[0] ?? 0 } });
    }
    return [output];
  },
});
