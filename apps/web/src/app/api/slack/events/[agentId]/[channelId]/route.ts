/**
 * Slack Events API for an agent's Slack channel: set this URL as the Slack app's Event Subscriptions Request URL
 * (bot events `app_mention` and `message.im`). Public (lib/shared/auth-paths.ts): every request is verified with
 * the channel credential's signing secret (lib/server/slack/handlers.ts).
 */
import { handler } from '@/lib/server/http';
import { handleSlackEvent } from '@/lib/server/slack/handlers';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ agentId: string; channelId: string }> };

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { agentId, channelId } = await params;
  return handleSlackEvent(request, agentId, channelId);
});
