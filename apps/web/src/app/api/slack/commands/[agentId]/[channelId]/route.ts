/**
 * Slack slash commands for an agent's Slack channel: set this URL as the command's Request URL (Slash Commands → Create New
 * Command). Public (lib/shared/auth-paths.ts): every request is verified with the channel credential's signing secret
 * (lib/server/slack/handlers.ts). The command is acknowledged at once and answered on its `response_url`.
 */
import { handler } from '@/lib/server/http';
import { handleSlackCommand } from '@/lib/server/slack/handlers';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ agentId: string; channelId: string }> };

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { agentId, channelId } = await params;
  return handleSlackCommand(request, agentId, channelId);
});
