import { handler } from '@/lib/server/http';
import { llmsResponse } from '@/lib/server/llms';

export const dynamic = 'force-dynamic';

/** The docs for agents as one list of pages (docs/llms.txt). Public: no session, no key; cached for an hour. */
export const GET = handler(async (request: Request) => llmsResponse('llms.txt', request));
