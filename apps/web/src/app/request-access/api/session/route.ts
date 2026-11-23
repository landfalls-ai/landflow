/**
 * GET /request-access/api/session (requester session): who is signed in: `{ requester: { email, name, verifiedBy }, chat }`; `chat` is true only when the access chat is set up and the outsiders' hourly cap is above 0. 401
 * `{ error: 'signed_out' }` without a valid session (ended, idle for 2 hours, past 8 hours, blocked, domain removed, or the address became a
 * Landflow user's). The page calls this on load to decide between its sign-in card and its tabs.
 */
import { json } from '@/lib/server/http';
import { outsideChatAvailable } from '@/lib/server/access/chat';
import { outsideRoute } from '@/lib/server/access/outside/http';

export const dynamic = 'force-dynamic';

export const GET = outsideRoute(async ({ requester }) => json({ requester: { email: requester.email, name: requester.name, verifiedBy: requester.verifiedBy }, chat: outsideChatAvailable() }));
