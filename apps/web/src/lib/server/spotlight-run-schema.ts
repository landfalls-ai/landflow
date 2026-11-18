/**
 * AG23: the run body's Spotlight approvals (POST /api/workflows/:id/run). Request schemas stay server-side: a module the browser
 * loads builds no zod object (production CSP). The shape the client sends is `SpotlightRunApprovals` (lib/shared/fix-autonomy.ts).
 */
import { z } from 'zod';
import { SPOTLIGHT_APPROVALS } from '../shared/fix-autonomy';

export const spotlightRunFields = {
  /** Only an autonomous fix session's editor run may carry it: Spotlight approves its tool calls to given destinations. */
  approvals: z.literal(SPOTLIGHT_APPROVALS).optional(),
  sessionId: z.string().trim().min(1).max(64).optional(),
  destinations: z.array(z.string().max(2000)).max(50).optional(),
};

export const SPOTLIGHT_ONLY_EDITOR = 'Spotlight’s approvals apply only to an editor test run';
