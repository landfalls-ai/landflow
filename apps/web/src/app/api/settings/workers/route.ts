/**
 * GET /api/settings/workers — queue mode at a glance (Settings → Workers, read-only): this process, the leader and its
 * fencing token, the job queue (waiting / held by workers) and every main and worker with a current heartbeat. In
 * regular mode: `{ mode: 'regular', … }` for the one process. See lib/server/cluster.
 */
import { clusterOverview } from '@/lib/server/cluster';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json(await clusterOverview()));
