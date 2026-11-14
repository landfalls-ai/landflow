/** Request builders for the landledger plugin. Fake keys only; nothing here talks to a real service. */
import { runNode, runTestCredentials, type ExecuteRequest, type ExecuteResponse, type INodeType, type JsonObject } from '@landflow/sdk';
import { plugin } from '../src/main';
import { KEY, RELAY_KEY, SLACK_CHANNEL, type FakeLandledger } from './fake-landledger';
import { slackSignature } from '@landflow/sdk';

export interface RequestOptions {
  credentials?: Record<string, JsonObject>;
  items?: JsonObject[];
  mode?: ExecuteRequest['mode'];
  continueOnFail?: boolean;
  idempotencyKey?: string;
}

export function executeRequest(type: string, parameters: JsonObject, options: RequestOptions = {}): ExecuteRequest {
  const items = options.items ?? [{}];
  return {
    protocol: 'landflow.plugin/v1',
    executionId: 'ex_test',
    workflowId: 'wf_test',
    mode: options.mode ?? 'manual',
    node: { id: 'n1', name: 'Node', type: `landledger.${type}`, typeVersion: 1 },
    parameters,
    itemParameters: items.map(() => ({ ...parameters })),
    inputs: [items.map((json) => ({ json }))],
    ...(options.credentials && { credentials: options.credentials }),
    ...(options.continueOnFail && { continueOnFail: true }),
    ...(options.idempotencyKey && { idempotencyKey: options.idempotencyKey }),
  };
}

export const extras = { credentialTypes: plugin.credentialTypes, pluginId: 'landledger' };

export function run(node: INodeType, parameters: JsonObject, options: RequestOptions = {}): Promise<ExecuteResponse> {
  return runNode(node, executeRequest(node.description.name, parameters, options), extras);
}

export function testCredentials(data: JsonObject, credentialType: 'landledgerApi' | 'landledgerRelayApi' = 'landledgerApi') {
  return runTestCredentials(plugin, { credentialType, data });
}

export const jsonOf = (response: ExecuteResponse) => response.outputs[0].map((item) => item.json);

export const credentials = (fake: FakeLandledger, overrides: JsonObject = {}): Record<string, JsonObject> => ({ landledgerApi: { baseUrl: fake.url, apiKey: KEY, webhookSecret: '', ...overrides } });

/** The relay node's credential (a decisions:relay key). */
export const relayCredentials = (fake: FakeLandledger, apiKey = RELAY_KEY): Record<string, JsonObject> => ({ landledgerRelayApi: { baseUrl: fake.url, apiKey } });

/** A Slack block_actions press on a Landledger card, form-encoded and signed as Slack would send it. */
export function slackPress(options: { user?: string; actionId?: string; value: string; team?: string; app?: string; secret?: string; timestamp?: number; channel?: string; ts?: string }) {
  const payload = {
    type: 'block_actions',
    team: { id: options.team ?? SLACK_CHANNEL.teamId, domain: 'landdev' },
    api_app_id: options.app ?? SLACK_CHANNEL.appId,
    user: { id: options.user ?? 'U_AMIT', username: (options.user ?? 'U_AMIT').toLowerCase(), team_id: options.team ?? SLACK_CHANNEL.teamId },
    container: { type: 'message', channel_id: options.channel ?? 'D_AMIT', message_ts: options.ts ?? '1700000002.000100' },
    trigger_id: `trig_${Math.random().toString(36).slice(2)}`,
    actions: [{ type: 'button', action_id: options.actionId ?? 'landledger.approve', block_id: 'landledger_decision', value: options.value, action_ts: '1700000003.0' }],
  };
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  return { payload, body, timestamp, signature: slackSignature(options.secret ?? SLACK_CHANNEL.signingSecret, body, timestamp) };
}
