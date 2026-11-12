/**
 * Entity (docs/second-brain.md#entities): the registry of initiatives, people, customers and systems the second brain
 * reasons about. Upsert, get, list and delete entities, and add a fact (a statement about one) that the brain keeps,
 * searches and weighs when something similar is proposed. A tool too, so an agent can keep its own notes on the things
 * it works with.
 *
 * A workflow sees and changes the entities in its own project (lib/server/brain/scope.ts), plus, when its creator can
 * open more, what the creator sees. New ones go to the workflow's project.
 */
import { defineNode, NodeOperationError, type JsonObject, type NodeItem } from '@landflow/sdk';
import { ENTITY_LABELS, ENTITY_TYPES, entityRef, FACT_KINDS, isEntityType, type FactKind } from '../../shared/brain';
import { homeProjectId } from '../projects/store';
import { store } from '../store';

const main = [{ type: 'main' as const }];
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as JsonObject;
const typeOptions = ENTITY_TYPES.map((t) => ({ name: ENTITY_LABELS[t], value: t }));

export const brainEntityNode = defineNode({
  description: {
    name: 'brainEntity',
    displayName: 'Entity',
    description: 'Keep initiatives, people, customers and systems in the second brain: create or update one, read, list or delete them, and add a fact about one',
    version: 1,
    kind: 'action',
    categories: ['AI', 'Core'],
    icon: 'lucide:network',
    color: '#8b5cf6',
    subtitle: '{{operation}}',
    keywords: ['entity', 'initiative', 'person', 'customer', 'system', 'second brain', 'registry', 'owner', 'fact', 'knowledge'],
    usableAsTool: true,
    toolDescription:
      'Keep a registry of initiatives, people, customers and systems. Arguments: `operation` (upsert, get, list, delete, addFact), `type` (initiative, person, customer, system), `entityId` (to update or name one; empty on upsert makes a new one), `name`, `description` (an initiative’s goal), `owner`, `attributes` (a JSON object of flat values), for list `owner` and `text` filters, for addFact `factKind` and `statement`.',
    inputs: main,
    outputs: main,
    properties: [
      {
        name: 'operation',
        displayName: 'Operation',
        type: 'options',
        default: 'upsert',
        options: [
          { name: 'Create or Update', value: 'upsert', description: 'Add an entity, or change the one with this ID' },
          { name: 'Get', value: 'get', description: 'One entity with its facts and open suggestions' },
          { name: 'List', value: 'list', description: 'Entities, filtered by type, owner or words' },
          { name: 'Delete', value: 'delete', description: 'Remove an entity with the facts about it' },
          { name: 'Add Fact', value: 'addFact', description: 'A statement about an entity the brain keeps' },
        ],
      },
      { name: 'type', displayName: 'Type', type: 'options', default: 'initiative', options: [{ name: 'Any', value: '' }, ...typeOptions], description: 'Any only filters a list' },
      { name: 'entityId', displayName: 'Entity ID', type: 'string', default: '', placeholder: 'invoice-reminders', description: 'Lowercase letters, digits, “_”, “-” and “.”. Empty on Create makes one from the name', displayOptions: { show: { operation: ['upsert', 'get', 'delete', 'addFact'] } } },
      { name: 'name', displayName: 'Name', type: 'string', default: '', displayOptions: { show: { operation: ['upsert'] } } },
      { name: 'description', displayName: 'Description or Goal', type: 'string', default: '', typeOptions: { rows: 3 }, description: 'Empty keeps what it has', displayOptions: { show: { operation: ['upsert'] } } },
      { name: 'owner', displayName: 'Owner', type: 'string', default: '', description: 'A user ID or a free name such as “Platform team”. For a list: only this owner’s', displayOptions: { show: { operation: ['upsert', 'list'] } } },
      { name: 'attributes', displayName: 'Attributes (JSON)', type: 'json', default: '{}', description: 'Flat values merged into what it has; null removes one', displayOptions: { show: { operation: ['upsert'] } } },
      { name: 'text', displayName: 'Words', type: 'string', default: '', description: 'Only entities whose name, description, owner or attributes have all these words', displayOptions: { show: { operation: ['list'] } } },
      { name: 'factKind', displayName: 'Kind', type: 'options', default: 'purpose', options: FACT_KINDS.map((k) => ({ name: k, value: k })), displayOptions: { show: { operation: ['addFact'] } } },
      { name: 'statement', displayName: 'Statement', type: 'string', default: '', typeOptions: { rows: 3 }, displayOptions: { show: { operation: ['addFact'] } } },
      { name: 'limit', displayName: 'Limit', type: 'number', default: 50, typeOptions: { minValue: 1, maxValue: 500 }, displayOptions: { show: { operation: ['list'] } } },
      { name: 'oneItem', displayName: 'As One Item', type: 'boolean', default: false, description: 'Output the whole list as one item', displayOptions: { show: { operation: ['list'] } } },
    ],
  },
  async execute(ctx) {
    const { addEntityFact, deleteEntity, EntityError, entityKey, entityKnowledge, getEntity, listEntities, upsertEntity } = await import('../brain/entities');
    const { listProposals } = await import('../brain/proposals');
    const { covers, scopeForWorkflow } = await import('../brain/scope');
    const runId = ctx.getWorkflowId();
    const scope = scopeForWorkflow(runId);
    // An agent's tools run as `agent:<id>`; new entities go to the project of whoever is running.
    const projectId = runId ? (runId.startsWith('agent:') ? homeProjectId('agent', runId.slice('agent:'.length)) : store.getWorkflow(runId) ? homeProjectId('workflow', runId) : undefined) : undefined;
    const source = runId?.startsWith('agent:') ? 'agent' : 'workflow';
    const items = ctx.getInputData();
    const out: NodeItem[] = [];
    for (let i = 0; i < Math.max(items.length, 1); i++) {
      const operation = ctx.getNodeParameter<string>('operation', i);
      const type = String(ctx.getNodeParameter('type', i, '') ?? '').trim();
      const id = String(ctx.getNodeParameter('entityId', i, '') ?? '').trim();
      const fail = (message: string) => new NodeOperationError(message, { itemIndex: i });
      if (operation !== 'list' && !isEntityType(type)) throw fail(`Choose a type: ${ENTITY_TYPES.join(', ')}`);
      if (operation === 'list' && type && !isEntityType(type)) throw fail(`Unknown type “${type}”`);
      if (operation !== 'list' && operation !== 'upsert' && !id) throw fail('Say which entity: its ID');
      // A name that exists must be one this workflow may see (what it can't see doesn't exist for it).
      const visible = (t: string, e: string) => covers(scope, { entity: entityRef(t, e) });
      try {
        switch (operation) {
          case 'upsert': {
            if (id && getEntity(type, id) && !visible(type, id)) throw fail(`No ${type} ${id}`);
            const raw = ctx.getNodeParameter('attributes', i, '{}');
            let attrs: Record<string, unknown> = {};
            try {
              attrs = typeof raw === 'string' ? (raw.trim() ? JSON.parse(raw) : {}) : ((raw ?? {}) as Record<string, unknown>);
            } catch {
              throw fail('Attributes (JSON) is not valid JSON');
            }
            const text = (name: string) => {
              const value = String(ctx.getNodeParameter(name, i, '') ?? '').trim();
              return value || undefined;
            };
            const result = upsertEntity({ type, ...(id && { id }), name: text('name'), description: text('description'), owner: text('owner'), ...(projectId && { projectId }), attrs, source });
            out.push({ json: json({ created: result.created, entity: result.entity }), pairedItem: { item: i } });
            break;
          }
          case 'get': {
            const entity = visible(type, id) ? getEntity(type, id) : undefined;
            if (!entity) throw fail(`No ${type} ${id}`);
            out.push({ json: json(entityKnowledge(entity, (ref) => listProposals({ status: 'open', scope, limit: 50 }).filter((p) => p.target.type === 'entity' && p.target.id === ref))), pairedItem: { item: i } });
            break;
          }
          case 'list': {
            const limit = Math.max(1, Math.min(500, Number(ctx.getNodeParameter('limit', i, 50)) || 50));
            const entities = listEntities({
              ...(type && { type }),
              owner: String(ctx.getNodeParameter('owner', i, '') ?? '').trim() || undefined,
              text: String(ctx.getNodeParameter('text', i, '') ?? '').trim() || undefined,
              scope,
              limit,
            });
            if (ctx.getNodeParameter('oneItem', i, false)) out.push({ json: json({ entities }), pairedItem: { item: i } });
            else out.push(...entities.map((e) => ({ json: json(e), pairedItem: { item: i } })));
            break;
          }
          case 'delete': {
            if (!visible(type, id) || !getEntity(type, id)) throw fail(`No ${type} ${id}`);
            out.push({ json: json({ deleted: deleteEntity(type, id), type, entityId: id }), pairedItem: { item: i } });
            break;
          }
          case 'addFact': {
            const entity = visible(type, id) ? getEntity(type, id) : undefined;
            if (!entity) throw fail(`No ${type} ${id}`);
            const kind = String(ctx.getNodeParameter('factKind', i, 'purpose')) as FactKind;
            if (!(FACT_KINDS as readonly string[]).includes(kind)) throw fail(`Unknown fact kind “${kind}”`);
            const fact = addEntityFact(entity, { kind, statement: String(ctx.getNodeParameter('statement', i, '') ?? '') });
            out.push({ json: json({ fact, entity: entityKey(entity) }), pairedItem: { item: i } });
            break;
          }
          default:
            throw fail(`Unknown operation ${operation}`);
        }
      } catch (caught) {
        if (caught instanceof EntityError) throw fail(caught.message);
        throw caught;
      }
    }
    return [out];
  },
});
