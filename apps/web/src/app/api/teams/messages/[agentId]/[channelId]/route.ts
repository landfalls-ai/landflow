/**
 * Bot Framework messaging endpoint of an agent's Microsoft Teams channel: set this URL as the bot registration's messaging
 * endpoint. Public (lib/shared/auth-paths.ts): every request carries a JWT that lib/server/teams validates against the
 * registration's OpenID metadata, for this bot's app id.
 */
import { handler } from '@/lib/server/http';
import { handleTeamsActivity } from '@/lib/server/teams/handlers';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ agentId: string; channelId: string }> };

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { agentId, channelId } = await params;
  return handleTeamsActivity(request, agentId, channelId);
});
