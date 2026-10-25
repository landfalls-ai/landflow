/**
 * Slack Interactivity: set this URL as the Slack app's Interactivity Request URL. Approve / Reject buttons of AI
 * Agent nodes and of agents answering in Slack land here. Public (lib/shared/auth-paths.ts): every request is
 * verified with a Slack credential's signing secret (lib/server/slack/handlers.ts).
 */
import { handler } from '@/lib/server/http';
import { handleSlackInteraction } from '@/lib/server/slack/handlers';

export const dynamic = 'force-dynamic';

export const POST = handler(async (request: Request) => handleSlackInteraction(request));
