/**
 * Project keys (C31): the data key each project's credentials are sealed with. Owner only, session only, like root
 * rotation (policy: `settings:manage`).
 *
 * GET  — per project its active version, its retired versions and how many credentials are sealed with it; how many
 *        credentials are still on the key ring; keys this process can't unwrap.
 * POST { action: 'migrate' } — every credential onto its project's key, one at a time. Idempotent: run it again after an
 *        interruption or when `done` is false. Also deletes keys retired for 15 minutes that no credential names (keys of projects that are gone are retired first).
 * POST { action: 'revert' } — every credential back onto the ring's primary key as a version 2 value: run it before
 *        a downgrade to a host without project keys, and check that `onProjectKeys` is 0 (a save in between puts one back).
 * Both POSTs are audited fail-closed: with `LANDFLOW_AUDIT_FAIL_CLOSED=true` and no audit storage they answer 503.
 */
import { z } from 'zod';
import { requireUser } from '@/lib/server/auth';
import { projectKeys } from '@/lib/server/credentials/project-keys';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { getProject } from '@/lib/server/projects/store';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const user = await requireUser();
  if (user.role !== 'owner') return error('Only the owner can see the project keys', 403);
  return json(projectKeys.status((id) => getProject(id)?.name));
});

export const POST = handler(async (request: Request) => {
  const user = await requireUser();
  if (user.role !== 'owner') return error('Only the owner can move credentials between keys', 403);
  const body = await parseBody(request, z.object({ action: z.enum(['migrate', 'revert']) }));
  if (!body.ok) return body.response;
  const result = body.data.action === 'migrate' ? await projectKeys.migrate((id) => Boolean(getProject(id))) : projectKeys.revert();
  return json(result);
});
