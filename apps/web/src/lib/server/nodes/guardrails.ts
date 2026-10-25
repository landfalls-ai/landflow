/**
 * The Guardrails node (after n8n's): checks the text of each item against the
 * guardrails switched on below. "Check Text for Violations" routes the item to
 * Pass or Fail; "Sanitize Text" replaces what the pattern checks find and sends
 * every item on. Model checks (jailbreak by model, topical alignment, NSFW,
 * custom) use the chat model attached to the optional “Chat Model” slot.
 */
import { defineNode, NodeOperationError, type IExecuteContext, type JsonObject, type JsonValue, type NodeItem, type PropertyDescriptor } from '@landflow/sdk';
import type { LanguageModel } from '@landflow/engine';
import { listOf, needsModel, PII_ENTITIES, runGuardrails, type GuardrailsConfig, type GuardrailsMode, type PiiEntity, type Replacement, type SecretsPermissiveness } from '../guardrails';

const CHECK_ONLY = { operation: ['check'] };
const SANITIZE_ONLY = { operation: ['sanitize'] };

const PII_LABELS: Record<PiiEntity, string> = {
  EMAIL_ADDRESS: 'Email Address',
  PHONE_NUMBER: 'Phone Number',
  CREDIT_CARD: 'Credit Card Number (Luhn-checked)',
  IBAN_CODE: 'IBAN (checksum-verified)',
  IP_ADDRESS: 'IP Address (v4 and v6)',
  US_SSN: 'US Social Security Number',
  CRYPTO: 'Crypto Wallet Address',
};

const thresholdProperty = (name: string, show: Record<string, unknown[]>): PropertyDescriptor => ({
  name,
  displayName: 'Threshold',
  type: 'number',
  default: 0.7,
  typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
  description: 'Confidence (0–1) from which the text counts as a violation',
  displayOptions: { show: { ...CHECK_ONLY, ...show } },
});

