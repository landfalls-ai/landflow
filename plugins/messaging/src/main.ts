/**
 * Messaging — Telegram (with a polling trigger), Slack, Discord, WhatsApp
 * Business Cloud and Send Email (SMTP) for Landflow.
 *
 *   pnpm --filter @landflow/plugin-messaging start
 *
 * Serves HTTP on :7104 and gRPC on :7204, then announces both endpoints to the
 * Landflow host (LANDFLOW_REGISTRY_URL, default http://127.0.0.1:3000).
 */
import { definePlugin } from '@landflow/sdk';
import { serve } from '@landflow/sdk/serve';
import { Discord, discordBotApi, discordWebhookApi } from './nodes/discord';
import { EmailSend, smtp } from './nodes/email-send';
import { Slack, slackApi } from './nodes/slack';
import { Telegram, telegramApi } from './nodes/telegram';
import { TelegramTrigger } from './nodes/telegram-trigger';
import { WhatsApp, whatsAppApi } from './nodes/whatsapp';

export const plugin = definePlugin({
  info: {
    id: 'messaging',
    name: 'Messaging',
    version: '0.1.0',
    description: 'Telegram, Slack, Discord, WhatsApp Business Cloud and SMTP email',
    icon: 'file:messaging.svg',
    color: '#229ED9',
    author: 'Landflow',
  },
  nodes: [Telegram, TelegramTrigger, Slack, Discord, WhatsApp, EmailSend],
  credentialTypes: [telegramApi, slackApi, discordBotApi, discordWebhookApi, whatsAppApi, smtp],
  // `file:` icons (plugin, nodes and credential types) are inlined from here as data: URLs when the manifest is built.
  iconDir: new URL('../icons/', import.meta.url),
});

if (import.meta.url === `file://${process.argv[1]}`) {
  await serve(plugin, { http: 7104, grpc: 7204 });
}
