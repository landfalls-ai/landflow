import { z } from 'zod';
import { connectionTypeSchema } from '@landflow/protocol';

export const workflowNodeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(3),
  typeVersion: z.number().int().positive().default(1),
  position: z.tuple([z.number(), z.number()]),
  parameters: z.record(z.string(), z.unknown()).default({}),
  /** Saved-credential references by credential type name; the secrets stay in the credential store. */
  credentials: z.record(z.string(), z.object({ id: z.string(), name: z.string() })).optional(),
  disabled: z.boolean().optional(),
  notes: z.string().optional(),
  onError: z.enum(['stop', 'continue']).optional(),
  retryOnFail: z.boolean().optional(),
  maxTries: z.number().int().min(1).max(10).optional(),
  waitBetweenTriesMs: z.number().int().min(0).max(60_000).optional(),
  /** Fail an attempt of the node that takes longer (retries and "continue on error" apply). */
  timeoutSeconds: z.number().min(0.1).max(86_400).optional(),
  alwaysOutputData: z.boolean().optional(),
  executeOnce: z.boolean().optional(),
  /** At most `limit` runs of the node per `intervalSeconds`, across executions; extra calls wait their turn. */
  rateLimit: z.object({ limit: z.number().int().min(1).max(100_000), intervalSeconds: z.number().min(0.1).max(86_400) }).optional(),
  /** Trigger nodes: collapse events with the same key within the window into one run (lib/server/trigger-buffers.ts). */
  debounce: z
    .object({
      windowSeconds: z.number().min(0.1).max(86_400),
      key: z.string().max(2_000).optional(),
      mode: z.enum(['last', 'all']).optional(),
      maxWaitSeconds: z.number().min(0).max(604_800).optional(),
    })
    .optional(),
  /** Trigger nodes: run once per `size` events or `timeoutSeconds` after the first, with all of them as items. */
  batch: z.object({ size: z.number().int().min(1).max(10_000), timeoutSeconds: z.number().min(0.1).max(86_400) }).optional(),
});

/** A canvas group: a labelled frame around nodes (`nodeIds`), expanded size and an optional collapsed state. */
export const workflowGroupSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().max(200),
  nodeIds: z.array(z.string()).max(5000).default([]),
  position: z.tuple([z.number(), z.number()]),
  width: z.number().min(40).max(20_000),
  height: z.number().min(40).max(20_000),
  color: z.number().int().min(0).max(9).optional(),
  collapsed: z.boolean().optional(),
  /** Nested groups: the group this one sits in. */
  parentId: z.string().min(1).max(100).optional(),
});

export const workflowSchema = z
  .object({
    id: z.string().regex(/^[\w-]+$/).optional(),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    nodes: z.array(workflowNodeSchema).default([]),
    connections: z
      .array(
        z.object({
          id: z.string(),
          type: connectionTypeSchema,
          source: z.string(),
          sourceIndex: z.number().int().min(0),
          target: z.string(),
          targetIndex: z.number().int().min(0),
        }),
      )
      .default([]),
    active: z.boolean().optional(),
    pinData: z.record(z.string(), z.array(z.object({ json: z.record(z.string(), z.unknown()) }))).optional(),
    settings: z
      .object({
        timeoutSeconds: z.number().int().min(1).max(86_400).optional(),
        errorWorkflowId: z.string().optional(),
        timezone: z.string().max(64).optional(),
        callerPolicy: z.enum(['any', 'none', 'list']).optional(),
        callerIds: z.array(z.string()).optional(),
        saveSuccessfulExecutions: z.boolean().optional(),
        saveFailedExecutions: z.boolean().optional(),
        saveManualExecutions: z.boolean().optional(),
        /** Minutes one successful run saves (Insights). */
        timeSavedMinutes: z.number().min(0).max(100_000).optional(),
        /** Durable runtime: production runs at once (0 = no limit), one at a time, and what happens to the extra ones. */
        concurrencyLimit: z.number().int().min(0).max(1000).optional(),
        singleton: z.boolean().optional(),
        concurrencyOverflow: z.enum(['queue', 'skip']).optional(),
        concurrencyQueueSize: z.number().int().min(1).max(10_000).optional(),
        /** Automatic retries of failed production runs: attempts in all (2+ enables) and the first delay (doubling). */
        retryMaxAttempts: z.number().int().min(1).max(10).optional(),
        retryBaseDelaySeconds: z.number().int().min(0).max(86_400).optional(),
        /** AI usage caps (0 or absent = none): tokens or estimated USD per execution, and per day for the workflow. */
        aiMaxTokensPerExecution: z.number().int().min(0).optional(),
        aiMaxCostPerExecution: z.number().min(0).optional(),
        aiMaxTokensPerDay: z.number().int().min(0).optional(),
        aiMaxCostPerDay: z.number().min(0).optional(),
      })
      .optional(),
    stickyNotes: z
      .array(
        z.object({
          id: z.string(),
          content: z.string().max(20_000),
          position: z.tuple([z.number(), z.number()]),
          width: z.number().min(40).max(4000),
          height: z.number().min(40).max(4000),
          color: z.number().int().min(0).max(9).optional(),
        }),
      )
      .optional(),
    /** Canvas groups (lib/shared/groups.ts): frames around nodes, editor-only like sticky notes. */
    groups: z.array(workflowGroupSchema).max(500).optional(),
    tags: z.array(z.string()).optional(),
    folderId: z.string().optional(),
  })
  .superRefine((workflow, ctx) => {
    const names = new Set<string>();
    for (const node of workflow.nodes) {
      if (names.has(node.name)) ctx.addIssue({ code: 'custom', message: `Duplicate node name "${node.name}"`, path: ['nodes'] });
      names.add(node.name);
    }
    // A node sits in one group at most; ids of nodes that are gone are tolerated (the editor drops them on its next save).
    const groupIds = new Set<string>();
    const grouped = new Map<string, string>();
    for (const group of workflow.groups ?? []) {
      if (groupIds.has(group.id)) ctx.addIssue({ code: 'custom', message: `Duplicate group id "${group.id}"`, path: ['groups'] });
      groupIds.add(group.id);
      for (const nodeId of group.nodeIds) {
        if (grouped.has(nodeId) && grouped.get(nodeId) !== group.id) ctx.addIssue({ code: 'custom', message: `Node "${nodeId}" is in two groups`, path: ['groups'] });
        grouped.set(nodeId, group.id);
      }
    }
    // Nested groups can't hold themselves; a parent that is gone is tolerated like a gone node.
    const parentOf = new Map((workflow.groups ?? []).flatMap((g) => (g.parentId ? [[g.id, g.parentId] as const] : [])));
    for (const id of parentOf.keys()) {
      const seen = new Set([id]);
      for (let at = parentOf.get(id); at; at = parentOf.get(at)) {
        if (seen.has(at)) {
          if (at === id) ctx.addIssue({ code: 'custom', message: `Group "${id}" is inside itself`, path: ['groups'] });
          break;
        }
        seen.add(at);
      }
    }
  });

/** What the editor sends about a node's run to the assistant (lib/shared/assistant-ops RunDigest). */
const portDigestSchema = z.object({ count: z.number().int().min(0), sample: z.array(z.unknown()).max(10) });
export const runDigestSchema = z.object({
  status: z.string(),
  durationMs: z.number().default(0),
  error: z.object({ message: z.string(), description: z.string().optional() }).optional(),
  inputs: z.array(portDigestSchema).max(10).default([]),
  outputs: z.array(portDigestSchema).max(10).default([]),
  logs: z.array(z.string()).max(20).optional(),
});
