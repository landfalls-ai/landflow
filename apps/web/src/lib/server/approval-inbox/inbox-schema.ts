/** Request bodies and queries of the approval inbox routes (docs/approval-inbox.md). */
import { z } from 'zod';

/** POST approve / deny: an empty body, or a note of up to 500 characters left with the decision. */
export const decisionBody = z.object({ note: z.string().max(500).optional() }).strict();

/** GET list: `?status=waiting|all` (default waiting) and `?executionId=`. */
export const listQuery = z.object({ status: z.enum(['waiting', 'all']).optional(), executionId: z.string().min(1).max(200).optional() });
