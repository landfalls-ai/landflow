/**
 * The Microsoft Bot credential (`core.microsoftBotApi`): an Azure Bot registration's app ID and client secret. Agents' Teams
 * channels use it to validate what the Bot Connector sends and to answer (lib/server/teams). The URLs are fields so a test
 * double (or a sovereign cloud) works.
 */
import { defineCredentialType } from '@landflow/sdk';
import { botToken, DEFAULT_OPENID_METADATA, resetTeamsCaches, teamsCredential } from '../teams';

export const microsoftBotCredential = defineCredentialType({
  name: 'microsoftBotApi',
  displayName: 'Microsoft Bot (Teams)',
  description:
    'An Azure Bot registration: its Microsoft App ID and a client secret. Set the bot’s messaging endpoint to the URL the agent’s Teams channel shows, and add the Microsoft Teams channel to the bot.',
  icon: 'lucide:messages-square',
  documentationUrl: 'https://learn.microsoft.com/azure/bot-service/bot-service-quickstart-registration',
  properties: [
    { name: 'appId', displayName: 'Microsoft App ID', type: 'string', default: '', required: true, placeholder: '00000000-0000-0000-0000-000000000000' },
    { name: 'appPassword', displayName: 'Client Secret', type: 'string', default: '', required: true, typeOptions: { password: true } },
    {
      name: 'tenantId',
      displayName: 'Tenant ID',
      type: 'string',
      default: '',
      placeholder: 'botframework.com',
      description: 'Single-tenant bots: the Entra tenant ID. Empty: botframework.com (multi-tenant registrations).',
    },
    { name: 'openIdMetadataUrl', displayName: 'OpenID Metadata URL', type: 'string', default: DEFAULT_OPENID_METADATA, description: 'Where the keys that sign incoming requests are published. Change it only for a test double.' },
    { name: 'tokenUrl', displayName: 'Token URL', type: 'string', default: '', description: 'Empty: the Microsoft identity platform’s token endpoint of the tenant' },
  ],
  async test(data) {
    try {
      resetTeamsCaches();
      await botToken(teamsCredential(data));
      return { ok: true, message: 'The Microsoft identity platform issued a bot token' };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  },
});
