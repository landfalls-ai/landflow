/** Example workflows created on first boot so the editor isn't empty. */
import type { Workflow, WorkflowConnection, WorkflowNode } from '@landflow/engine';
import { store } from './store';
import { logger } from './telemetry';

const node = (id: string, name: string, type: string, x: number, y: number, parameters: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id,
  name,
  type,
  typeVersion: 1,
  position: [x, y],
  parameters,
  ...extra,
});

const edge = (source: string, target: string, sourceIndex = 0, targetIndex = 0, type: WorkflowConnection['type'] = 'main'): WorkflowConnection => ({
  id: `e_${source}_${sourceIndex}_${target}_${targetIndex}_${type}`,
  type,
  source,
  sourceIndex,
  target,
  targetIndex,
});

const reviews = {
  reviews: [
    { title: 'Absolutely Love It!', text: 'I love how fast this is, works great and the team is amazing', rating: 5 },
    { title: 'Meh, it is OK', text: 'It is fine I guess, nothing special about the setup', rating: 3 },
    { title: 'Broken after update', text: 'Terrible experience, the update broke everything and support was awful', rating: 1 },
    { title: 'Great value for teams', text: 'Great value, our team is happy and the plugins are excellent', rating: 4 },
  ],
};

const polyglotPipeline: Workflow = {
  id: 'wf_polyglot_pipeline',
  name: 'Polyglot review pipeline',
  description: 'TypeScript, Python and Go plugins in one flow — slugify, score sentiment, hash, branch and aggregate.',
  tags: ['demo', 'plugins'],
  nodes: [
    node('trigger', 'Run', 'core.manualTrigger', 0, 120),
    node('reviews', 'Sample reviews', 'core.set', 325, 120, { mode: 'json', json: JSON.stringify(reviews, null, 2), includeOtherFields: false, splitArray: 'reviews' }),
    node('slug', 'Slugify title', 'text-toolkit.slugify', 650, 120, { field: 'title', outputField: 'slug', separator: '-' }),
    node('sentiment', 'Score sentiment', 'py-insights.sentiment', 975, 120, { field: 'text', outputField: 'sentiment' }),
    node('hash', 'Fingerprint', 'go-crypto.hash', 1300, 120, { algorithm: 'sha256', field: 'slug', encoding: 'hex', outputField: 'id' }),
    node('if', 'Is positive?', 'core.if', 1625, 40, {
      conditions: { condition: [{ left: '{{ $json.sentiment.label }}', operator: 'equals', right: 'positive' }] },
      combinator: 'and',
    }),
    node('shout', 'Shout title', 'text-toolkit.changeCase', 1950, -40, { field: 'title', case: 'upper', inPlace: true }),
    node('flag', 'Flag for review', 'core.set', 1950, 140, {
      mode: 'manual',
      fields: { values: [{ name: 'needsReview', type: 'boolean', value: 'true' }, { name: 'reason', type: 'string', value: 'Sentiment {{ $json.sentiment.label }} ({{ $json.sentiment.score }})' }] },
      includeOtherFields: true,
    }),
    node('stats', 'Rating stats', 'py-insights.stats', 1625, 260, { field: 'rating' }),
  ],
  connections: [
    edge('trigger', 'reviews'),
    edge('reviews', 'slug'),
    edge('slug', 'sentiment'),
    edge('sentiment', 'hash'),
    edge('hash', 'if'),
    edge('hash', 'stats'),
    edge('if', 'shout', 0),
    edge('if', 'flag', 1),
  ],
};

