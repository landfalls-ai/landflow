/** Live SSE feed of registry + execution events for every open editor/dashboard (lib/server/events-stream.ts). */
import { eventStream } from '@/lib/server/events-stream';
import { handler } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async (request: Request) => eventStream(request));
