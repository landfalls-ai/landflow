/**
 * POST /api/brain/run { what: detect|study|effects|all, detector? } — run the second brain now instead of waiting for its
 * hour (owners and admins). Waits for the run: `detect` and `effects` take a moment, `study` asks the model about each
 * changed workflow. `detector` runs that one detector only, built-in or a flow detector (`flow:<workflowId>`, published).
 */
import { z } from 'zod';
import { runBrain, runDetectors } from '@/lib/server/brain';
import { listFlowDetectors } from '@/lib/server/brain/flow-detectors';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { isBuiltinDetector, isFlowDetector } from '@/lib/shared/brain';

export const dynamic = 'force-dynamic';

const Body = z.object({ what: z.enum(['detect', 'study', 'effects', 'all']).default('detect'), detector: z.string().max(200).optional() });

export const POST = handler(async (request: Request) => {
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  const { what, detector } = parsed.data;
  if (detector === undefined) return json(await runBrain(what, { reason: 'run-now' }));
  if (isFlowDetector(detector)) {
    const flow = listFlowDetectors().find((f) => f.id === detector);
    if (!flow) return error(`No detector flow ${detector}`, 404);
    if (!flow.active) return error(`Publish “${flow.name}” to run it as a detector`, 409);
  } else if (!isBuiltinDetector(detector)) return error(`Unknown detector ${detector}`);
  return json({ detect: await runDetectors({ only: [detector], reason: 'run-now' }) });
});