const agent: Workflow = {
  id: 'wf_polyglot_agent',
  name: 'Polyglot AI agent',
  description: 'An agent whose tools are plugins written in Go, Python and TypeScript. Runs on a local Ollama model — swap in Claude anytime.',
  tags: ['demo', 'ai'],
  nodes: [
    node('chat', 'Chat message', 'core.chatTrigger', 0, 120),
    node('agent', 'Agent', 'core.aiAgent', 300, 100, {
      prompt: '{{ $json.chatInput }}',
      systemMessage:
        'You are Landflow’s demo agent. Your tools are remote plugins: hash text (Go), score sentiment and extract keywords (Python), slugify text (TypeScript), and a calculator. Prefer tools over guessing; say which tool you used.',
      options: { maxIterations: 8, sessionId: '{{ $json.sessionId }}', returnIntermediateSteps: true },
    }),
    node('reply', 'Reply', 'core.set', 640, 120, { mode: 'manual', fields: { values: [{ name: 'reply', type: 'string', value: '{{ $json.output }}' }] }, includeOtherFields: true }),
    node('model', 'Ollama', 'core.ollamaChatModel', 120, 380, { baseUrl: 'http://127.0.0.1:11434', model: 'qwen3-coder:30b', temperature: 0.2 }),
    node('memory', 'Memory', 'core.simpleMemory', 280, 380, { turns: 10 }),
    node('calc', 'Calculator', 'core.calculatorTool', 440, 380),
    node('hash', 'Hash', 'go-crypto.hash', 580, 380, { algorithm: 'sha256', field: 'value', encoding: 'hex', outputField: 'hash' }, { notes: 'Hash the `value` argument with SHA-256 (or the algorithm you pass).' }),
    node('sentiment', 'Sentiment', 'py-insights.sentiment', 720, 380, { field: 'text', outputField: 'sentiment' }, { notes: 'Score the sentiment of the `text` argument.' }),
    node('slugify', 'Slugify', 'text-toolkit.slugify', 860, 380, { field: 'text', outputField: 'slug' }),
  ],
  connections: [
    edge('chat', 'agent'),
    edge('agent', 'reply'),
    edge('model', 'agent', 0, 0, 'ai_languageModel'),
    edge('memory', 'agent', 0, 0, 'ai_memory'),
    edge('calc', 'agent', 0, 0, 'ai_tool'),
    edge('hash', 'agent', 0, 0, 'ai_tool'),
    edge('sentiment', 'agent', 0, 0, 'ai_tool'),
    edge('slugify', 'agent', 0, 0, 'ai_tool'),
  ],
};

const webhook: Workflow = {
  id: 'wf_webhook_enrich',
  name: 'Webhook text enrichment',
  description: 'POST text to /api/webhook/enrich and get keywords + sentiment back.',
  tags: ['demo', 'webhook'],
  active: true,
  nodes: [
    node('hook', 'Webhook', 'core.webhook', 0, 100, { path: 'enrich', method: 'POST', respond: 'lastNode' }),
    node('body', 'Take body', 'core.set', 325, 100, {
      mode: 'manual',
      fields: { values: [{ name: 'text', type: 'string', value: '{{ $json.body.text ?? "Landflow plugins are fast, polyglot and great fun" }}' }] },
      includeOtherFields: false,
    }),
    node('keywords', 'Keywords', 'py-insights.keywords', 650, 100, { field: 'text', topN: 5, mode: 'frequency' }),
    node('sentiment', 'Sentiment', 'py-insights.sentiment', 975, 100, { field: 'text', outputField: 'sentiment' }),
    node('code', 'Summarize', 'core.code', 1300, 100, {
      mode: 'each',
      codeEach: 'return {\n  text: $json.text,\n  keywords: $json.keywords,\n  mood: $json.sentiment.label,\n  words: $json.text.split(/\\s+/).length,\n};',
    }),
  ],
  connections: [edge('hook', 'body'), edge('body', 'keywords'), edge('keywords', 'sentiment'), edge('sentiment', 'code')],
};

export function seedWorkflows() {
  if (store.listWorkflows().length) return;
  for (const workflow of [polyglotPipeline, agent, webhook]) store.saveWorkflow(workflow);
  logger.info('seeded example workflows', { count: 3 });
}
