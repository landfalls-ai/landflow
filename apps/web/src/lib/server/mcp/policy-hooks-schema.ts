/** MCP policy hooks (C14): the request schemas for the hook routes and the answer a hook's service sends. Server only. */
import { z } from 'zod';
import { DEFAULT_HOOK_TIMEOUT_MS, MAX_HOOK_TIMEOUT_MS, MIN_HOOK_TIMEOUT_MS } from '../../shared/mcp-policy';

const methods = z.enum(['tools/call', 'resources/read', 'prompts/get']);
const glob = z.string().trim().min(1).max(200);
const list = z.array(glob).max(50);

const matchSchema = z.strictObject({
  hosts: list.default([]),
  pathPrefix: z.string().trim().max(200).optional(),
  tools: list.default([]),
  methods: z.array(methods).min(1).max(3).default(['tools/call']),
  projects: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
});

const url = z
  .string()
  .trim()
  .max(2_000)
  .refine((value) => {
    try {
      return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, 'Enter an http:// or https:// URL');

export const hookInput = z.strictObject({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  url,
  auth: z.enum(['hmac', 'bearer', 'none']).default('hmac'),
  credentialId: z.string().trim().min(1).max(200).optional(),
  timeoutMs: z.number().int().min(MIN_HOOK_TIMEOUT_MS).max(MAX_HOOK_TIMEOUT_MS).default(DEFAULT_HOOK_TIMEOUT_MS),
  failureMode: z.enum(['closed', 'open']).optional(),
  match: matchSchema.default({ hosts: [], tools: [], methods: ['tools/call'], projects: [] }),
});
export type HookInput = z.infer<typeof hookInput>;

/** A change: any field, `credentialId: null` clears it. */
export const hookPatch = z.strictObject({
  name: hookInput.shape.name.optional(),
  enabled: z.boolean().optional(),
  url: url.optional(),
  // Not `hookInput.shape.x.optional()`: a default inside an optional still fills in, and a patch must change only what it names.
  auth: z.enum(['hmac', 'bearer', 'none']).optional(),
  credentialId: z.string().trim().min(1).max(200).nullable().optional(),
  timeoutMs: z.number().int().min(MIN_HOOK_TIMEOUT_MS).max(MAX_HOOK_TIMEOUT_MS).optional(),
  failureMode: z.enum(['closed', 'open']).optional(),
  match: z.strictObject({ hosts: list.optional(), pathPrefix: z.string().trim().max(200).nullable().optional(), tools: list.optional(), methods: z.array(methods).min(1).max(3).optional(), projects: z.array(z.string().trim().min(1).max(100)).max(100).optional() }).optional(),
});
export type HookPatch = z.infer<typeof hookPatch>;

/** What a policy service must answer; extra keys are ignored. */
export const hookAnswer = z.object({
  decision: z.enum(['allow', 'deny']),
  reason: z.string().max(500).optional(),
  ruleId: z.string().max(200).optional(),
});
export type HookAnswer = z.infer<typeof hookAnswer>;

/** The stored document, checked on every read: one invalid hook makes the whole row unreadable (never a silent gap in the guard). */
export const storedHooks = z.object({
  hooks: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        enabled: z.boolean(),
        url: z.string().min(1),
        auth: z.enum(['hmac', 'bearer', 'none']),
        credentialId: z.string().optional(),
        timeoutMs: z.number().int().min(MIN_HOOK_TIMEOUT_MS).max(MAX_HOOK_TIMEOUT_MS),
        failureMode: z.enum(['closed', 'open']),
        match: z.object({ hosts: z.array(z.string()), pathPrefix: z.string().optional(), tools: z.array(z.string()), methods: z.array(methods).min(1), projects: z.array(z.string()) }),
        createdAt: z.string(),
        updatedAt: z.string(),
      }),
    )
    .max(100),
});
