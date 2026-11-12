/**
 * POST /api/brain/backtest { detector, days?, step?, quiet?, threshold? } — rerun a detector as of past points over a window
 * and score what it finds against what people decided about its suggestions (docs/second-brain.md#backtesting-a-detector).
 * Owners and admins; waits for the run (a detector flow runs once per point, at most 40, five minutes in all). Nothing is
 * suggested. GET /api/brain/backtest?detector=&limit= lists the kept results, newest first.
 */
import { z } from 'zod';
import { BacktestError, backtestDetector, listBacktests } from '@/lib/server/brain/backtest';
import { listFlowDetectors } from '@/lib/server/brain/flow-detectors';
import { clusterActive } from '@/lib/server/cluster/state';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { isBuiltinDetector, isDetectorId, isFlowDetector } from '@/lib/shared/brain';

export const dynamic = 'force-dynamic';

const Body = z.object({
  detector: z.string().max(200),
  days: z.number().int().min(1).max(90).optional(),
  step: z.number().int().min(1).max(90).optional(),
  quiet: z.number().min(0.5).max(10).optional(),
  threshold: z.number().min(0).max(1).optional(),
});

export const POST = handler(async (request: Request) => {
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  const { detector, ...options } = parsed.data;
  if (isFlowDetector(detector)) {
    const flow = listFlowDetectors().find((f) => f.id === detector);
    if (!flow) return error(`No detector flow ${detector}`, 404);
    if (!flow.active) return error(`Publish “${flow.name}” to backtest it`, 409);
    if (clusterActive()) return error('Backtesting a detector flow needs regular execution mode (not queue mode)', 409);
  } else if (!isBuiltinDetector(detector)) return error(`Unknown detector ${detector}`);
  try {
    return json({ backtest: await backtestDetector(detector, { ...options, signal: request.signal }) });
  } catch (caught) {
    if (caught instanceof BacktestError) return error(caught.message, caught.status);
    throw caught;
  }
});

export const GET = handler(async (request: Request) => {
  const url = new URL(request.url);
  const detector = url.searchParams.get('detector') || undefined;
  if (detector && !isDetectorId(detector)) return error(`Unknown detector ${detector}`);
  const limit = Number(url.searchParams.get('limit')) || undefined;
  return json({ backtests: listBacktests({ detector: detector as never, limit }) });
});
