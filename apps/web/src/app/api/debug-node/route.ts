/**
 * POST /api/debug-node: the one-node local override (docs/specs/19-debug-token.md). Bearer: a `runs:debug` debug token (not a
 * session or an API key: the path is public, the token is the credential). Body `{ executionId, node, pluginUrl }`: run that
 * node of the recorded execution against the plugin at `pluginUrl` (a host on the owner's allowed list) with the input it
 * had in that run. Works once per token, only while the owner's setting is on. The answer is tagged `debugRun: true` and is
 * not stored in the execution.
 */
import { z } from 'zod';
import { runDebugNode } from '@/lib/server/debug-node/run';
import { handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

const schema = z.object({ executionId: z.string().min(1).max(200), node: z.string().min(1).max(200), pluginUrl: z.string().min(1).max(2000) });

export const POST = handler(async (request: Request) => {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization')?.trim() ?? '');
  const body = await parseBody(request, schema);
  if (!body.ok) return body.response;
  const answer = await runDebugNode(match?.[1], body.data);
  return json(answer.body, answer.status);
});
