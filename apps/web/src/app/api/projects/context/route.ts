/**
 * GET /api/projects/context?repo=owner/name | ?projectId=…, &size=full|compact — a project's "Where this work fits" block for
 * a harness (docs/connect-your-harness.md#project-context). By repository: the projects the caller has a role in that list it
 * (never a 404); by id: that project, or 404 without a role. Scope `brain:read`.
 */
import { z } from 'zod';
import { handler, json, parseQuery } from '@/lib/server/http';
import { projectContextFor } from '@/lib/server/project-context/by-repo';
import { routeActor } from '@/lib/server/projects/http';
import { PROJECT_REPO } from '@/lib/shared/project-context-api';

export const dynamic = 'force-dynamic';

const querySchema = z
  .object({ repo: z.string().max(201).regex(PROJECT_REPO, 'Use owner/name').optional(), projectId: z.string().min(1).max(200).optional(), size: z.enum(['full', 'compact']).optional() })
  .refine((q) => q.repo || q.projectId, 'Give repo or projectId');

export const GET = handler(async (request: Request) => {
  const query = parseQuery(request, querySchema);
  if (!query.ok) return query.response;
  return json(projectContextFor(routeActor(), query.data));
});
