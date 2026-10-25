/**
 * Starter flows offered on an empty canvas: the quickest way to get a working
 * workflow on screen and run it. Each one only appears when the node types it
 * uses are registered (plugins come and go).
 */
import type { ConnectionType, NodeItem } from '@/lib/shared/types';

export interface TemplateNode {
  key: string;
  type: string;
  name: string;
  x: number;
  y: number;
  parameters?: Record<string, unknown>;
  notes?: string;
}

export interface FlowTemplate {
  id: string;
  title: string;
  description: string;
  icon: string;
  color: string;
  nodes: TemplateNode[];
  /** [from, to, sourceIndex, connectionType] */
  edges: Array<[string, string, number?, ConnectionType?]>;
  /** Pinned test data per node key. */
  pinData?: Record<string, NodeItem[]>;
}

const items = (...rows: NodeItem['json'][]): NodeItem[] => rows.map((json) => ({ json }));

export const TEMPLATES: FlowTemplate[] = [
  {
    id: 'plugins',
    title: 'Try every plugin',
    description: 'Test items through TypeScript, Python and Go nodes, then branch on sentiment',
    icon: 'lucide:puzzle',
    color: 'var(--viz-1)',
    nodes: [
      { key: 'run', type: 'core.manualTrigger', name: 'Run', x: 0, y: 0 },
      {
        key: 'data',
        type: 'core.set',
        name: 'Test data',
        x: 280,
        y: 0,
        parameters: {
          mode: 'json',
          json: JSON.stringify({ rows: [{ title: 'Loving the new plugins', text: 'This is great, fast and fun' }, { title: 'Broken again', text: 'Terrible, the update broke everything' }] }, null, 2),
          includeOtherFields: false,
          splitArray: 'rows',
        },
      },
      { key: 'slug', type: 'text-toolkit.slugify', name: 'Slugify title', x: 560, y: 0, parameters: { field: 'title', outputField: 'slug', separator: '-' } },
      { key: 'mood', type: 'py-insights.sentiment', name: 'Score sentiment', x: 840, y: 0, parameters: { field: 'text', outputField: 'sentiment' } },
      { key: 'if', type: 'core.if', name: 'Positive?', x: 1120, y: 0, parameters: { conditions: { condition: [{ left: '{{ $json.sentiment.label }}', operator: 'equals', right: 'positive' }] }, combinator: 'and' } },
      { key: 'hash', type: 'go-crypto.hash', name: 'Fingerprint', x: 1400, y: -90, parameters: { algorithm: 'sha256', field: 'slug', encoding: 'hex', outputField: 'id' } },
      { key: 'upper', type: 'text-toolkit.changeCase', name: 'Shout title', x: 1400, y: 90, parameters: { field: 'title', case: 'upper', inPlace: true } },
    ],
    edges: [
      ['run', 'data'],
      ['data', 'slug'],
      ['slug', 'mood'],
      ['mood', 'if'],
      ['if', 'hash', 0],
      ['if', 'upper', 1],
    ],
  },
  {
    id: 'branch-merge',
    title: 'Branch and merge',
    description: 'Split numbers with If, label both branches, merge them back and sort',
    icon: 'lucide:git-merge',
    color: 'var(--viz-3)',
    nodes: [
      { key: 'run', type: 'core.manualTrigger', name: 'Run', x: 0, y: 0 },
      { key: 'gen', type: 'core.code', name: 'Numbers 1–6', x: 280, y: 0, parameters: { mode: 'all', code: 'return [1, 2, 3, 4, 5, 6].map((n) => ({ n }));' } },
      { key: 'if', type: 'core.if', name: 'Bigger than 3?', x: 560, y: 0, parameters: { conditions: { condition: [{ left: '{{ $json.n }}', operator: 'gt', right: '3' }] }, combinator: 'and' } },
      { key: 'big', type: 'core.set', name: 'Label big', x: 840, y: -90, parameters: { mode: 'manual', fields: { values: [{ name: 'size', type: 'string', value: 'big' }] }, includeOtherFields: true } },
      { key: 'small', type: 'core.set', name: 'Label small', x: 840, y: 90, parameters: { mode: 'manual', fields: { values: [{ name: 'size', type: 'string', value: 'small' }] }, includeOtherFields: true } },
      { key: 'merge', type: 'core.merge', name: 'Merge', x: 1120, y: 0, parameters: { mode: 'append' } },
      { key: 'sort', type: 'core.sort', name: 'Sort by n', x: 1400, y: 0, parameters: { field: 'n', order: 'desc' } },
    ],
    edges: [
      ['run', 'gen'],
      ['gen', 'if'],
      ['if', 'big', 0],
      ['if', 'small', 1],
      ['big', 'merge'],
      ['small', 'merge'],
      ['merge', 'sort'],
    ],
  },
  {
    id: 'webhook',
    title: 'Webhook API',
    description: 'POST text, get keywords and sentiment back: an API endpoint in five nodes',
    icon: 'lucide:webhook',
    color: 'var(--viz-2)',
    nodes: [
      { key: 'hook', type: 'core.webhook', name: 'Webhook', x: 0, y: 0, parameters: { path: 'analyze', method: 'POST', respond: 'lastNode' } },
      { key: 'body', type: 'core.set', name: 'Take text', x: 280, y: 0, parameters: { mode: 'manual', fields: { values: [{ name: 'text', type: 'string', value: '{{ $json.body.text ?? "Plugins in any language are great" }}' }] }, includeOtherFields: false } },
      { key: 'kw', type: 'py-insights.keywords', name: 'Keywords', x: 560, y: 0, parameters: { field: 'text', topN: 5, mode: 'frequency' } },
      { key: 'mood', type: 'py-insights.sentiment', name: 'Sentiment', x: 840, y: 0, parameters: { field: 'text', outputField: 'sentiment' } },
      { key: 'out', type: 'core.code', name: 'Response', x: 1120, y: 0, parameters: { mode: 'each', codeEach: 'return { keywords: $json.keywords, mood: $json.sentiment.label };' } },
    ],
    edges: [
      ['hook', 'body'],
      ['body', 'kw'],
      ['kw', 'mood'],
      ['mood', 'out'],
    ],
    pinData: { hook: items({ body: { text: 'Landflow makes polyglot plugins fast and fun' }, headers: {}, query: {} }) },
  },
  {
    id: 'agent',
    title: 'Chat agent with plugin tools',
    description: 'An AI agent on a local Ollama model that calls Go, Python and TypeScript tools',
    icon: 'lucide:bot',
    color: 'var(--viz-7)',
    nodes: [
      { key: 'chat', type: 'core.chatTrigger', name: 'Chat message', x: 0, y: 0 },
      {
        key: 'agent',
        type: 'core.aiAgent',
        name: 'Agent',
        x: 280,
        y: -20,
        parameters: { prompt: '{{ $json.chatInput }}', systemMessage: 'You are a helpful assistant. Prefer your tools over guessing and say which tool you used.', options: { maxIterations: 6, sessionId: '{{ $json.sessionId }}' } },
      },
      { key: 'model', type: 'core.ollamaChatModel', name: 'Ollama', x: 290, y: 200, parameters: { baseUrl: 'http://127.0.0.1:11434', model: 'qwen3-coder:30b', temperature: 0.2 } },
      { key: 'memory', type: 'core.simpleMemory', name: 'Memory', x: 400, y: 200, parameters: { turns: 10 } },
      { key: 'hash', type: 'go-crypto.hash', name: 'Hash', x: 510, y: 200, parameters: { algorithm: 'sha256', field: 'value', encoding: 'hex', outputField: 'hash' }, notes: 'Hash the `value` argument with SHA-256.' },
      { key: 'mood', type: 'py-insights.sentiment', name: 'Sentiment', x: 620, y: 200, parameters: { field: 'text', outputField: 'sentiment' }, notes: 'Score the sentiment of the `text` argument.' },
    ],
    edges: [
      ['chat', 'agent'],
      ['model', 'agent', 0, 'ai_languageModel'],
      ['memory', 'agent', 0, 'ai_memory'],
      ['hash', 'agent', 0, 'ai_tool'],
      ['mood', 'agent', 0, 'ai_tool'],
    ],
  },
];