const properties: PropertyDescriptor[] = [
  {
    name: 'operation',
    displayName: 'Operation',
    type: 'options',
    default: 'check',
    noDataExpression: true,
    options: [
      { name: 'Check Text for Violations', value: 'check', description: 'Send each item to Pass or Fail', action: 'Check text for violations' },
      { name: 'Sanitize Text', value: 'sanitize', description: 'Replace PII, secrets, keywords, URLs and custom patterns, and send every item on', action: 'Sanitize text' },
    ],
  },
  { name: 'text', displayName: 'Text To Check', type: 'string', default: '{{ $json.chatInput }}', required: true, typeOptions: { rows: 2 } },

  // PII
  { name: 'pii', displayName: 'PII', type: 'boolean', default: true, description: 'Personal data: emails, phone numbers, card numbers, IBANs, IP addresses…' },
  {
    name: 'piiEntities',
    displayName: 'PII Types',
    type: 'multiOptions',
    default: [...PII_ENTITIES],
    options: PII_ENTITIES.map((value) => ({ name: PII_LABELS[value], value })),
    displayOptions: { show: { pii: [true] } },
  },

  // Secrets
  { name: 'secrets', displayName: 'Secret Keys', type: 'boolean', default: true, description: 'API keys, tokens, private keys and passwords' },
  {
    name: 'secretsPermissiveness',
    displayName: 'Permissiveness',
    type: 'options',
    default: 'balanced',
    options: [
      { name: 'Strict', value: 'strict', description: 'Also any long random-looking string (more false positives)' },
      { name: 'Balanced', value: 'balanced', description: 'Known key formats and values assigned to key, token, secret or password' },
      { name: 'Permissive', value: 'permissive', description: 'Known key formats only' },
    ],
    displayOptions: { show: { secrets: [true] } },
  },

  // Keywords
  { name: 'keywords', displayName: 'Keywords', type: 'boolean', default: false, description: 'Words and phrases that must not appear' },
  {
    name: 'keywordList',
    displayName: 'Keyword List',
    type: 'string',
    default: '',
    placeholder: 'confidential, internal only',
    typeOptions: { rows: 2 },
    description: 'Comma- or newline-separated; case-insensitive, whole words',
    displayOptions: { show: { keywords: [true] } },
  },

  // URLs
  { name: 'urls', displayName: 'URLs', type: 'boolean', default: false, description: 'Block every URL that is not on the allow-list' },
  {
    name: 'allowedUrls',
    displayName: 'Allowed URLs',
    type: 'string',
    default: '',
    placeholder: 'example.com, *.docs.example.com, https://example.org/help',
    typeOptions: { rows: 2 },
    description: 'Domains, *.domains or URL prefixes, comma- or newline-separated. Empty blocks every URL.',
    displayOptions: { show: { urls: [true] } },
  },
  {
    name: 'allowedSchemes',
    displayName: 'Allowed Schemes',
    type: 'multiOptions',
    default: ['https'],
    options: ['https', 'http', 'ftp', 'mailto', 'tel', 'data', 'javascript'].map((value) => ({ name: value, value })),
    displayOptions: { show: { urls: [true] } },
  },
  { name: 'blockUserinfo', displayName: 'Block Credentials in URLs', type: 'boolean', default: true, description: 'URLs like https://user:pass@host', displayOptions: { show: { urls: [true] } } },
  { name: 'allowSubdomains', displayName: 'Allow Subdomains', type: 'boolean', default: false, description: 'example.com also allows docs.example.com', displayOptions: { show: { urls: [true] } } },

  // Custom regex
  {
    name: 'customRegex',
    displayName: 'Custom Regex',
    type: 'fixedCollection',
    typeOptions: { multipleValues: true },
    default: {},
    placeholder: 'Add pattern',
    description: 'Your own patterns, e.g. order numbers. Written as text or /pattern/flags.',
    groups: [
      {
        name: 'rules',
        displayName: 'Pattern',
        values: [
          { name: 'name', displayName: 'Name', type: 'string', default: '', placeholder: 'ORDER_NUMBER' },
          { name: 'pattern', displayName: 'Regex', type: 'string', default: '', placeholder: 'ORD-\\d{6}' },
        ],
      },
    ],
  },

  // Model and heuristic checks (check mode)
  {
    name: 'jailbreak',
    displayName: 'Jailbreak / Prompt Injection',
    type: 'boolean',
    default: true,
    description: 'Attempts to override instructions, extract the system prompt or get around safety rules',
    displayOptions: { show: CHECK_ONLY },
  },
  {
    name: 'jailbreakUseModel',
    displayName: 'Also Ask the Chat Model',
    type: 'boolean',
    default: false,
    description: 'Heuristics always run; with this on, the attached chat model also judges texts they don’t flag',
    displayOptions: { show: { ...CHECK_ONLY, jailbreak: [true] } },
  },
  thresholdProperty('jailbreakThreshold', { jailbreak: [true] }),
  {
    name: 'topical',
    displayName: 'Topical Alignment',
    type: 'boolean',
    default: false,
    description: 'Keep the conversation to a business scope (uses the chat model)',
    displayOptions: { show: CHECK_ONLY },
  },
  {
    name: 'topicalPrompt',
    displayName: 'Allowed Topics',
    type: 'string',
    default: '',
    required: true,
    placeholder: 'Questions about our products, orders, shipping and returns',
    typeOptions: { rows: 3 },
    displayOptions: { show: { ...CHECK_ONLY, topical: [true] } },
  },
  thresholdProperty('topicalThreshold', { topical: [true] }),
  { name: 'nsfw', displayName: 'NSFW', type: 'boolean', default: false, description: 'Sexual, violent, hateful or self-harm content (uses the chat model)', displayOptions: { show: CHECK_ONLY } },
  thresholdProperty('nsfwThreshold', { nsfw: [true] }),
  {
    name: 'customChecks',
    displayName: 'Custom Checks',
    type: 'fixedCollection',
    typeOptions: { multipleValues: true },
    default: {},
    placeholder: 'Add check',
    description: 'Your own rules, judged by the chat model',
    displayOptions: { show: CHECK_ONLY },
    groups: [
      {
        name: 'checks',
        displayName: 'Check',
        values: [
          { name: 'name', displayName: 'Name', type: 'string', default: '', placeholder: 'Competitors' },
          { name: 'prompt', displayName: 'Flag the Text If…', type: 'string', default: '', typeOptions: { rows: 2 }, placeholder: 'it mentions or recommends a competitor' },
          { name: 'threshold', displayName: 'Threshold', type: 'number', default: 0.7, typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 } },
        ],
      },
    ],
  },

  // Sanitize mode
  {
    name: 'replacement',
    displayName: 'Replace With',
    type: 'options',
    default: 'redact',
    options: [
      { name: 'Placeholder (Redact)', value: 'redact', description: 'e.g. <EMAIL_ADDRESS>' },
      { name: 'Partly Hidden (Mask)', value: 'mask', description: 'e.g. j***@example.com, ****-****-****-4242' },
    ],
    displayOptions: { show: SANITIZE_ONLY },
  },
  {
    name: 'outputField',
    displayName: 'Put Output in Field',
    type: 'string',
    default: 'text',
    description: 'The sanitized text goes here; use the input field’s name (e.g. chatInput) to replace it',
    displayOptions: { show: SANITIZE_ONLY },
  },
];

