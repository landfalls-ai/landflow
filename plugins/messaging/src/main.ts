/**
 * Messaging — Telegram (with a polling trigger), Slack, Discord, WhatsApp
 * Business Cloud, Twilio (SMS, MMS, WhatsApp, calls) and Send Email (SMTP) for Landflow.
 *
 *   pnpm --filter @landflow/plugin-messaging start
 *
 * Serves HTTP on :7104 (with the MCP face at /mcp) and gRPC on :7204, then announces both endpoints to the Landflow
 * host (LANDFLOW_REGISTRY_URL, default http://127.0.0.1:3000). Brokers come from the environment
 * (docs/transports.md): `LANDFLOW_TRANSPORTS=http,grpc,kafka` with `LANDFLOW_KAFKA_URL=…` adds a Kafka face, and so on
 * for every kind in @landflow/transports. `LANDFLOW_MAX_CONCURRENCY` (default 16) caps the calls running node code at
 * once across every face, which is what keeps one replica under Twilio's API limits.
 *
 * MCP: on by default. In dev everything binds to loopback (`LANDFLOW_HOST`, default 127.0.0.1, or 0.0.0.0 when
 * `LANDFLOW_ADVERTISE_HOST` is set as in a container), where the face needs no token; on any other host set
 * `LANDFLOW_MCP_TOKEN` (or `LANDFLOW_MCP=off`). `--mcp-stdio` with
 * `LANDFLOW_MCP_CREDENTIALS=<file>` serves the tools to a local agent without Landflow.
 */
import { definePlugin } from '@landflow/sdk';
import { serve } from '@landflow/sdk/serve';
import { Discord, discordBotApi, discordOAuth2Api, discordWebhookApi } from './nodes/discord';
import { EmailSend, smtp } from './nodes/email-send';
import { Slack, slackApi, slackOAuth2Api } from './nodes/slack';
import { SlackActivityTrigger } from './nodes/slack-activity-trigger';
import { SlackTrigger } from './nodes/slack-trigger';
import { Telegram, telegramApi } from './nodes/telegram';
import { TelegramTrigger } from './nodes/telegram-trigger';
import { Twilio, twilioApi } from './nodes/twilio';
import { WhatsApp, whatsAppApi } from './nodes/whatsapp';

export const plugin = definePlugin({
  info: {
    id: 'messaging',
    name: 'Messaging',
    version: '0.1.0',
    description: 'Telegram, Slack, Discord, WhatsApp Business Cloud, Twilio (SMS, MMS, WhatsApp, calls) and SMTP email; reachable over HTTP, gRPC, any installed broker and MCP',
    icon: 'file:messaging.svg',
    color: '#229ED9',
    author: 'Landflow',
  },
  nodes: [Telegram, TelegramTrigger, Slack, SlackTrigger, SlackActivityTrigger, Discord, WhatsApp, Twilio, EmailSend],
  credentialTypes: [telegramApi, slackApi, slackOAuth2Api, discordBotApi, discordOAuth2Api, discordWebhookApi, whatsAppApi, twilioApi, smtp],
  // `file:` icons (plugin, nodes and credential types) are inlined from here as data: URLs when the manifest is built.
  iconDir: new URL('../icons/', import.meta.url),
});

/** Calls running node code at once, across every face (env LANDFLOW_MAX_CONCURRENCY overrides): Twilio's default API concurrency per account. */
export const DEFAULT_MAX_CONCURRENCY = 16;

if (import.meta.url === `file://${process.argv[1]}`) {
  await serve(plugin, {
    http: 7104,
    grpc: 7204,
    // Loopback in dev, so the MCP face runs without a token; in a container (LANDFLOW_ADVERTISE_HOST set) every face
    // listens on 0.0.0.0 and the MCP face needs LANDFLOW_MCP_TOKEN. LANDFLOW_HOST overrides either way.
    host: process.env.LANDFLOW_HOST ?? (process.env.LANDFLOW_ADVERTISE_HOST ? '0.0.0.0' : '127.0.0.1'),
    maxConcurrency: DEFAULT_MAX_CONCURRENCY,
    mcp: { token: process.env.LANDFLOW_MCP_TOKEN },
  });
}
