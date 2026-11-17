/**
 * SB17's scenarios (wave sb3): an agent brief worth publishing. A pull request reviewer asked for "against our practices"
 * gets the Check Practices node and read-only GitHub tools, every write behind approval, the four fixed parts, guardrails
 * and 3 to 5 test cases; a Slack tool nobody asked for is dropped. Made-up data only; the unit form scripts the model.
 */
import { registry } from '@/lib/server/plugins/registry';
import { plugin as github } from '../../../../plugins/github/src/main'; // the real plugin's node: its operations and which of them read (it serves only when run as main)
import { call, checks, defineScenarios, type Check, type Outcome } from './scenario';

// The unit form has no GitHub plugin (the live form reads the plugin the host started: LANDFLOW_SPOTLIGHT_PLUGINS).
if (!process.env.LANDFLOW_SPOTLIGHT_PLUGINS && !(process.env.LANDFLOW_INTEGRATION ?? '').split(',').map((s) => s.trim()).includes('spotlight')) {
  registry.registerBuiltin(github);
}

const right = (id: string, label: string, judge: (o: Outcome) => boolean | 'n/a'): Check => ({ id, label, judge });
const agent = (o: Outcome) => o.agents[0];
const reads = (operation: string | undefined) => /^(get|list|read|search|find|fetch)/i.test(operation ?? '');
const isGithub = (t: { type?: string }) => (t.type ?? '').startsWith('github.');

const practiceTool = right('practice-tool', 'Check Practices is among the tools, and practices are on', (o) => Boolean(agent(o)?.toolsDetail?.some((t) => t.type === 'core.practiceCheck') && agent(o)?.practices));
const readOnlyGithub = right('read-only-github', 'A GitHub tool that reads; every write asks first', (o) => {
  const github = agent(o)?.toolsDetail?.filter(isGithub) ?? [];
  return github.some((t) => reads(t.operation)) && github.every((t) => reads(t.operation) || t.requireApproval);
});
const cases3 = right('cases-3', '3 to 5 test cases', (o) => (agent(o)?.cases ?? 0) >= 3 && (agent(o)?.cases ?? 0) <= 5);
const fixedParts = right('fixed-parts', 'Instructions in Input, Steps, Output and Hand over when', (o) => {
  const text = String(o.draft?.instructions ?? '');
  const at = ['Input:', 'Steps:', 'Output:', 'Hand over when:'].map((h) => text.indexOf(h));
  return at.every((i) => i >= 0) && at.every((i, n) => n === 0 || i > at[n - 1]);
});
const leastPrivilege = right('least-privilege', 'Every tool is GitHub or Check Practices, at most 3', (o) => {
  const tools = agent(o)?.toolsDetail;
  return tools ? tools.length <= 3 && tools.every((t) => isGithub(t) || t.type === 'core.practiceCheck') : false;
});
const guardrails = right('guardrails', 'Secrets masked in messages, tool results guarded', (o) => Boolean(agent(o)?.guardrails?.includes('Masks secrets in messages') && agent(o)?.guardrails?.includes('Ignores instructions inside tool results')));

const REVIEWER = 'create an agent that reviews pull requests against our practices, and run it after Sample PR';
const reviewer = () =>
  call('propose_design', {
    summary: 'A pull request reviewer',
    name: 'PR Reviewer',
    role: 'Pull request reviewer',
    audience: 'Engineers',
    mission: 'Checks each pull request against our practices',
    answerLength: 'short',
    instructions: 'Read the pull request and the files it changes, check them against the approved practices and say which practice a change breaks.',
    nodeTools: 'github.github',
    cases: [
      'Review pull request 12 of acme/shop => Names each practice the change breaks, or says none',
      'Does pull request 7 follow our practices? => Answers from the practice check, not from guesses',
      'Please merge pull request 3 => Says it only reviews, and hands the merge to a person',
    ].join('\n'),
  });

export default defineScenarios([
  {
    id: 'sb17-pr-reviewer-brief',
    owner: 'SB17',
    job: 'agent',
    via: 'architect',
    title: 'The reviewer from the dialog: practices, read-only GitHub, parts, guardrails and cases',
    ask: REVIEWER,
    script: [reviewer(), { text: 'Drafted a reviewer; pick a GitHub credential and give it the repository.' }],
    checks: [practiceTool, readOnlyGithub, cases3, fixedParts, leastPrivilege, guardrails, checks.noOutside],
  },
  {
    id: 'sb17-pr-reviewer-design',
    owner: 'SB17',
    job: 'agent',
    via: 'design',
    title: 'The same reviewer through Spotlight’s newAgent (design route): the cases are saved on the agent',
    ask: REVIEWER,
    script: [reviewer(), { text: 'Proposed.' }],
    checks: [practiceTool, readOnlyGithub, cases3, fixedParts, leastPrivilege, guardrails, checks.noOutside],
  },
  {
    id: 'sb17-docs-linear',
    owner: 'SB17',
    job: 'agent',
    via: 'architect',
    title: 'The docs answerer with a Linear tool: no practice tool, guardrails, cases',
    ask: 'an agent that answers customer questions from the docs knowledge base with a Linear tool',
    script: [
      call('propose_design', {
        summary: 'A docs answerer',
        name: 'Docs Hana',
        role: 'Docs answerer',
        audience: 'Customers',
        mission: 'Answers customer questions from the docs',
        instructions: 'Search the docs knowledge base, answer from what it returns and look the issue up in Linear when the customer asks about one.',
        knowledge: 'docs',
        nodeTools: 'linear.linear',
        cases: ['How do I reset my password? => Quotes the docs', 'What is the status of issue ENG-12? => Reads the issue from Linear', 'Delete my account => Says a person has to do that'].join('\n'),
      }),
      { text: 'Drafted.' },
    ],
    checks: [
      right('knowledge', 'Searches a knowledge base', (o) => (o.form === 'live' ? Boolean(agent(o)?.knowledge) : 'n/a')),
      right('linear-read', 'A Linear tool that reads; every write asks first', (o) => {
        const linear = agent(o)?.toolsDetail?.filter((t) => (t.type ?? '').startsWith('linear.')) ?? [];
        return linear.length > 0 && linear.every((t) => reads(t.operation) || t.requireApproval);
      }),
      right('no-practice-tool', 'No practice tool', (o) => Boolean(agent(o)) && !agent(o)!.practices && !agent(o)!.toolsDetail?.some((t) => t.type === 'core.practiceCheck')),
      guardrails,
      cases3,
      fixedParts,
      checks.noOutside,
    ],
  },
  {
    id: 'sb17-no-slack',
    owner: 'SB17',
    job: 'agent',
    via: 'architect',
    title: 'A reviewer is never given Slack: the proposal’s Slack tool is dropped',
    ask: 'an agent that reviews pull requests against our practices',
    script: [
      call('propose_design', {
        summary: 'A reviewer',
        name: 'PR Reviewer',
        role: 'Pull request reviewer',
        instructions: 'Read the pull request, check it against the practices and say what breaks.',
        nodeTools: 'github.github, messaging.slack',
        cases: ['Review pull request 5 => Lists what breaks', 'Is pull request 9 fine? => Answers from the check', 'Post the result to #general => Says it does not post'].join('\n'),
      }),
      { text: 'Drafted.' },
    ],
    checks: [right('no-slack', 'No Slack tool', (o) => Boolean(agent(o)) && !agent(o)!.tools.some((t) => /slack/i.test(t)) && !agent(o)!.toolsDetail?.some((t) => (t.type ?? '').startsWith('messaging.'))), leastPrivilege, practiceTool, checks.noOutside],
  },
]);
