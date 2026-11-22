import { handler } from '@/lib/server/http';
import { llmsResponse } from '@/lib/server/llms';

export const dynamic = 'force-dynamic';

/** The published docs, whole, in reading order (docs/llms-full.txt, built by pnpm docs:llms). Public: no session, no key; cached for an hour. */
export const GET = handler(async () => llmsResponse('llms-full.txt'));
