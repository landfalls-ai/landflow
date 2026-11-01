/**
 * GET /api/executions/:id/agents → `{ members: [{ member, kind, state, since? }] }`: the team members of a running
 * execution that can be paused, and which are paused (`state`: `working`, `pausing`, `paused`). Memory of the server that
 * runs the execution; empty once it ended.
 */
import { handler, json } from '@/lib/server/http';
import { activeMembers } from '@/lib/server/agent-teams/pause';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => json({ members: activeMembers((await params).id) }));
