/**
 * SB19's scenarios: the model Spotlight uses. A model the server does not offer is refused (400, the message the
 * Spotlight panel shows); with none asked the local default is used; a gateway model is picked live only.
 */
import { defineScenarios, type Check } from './scenario';

const refused: Check = { id: 'expects-error', label: 'The unlisted model is refused with the server’s words', judge: (o) => /Not a model this server offers/.test(o.error ?? '') };
const noCall: Check = { id: 'no-call', label: 'No draft came of it', judge: (o) => !o.draft };
// AG02: the default is whatever the server names (`hostModel`, LANDFLOW_BUILDER_MODEL), so the check holds on Claude too; without it, a bare Ollama name as before.
const bareName = (m: string) => m.replace(/^(?:ollama|anthropic|openai)\//, '');
const localDefault: Check = { id: 'local-default', label: 'Spotlight built on the model the server names as its default', judge: (o) => !o.error && Boolean(o.model) && (o.hostModel ? bareName(String(o.model)) === bareName(o.hostModel) : !String(o.model).includes('/')) };
const viaGateway: Check = { id: 'via-gateway', label: 'Spotlight built on the gateway model', judge: (o) => !o.error && String(o.model).startsWith('litellm/') };
const noError: Check = { id: 'no-error', label: 'No error', judge: (o) => !o.error };

const ASK = 'When a webhook receives an order, set a field called seen to true, then respond with ok';
const draft = JSON.stringify({
  name: 'Orders seen',
  nodes: [
    { key: 'hook', type: 'core.webhook', name: 'Order in', parameters: { path: 'orders' } },
    { key: 'ok', type: 'core.respondToWebhook', name: 'Reply ok', parameters: {} },
  ],
  connections: [{ from: 'hook', to: 'ok' }],
  testData: [{ body: { id: 'o-1' } }],
});

// Integration (sb3): the build plans first by default, so the unit script answers the plan, then one call per step.
const staged = [
  {
    text: JSON.stringify({
      name: 'Orders seen',
      steps: [
        { key: 's1', type: 'core.webhook', name: 'Order in', does: 'Start when a webhook receives an order' },
        { key: 's2', type: 'core.set', name: 'Mark seen', does: 'Set a field called seen to true', from: 's1' },
        { key: 's3', type: 'core.respondToWebhook', name: 'Reply ok', does: 'Respond with ok', from: 's2' },
      ],
      assumptions: [],
      cannot: [],
    }),
  },
  { text: JSON.stringify({ parameters: { path: 'orders' }, testData: [{ body: { id: 'o-1' } }] }) },
  { text: JSON.stringify({ parameters: { mode: 'manual', fields: { values: [{ name: 'seen', type: 'boolean', value: 'true' }] } } }) },
  { text: JSON.stringify({ parameters: { respondWith: 'text', responseBody: 'ok' } }) },
];

export default defineScenarios([
  {
    id: 'sb19-unlisted-refused',
    owner: 'SB19',
    job: 'build',
    via: 'build',
    title: 'A model the server is not set up for is refused, not run on the server’s key',
    ask: ASK,
    start: { model: 'anthropic/claude-x' },
    script: [{ text: draft }],
    checks: [refused, noCall],
    live: { skip: 'The refusal needs no model: the unit form is the whole check' },
  },
  {
    id: 'sb19-default-local',
    owner: 'SB19',
    job: 'build',
    via: 'build',
    title: 'With no model asked, Spotlight builds on the local default',
    ask: ASK,
    script: staged, // Integration (sb3): was the one-shot `[draft]`
    checks: [localDefault, noError],
  },
  {
    id: 'sb19-gateway-pick',
    owner: 'SB19',
    job: 'build',
    via: 'build',
    title: 'A gateway model picked in the header builds through the local LiteLLM gateway',
    ask: ASK,
    start: { model: 'litellm/qwen3-coder:30b' },
    checks: [viaGateway, noError],
    live: process.env.LANDFLOW_LLM_GATEWAY_URL?.startsWith('http://127.0.0.1:') || process.env.LANDFLOW_LLM_GATEWAY_URL?.startsWith('http://localhost:') ? {} : { skip: 'LANDFLOW_LLM_GATEWAY_URL is not the local gateway of live-host.md section 3a' },
  },
]);
