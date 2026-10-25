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
  alwaysOutputData: z.boolean().optional(),
  executeOnce: z.boolean().optional(),
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
    tags: z.array(z.string()).optional(),
    folderId: z.string().optional(),
  })
  .superRefine((workflow, ctx) => {
    const names = new Set<string>();
    for (const node of workflow.nodes) {
      if (names.has(node.name)) ctx.addIssue({ code: 'custom', message: `Duplicate node name "${node.name}"`, path: ['nodes'] });
      names.add(node.name);
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
