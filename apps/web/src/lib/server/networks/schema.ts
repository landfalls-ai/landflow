/** Request bodies of the network routes (C29): the admin ones in Settings → Networks and the runner's own two. */
import { z } from 'zod';

export const networkCreateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300).optional(),
  /** Set: only this project's workflows may use the network. */
  projectId: z.string().trim().min(1).max(100).optional(),
});

export const networkUpdateSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(300).nullable().optional(),
});

export const runnerCreateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  /** Addresses (or CIDR ranges) the runner may connect from; empty: any. */
  allowedIps: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
});

/** What a runner says about itself on each poll. */
export const pollSchema = z.object({
  name: z.string().trim().max(100).optional(),
  version: z.string().trim().max(40).optional(),
  /** 0: only say "I am here" (the runner is at capacity); 1 (default): wait for a call. */
  max: z.number().int().min(0).max(1).optional(),
});

/** The answer a runner gives to one call (D12): a response, or why it could not make one. */
export const answerSchema = z.union([
  z.object({ status: z.number().int().min(100).max(599), headers: z.array(z.tuple([z.string(), z.string()])).max(500), body: z.string().optional() }),
  z.object({ error: z.object({ code: z.enum(['refused', 'timeout', 'network']), message: z.string().max(500) }) }),
]);
