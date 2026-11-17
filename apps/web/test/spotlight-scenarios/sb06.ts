/** SB06: the Agent architect on a local model (the dialog is offered the flat propose_design; a parse error is retried with it). */
import { call, checks, defineScenarios } from './scenario';

const drafted = { id: 'draft-exists', label: 'A draft exists', judge: (o: { agents: unknown[]; tools: string[] }) => o.tools.includes('propose_design') || o.tools.includes('propose_agent') };

export default defineScenarios([
  {
    id: 'sb06-pr-reviewer-dialog',
    owner: 'SB06',
    job: 'agent',
    via: 'architect',
    title: 'The Agent architect drafts a PR reviewer on the local model',
    ask: 'a PR reviewer that checks our practices',
    script: [
      call('search_nodes', { query: 'github pull request' }),
      call('propose_design', {
        summary: 'A PR reviewer',
        name: 'PR Reviewer',
        role: 'Pull request reviewer',
        audience: 'Engineers',
        mission: 'Checks each pull request against our practices',
        always: 'Quote the practice a comment is based on\nSay what is good',
        never: 'Approve without reading the diff',
        answerLength: 'short',
        instructions: 'Read the pull request, check it against the practices, comment.',
        model: 'ollama/qwen3-coder:30b',
        nodeTools: 'github.getPullRequest',
        cases: 'Review pull request 4 => Names what breaks the practices\nIs pull request 8 fine? => Answers from the check\nMerge pull request 2 => Says it only reviews', // SB17: the architect asks for cases
      }),
      { text: 'Drafted a reviewer; pick a GitHub credential.' },
    ],
    checks: [
      { ...drafted, judge: (o) => o.tools.includes('propose_design') },
      { id: 'local-model', label: 'Ran on the local model', judge: (o) => o.agents.every((a) => !a.model || a.model.startsWith('ollama/')) },
      { id: 'rules-arrived', label: 'The rules and the node tool arrived', judge: (o) => o.tools.includes('propose_design') && o.error === undefined },
      checks.noOutside,
    ],
  },
  {
    id: 'sb06-parse-retry',
    owner: 'SB06',
    job: 'agent',
    via: 'architect',
    title: 'A tool call Ollama cannot parse is retried with the flat tool',
    ask: 'an agent that answers questions from our docs and can look up Linear issues',
    script: [
      () => {
        throw new Error('Ollama error 500: {"error":"XML syntax error on line 41: unexpected EOF"}');
      },
      call('propose_design', { summary: 'A docs agent', name: 'Docs Hana', role: 'Docs answerer', instructions: 'Search the docs, answer.', model: 'ollama/qwen3-coder:30b', cases: 'How do I reset a password? => Quotes the docs\nWhere is the API key page? => Points to it\nDelete my account => Says a person must' /* SB17: */ }),
      { text: 'Drafted.' },
    ],
    checks: [{ ...drafted, judge: (o) => o.tools.includes('propose_design') && !o.error }, checks.noOutside],
    live: { runs: 3 },
  },
]);