/** The guardrails item `i` turns on. */
function configFor(ctx: IExecuteContext, i: number): GuardrailsConfig {
  const param = <T>(name: string, fallback: T) => (ctx.getNodeParameter<T>(name, i, fallback) ?? fallback) as T;
  const on = (name: string) => param<unknown>(name, false) === true;
  const customRegex = (param<{ rules?: Array<{ name?: string; pattern?: string }> }>('customRegex', {}).rules ?? []).map((r) => ({ name: String(r.name ?? ''), pattern: String(r.pattern ?? '') }));
  const custom = (param<{ checks?: Array<{ name?: string; prompt?: string; threshold?: number }> }>('customChecks', {}).checks ?? []).map((c) => ({
    name: String(c.name ?? ''),
    prompt: String(c.prompt ?? ''),
    ...(typeof c.threshold === 'number' && { threshold: c.threshold }),
  }));
  const topicalPrompt = String(param('topicalPrompt', '')).trim();
  if (on('topical') && !topicalPrompt) throw new NodeOperationError('Topical Alignment needs the allowed topics', { itemIndex: i, description: 'Describe what the conversation may be about in “Allowed Topics”.' });
  return {
    ...(on('pii') && { pii: { entities: param<PiiEntity[]>('piiEntities', [...PII_ENTITIES]) } }),
    ...(on('secrets') && { secrets: { permissiveness: param<SecretsPermissiveness>('secretsPermissiveness', 'balanced') } }),
    ...(on('keywords') && { keywords: { list: listOf(param('keywordList', '')) } }),
    ...(on('urls') && {
      urls: {
        allowed: listOf(param('allowedUrls', '')),
        schemes: param<string[]>('allowedSchemes', ['https']),
        blockUserinfo: param<unknown>('blockUserinfo', true) !== false,
        allowSubdomains: on('allowSubdomains'),
      },
    }),
    ...(customRegex.length && { customRegex }),
    ...(on('jailbreak') && { jailbreak: { threshold: Number(param('jailbreakThreshold', 0.7)), useModel: on('jailbreakUseModel') } }),
    ...(on('topical') && { topical: { prompt: topicalPrompt, threshold: Number(param('topicalThreshold', 0.7)) } }),
    ...(on('nsfw') && { nsfw: { threshold: Number(param('nsfwThreshold', 0.7)) } }),
    ...(custom.length && { custom }),
  };
}

export const guardrailsNode = defineNode({
  description: {
    name: 'guardrails',
    displayName: 'Guardrails',
    description: 'Check text for PII, secrets, jailbreaks, off-topic requests and blocked URLs, or sanitize it',
    version: 1,
    kind: 'action',
    categories: ['AI', 'Guardrails'],
    icon: 'lucide:shield-check',
    color: '#16a34a',
    subtitle: '{{operation}}',
    keywords: ['guardrails', 'pii', 'redact', 'mask', 'sanitize', 'jailbreak', 'prompt injection', 'moderation', 'nsfw', 'secrets', 'safety', 'url allow list'],
    inputs: [{ type: 'main' }, { type: 'ai_languageModel', displayName: 'Chat Model', maxConnections: 1 }],
    outputs: [
      { type: 'main', displayName: 'Pass' },
      { type: 'main', displayName: 'Fail', displayOptions: { show: CHECK_ONLY } },
    ],
    properties,
  },

  async execute(ctx) {
    const mode = (ctx.getNodeParameter<GuardrailsMode>('operation', 0) ?? 'check') === 'sanitize' ? 'sanitize' : 'check';
    const items = ctx.getInputData();
    const pass: NodeItem[] = [];
    const fail: NodeItem[] = [];
    let model: LanguageModel | undefined;
    let modelLoaded = false;
    const log = (message: string) => ctx.logger.warn(message);

    for (const [i, item] of items.entries()) {
      const config = configFor(ctx, i);
      if (mode === 'check' && needsModel(config) && !modelLoaded) {
        modelLoaded = true;
        [model] = ctx.getInputConnectionData ? await ctx.getInputConnectionData<LanguageModel>('ai_languageModel') : [];
        if (!model) {
          throw new NodeOperationError('No chat model connected', {
            description: 'Topical alignment, NSFW, custom checks and “Also Ask the Chat Model” need a chat model on the “Chat Model” slot.',
          });
        }
      }
      const text = ctx.getNodeParameter('text', i);
      const outcome = await runGuardrails(typeof text === 'string' ? text : text === undefined || text === null ? '' : JSON.stringify(text), config, {
        mode,
        replacement: ctx.getNodeParameter<Replacement>('replacement', i, 'redact') === 'mask' ? 'mask' : 'redact',
        ...(model && { model }),
        ...(ctx.signal && { signal: ctx.signal }),
        log,
      });
      const report = { passed: outcome.passed, violations: outcome.violations, checks: outcome.checks } as unknown as JsonObject;
      if (mode === 'sanitize') {
        const field = String(ctx.getNodeParameter('outputField', i, 'text') || 'text');
        pass.push({ ...item, json: { ...item.json, [field]: outcome.text as JsonValue, guardrails: report }, pairedItem: { item: i } });
      } else {
        (outcome.passed ? pass : fail).push({ ...item, json: { ...item.json, guardrails: report }, pairedItem: { item: i } });
      }
    }
    return mode === 'sanitize' ? [pass] : [pass, fail];
  },
});
