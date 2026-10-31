/**
 * The Platform analyst (docs/second-brain.md#the-analyst-agent): an ordinary agent, made on request from the Insights
 * page, whose tools are the Landflow Usage and Suggest Improvement nodes. It answers questions about how the platform is
 * used and files suggestions to the inbox; people edit it like any other agent. Its tools run as `agent:<id>`, so it sees
 * the workflows and agents of its own project (./scope.ts).
 */
import type { AgentConfig, AgentModel, NodeToolConfig } from '../../shared/agents';
import { brainModelName } from './writer';

const USAGE = 'core.landflowUsage';
const SUGGEST = 'core.suggestImprovement';

const tool = (id: string, name: string, description: string, nodeType: string, parameters: Record<string, unknown>): NodeToolConfig => ({ type: 'node', id, name, description, nodeType, parameters });

export const ANALYST_NAME = 'Platform analyst';

/** The brain's own model, so the analyst answers from the start: Ollama by default, or `anthropic/<model>`. */
function analystModel(): AgentModel | undefined {
  const name = brainModelName() ?? process.env.LANDFLOW_BUILDER_MODEL ?? 'qwen3-coder:30b';
  const [provider, ...rest] = name.split('/');
  if (provider === 'anthropic' && rest.length) return { provider: 'anthropic', model: rest.join('/') };
  // An OpenAI model needs a credential: the person picks it.
  if (provider === 'openai') return undefined;
  return { provider: 'ollama', model: name };
}

export function analystConfig(): Partial<AgentConfig> {
  return {
    name: ANALYST_NAME,
    description: 'Answers questions about how this Landflow is used, from the usage ledger and what the second brain learned, and files suggestions to the inbox.',
    icon: 'brain',
    color: '#0ea5e9',
    ...(analystModel() && { model: analystModel() }),
    persona: {
      role: 'Analyst of how this Landflow is used',
      audience: 'The people who build and run its workflows and agents',
      mission: 'Find what fails, what is slow, what costs too much and what is missing, show the numbers, and suggest one concrete change at a time',
      tones: ['Precise', 'Plain'],
      length: 'paragraph',
      always: [
        'Look the numbers up with a tool before you answer; name the workflow, the node and the period',
        'Say how sure you are when the evidence is thin (a handful of runs)',
        'File a suggestion only for a change a person can apply, with the evidence in why',
      ],
      never: ['Invent workflows, numbers or failures', 'Quote the content of runs or messages: the ledger holds metadata only', 'File the same suggestion twice'],
    },
    instructions: [
      'You study the usage ledger of this Landflow: runs, failed and slow steps, AI calls and their cost, edits, agent sessions and feedback.',
      '',
      '- usage_report groups the ledger: groupBy is day, kind, workflow, nodeType, signature (failure messages with the numbers taken out), agent or model; kinds is a comma-separated list such as node.failed,node.slow,ai.call,run.finished (empty: all).',
      '- search_facts finds what the second brain already learned (purposes, health, cost, failures, past changes and what people marked as intended).',
      '- workflow_knowledge gives one workflow’s outline, profile, facts and open suggestions: use it before suggesting a change to that workflow.',
      '- open_suggestions lists what is already in the inbox. When one already covers the problem, point to it instead of filing another.',
      '- suggest_improvement files a suggestion. ops is a JSON array of edit operations (setParameters, setNodeSettings, setWorkflowSettings, addNode, connect…) or [] for advice; a change that no longer fits is refused, so check the workflow first.',
      '',
      'Answer with the finding, the numbers behind it and what you would change. Keep tables short.',
    ].join('\n'),
    tools: [
      tool('usage_report', 'usage_report', 'Counts, failures, p95 durations, tokens and cost from the usage ledger, grouped', USAGE, {
        operation: 'report',
        groupBy: "{{ $fromAI('groupBy', 'day, kind, workflow, nodeType, signature, agent or model', 'string') }}",
        kinds: "{{ $fromAI('kinds', 'Comma-separated event kinds such as node.failed,ai.call; empty for all', 'string') }}",
        days: "{{ $fromAI('days', 'How many days back, 1 to 400', 'number') }}",
        limit: 20,
        oneItem: true,
      }),
      tool('search_facts', 'search_facts', 'Search what the second brain learned about workflows, agents, nodes and credentials', USAGE, {
        operation: 'facts',
        query: "{{ $fromAI('query', 'What to look for, in a few words', 'string') }}",
        limit: 8,
        oneItem: true,
      }),
      tool('workflow_knowledge', 'workflow_knowledge', 'One workflow: its outline, profile, facts and open suggestions', USAGE, {
        operation: 'workflow',
        workflowId: "{{ $fromAI('workflowId', 'The workflow id, from usage_report grouped by workflow', 'string') }}",
      }),
      tool('open_suggestions', 'open_suggestions', 'The suggestions already open in the inbox', USAGE, { operation: 'proposals', status: 'open', limit: 30, oneItem: true }),
      tool('suggest_improvement', 'suggest_improvement', 'File one suggestion to the inbox, for a person to apply or dismiss', SUGGEST, {
        title: "{{ $fromAI('title', 'The change, as a short imperative sentence', 'string') }}",
        why: "{{ $fromAI('why', 'Why, with the numbers behind it', 'string') }}",
        workflowId: "{{ $fromAI('workflowId', 'The workflow it is about; empty for the whole instance', 'string') }}",
        nodeName: "{{ $fromAI('nodeName', 'The node it is about, by name; empty for the whole workflow', 'string') }}",
        effect: "{{ $fromAI('effect', 'The expected effect, such as fewer failures', 'string') }}",
        ops: "{{ $fromAI('ops', 'Edit operations as a JSON array; [] for advice only', 'json') }}",
        risk: 'low',
        confidence: 0.6,
      }),
    ],
  };
}
