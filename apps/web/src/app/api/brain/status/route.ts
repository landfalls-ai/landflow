/** GET /api/brain/status — what the second brain holds and when it last looked (docs/second-brain.md). */
import { brainStatus } from '@/lib/server/brain';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json(brainStatus()));
