/**
 * AG07 (wave ag2): the steps name the agent's own tools by their call names, and the ask's tools are read whole. A made-up name or
 * another tool's node type never stays in a step, a look-alike is never renamed to a different tool, a sub-agent's and an MCP
 * server's call names are kept, and "pull out the IOCs" names Extract IOCs. Scripted models; nothing leaves this machine.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { NodeTypeInfo } from '@/lib/shared/types';
import type { AgentConfig } from '@/lib/shared/agents';

const { corePlugin } = await import('@/lib/server/nodes');
const { registry } = await import('@/lib/server/plugins/registry');
const { designAgent, nameOnlyOwnTools } = await import('@/lib/server/assistant/architect');
const { askCatalog, toolsOf } = await import('@/lib/shared/agent-ask');
const { TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const { prepare, addScenarioPlugins } = await import('./spotlight-scenarios/harness');
const { agentStore } = await import('@/lib/server/agents/store');
const { githubAllowedTools } = await import('@/lib/server/mcp/github');

let types: NodeTypeInfo[];
beforeAll(async () => {
  prepare();
  registry.registerBuiltin(corePlugin);
  await addScenarioPlugins({ start: { plugins: ['triage', 'messaging', 'grafana'] } }, 'unit');
  types = registry.nodeTypes();
});

const OWN = [{ name: 'normalize_alert' }, { name: 'extract_iocs' }, { name: 'send_email' }];
const run = (line: string, tools = OWN, options = {}) => nameOnlyOwnTools(line, tools, options);

describe('the steps check, straight (the planner’s probe)', () => {
  it('drops or renames a tool the agent lacks, never keeps it', () => {
    const lines: Array<[string, string]> = [
      ['Call the get_alerts tool for the last hour.', 'get_alerts'],
      ['Use the query_logs tool to search.', 'query_logs'],
      ['call get_alerts', 'get_alerts'],
      ['Call get_alert_status.', 'get_alert_status'],
      ['Call the get_alert_status tool.', 'get_alert_status'],
      ['Send it via the slack_post tool.', 'slack_post'],
      ['2. Call the post_message tool with the summary.', 'post_message'],
      ['Use slack_post to tell the team.', 'slack_post'],
      ['Run the fetch_logs tool.', 'fetch_logs'],
      ['Call the get_user_id tool.', 'get_user_id'],
      ['Use the lookup_by tool.', 'lookup_by'],
      ['Call send_to.', 'send_to'],
      ['Use send_summary as the last step.', 'send_summary'],
      ['Use get_alerts from the Grafana plugin.', 'get_alerts'],
      ['Use fetch_logs from the log store.', 'fetch_logs'],
      ['Use get_alerts to order them by severity.', 'get_alerts'],
    ];
    for (const [line, token] of lines) {
      const { text, dropped } = run(line);
      expect(text, line).not.toContain(token);
      expect(dropped.join(' '), line).toContain(token);
    }
  });

  it('leaves fields alone, word for word', () => {
    for (const line of [
      'Read run_id and post_id from the result.',
      'Sort by update_time.',
      'Read the email_address.',
      'Use user_id from the input.',
      'Use the user_id from the input.',
      'Use send_to as the address.',
      'Read the run_id.',
      'Use the run_id to fetch status.',
      'Use update_time to order them.',
      'Use the email_address field.',
      'Call normalize_alert with the alert_id.',
      'Run normalize_alert on each user_id.',
      'Call normalize_alert, then run the post_id check.',
      'Set the post_id field.',
      'Use the alert_type value.',
      'Use the severity_level from the alert.',
      'Use the json_path to pick fields.',
      'Group by created_by.',
      'Fill the to_email field from the alert.',
    ]) expect(run(line), line).toEqual({ text: line, dropped: [] });
  });

  it('"with send_email" is a tool even though it ends in a field word', () => {
    const lacks = [{ name: 'normalize_alert' }, { name: 'extract_iocs' }];
    expect(run('Send the summary with send_email.', lacks).text).toBe('');
    expect(run('Email the result using send_email.', lacks).text).toBe('');
    expect(run('Send the summary with send_email.')).toEqual({ text: 'Send the summary with send_email.', dropped: [] });
  });

  it('never renames on one shared word; renames a plural, an -ise and a _2 suffix', () => {
    const one = [{ name: 'normalize_alert' }];
    const gone = run('Call get_alert_status.', one);
    expect(gone.text).toBe('');
    expect(gone.dropped.join(' ')).not.toContain('now');
    expect(run('Call get_alerts_2.', [{ name: 'get_alerts' }]).text).toBe('Call get_alerts.');
    expect(run('Call normalize_alerts.', one).text).toBe('Call normalize_alert.');
    expect(run('Call normalise_alert.', one).text).toBe('Call normalize_alert.');
  });

  it('keeps a sub-agent’s call name and drops one the agent lacks', () => {
    expect(run('Ask ask_researcher for the details.', [{ name: 'ask_researcher' }]).text).toBe('Ask ask_researcher for the details.');
    const without = run('Ask ask_researcher for the details.');
    expect(without.text).toBe('');
    expect(without.dropped.join(' ')).toContain('ask_researcher');
  });

  it('renames a node type to the agent’s call name or drops its clause, and renumbers', () => {
    const options = { nodeTypes: { 'grafana.getAlerts': 'get_alerts' }, catalog: ['grafana.getAlerts', 'core.httpRequest', 'messaging.emailSend'] };
    const tools = [{ name: 'get_alerts' }];
    expect(run('1. Call grafana.getAlerts.\n2. Call core.httpRequest on the URL.', tools, options).text).toBe('1. Call get_alerts.');
    expect(run('1. Call grafana.getAlerts. 2. Call core.httpRequest on the URL.', tools, options).text).toBe('1. Call get_alerts.');
    const three = run('1. Call core.httpRequest.\n2. Call grafana.getAlerts.\n3. Report.', tools, options).text;
    expect(three).toBe('1. Call get_alerts.\n2. Report.');
    // An address's domain and a file name are text.
    for (const line of ['Mail oncall@landflow.test', 'read config.yaml']) expect(run(line, tools, options), line).toEqual({ text: line, dropped: [] });
  });

  it('with an MCP server open, a name that is no node’s is kept; a GitHub preset keeps only its allowed names', () => {
    expect(run('Call search_issues.', OWN, { open: true, catalog: [] }).text).toBe('Call search_issues.');
    expect(run('Call get_alert_status.', OWN, { open: true, catalog: [] }).text).toBe('Call get_alert_status.');
    const read = [...githubAllowedTools('read')].map((name) => ({ name }));
    const allowed = read[0].name;
    expect(run(`Call ${allowed}.`, read).text).toBe(`Call ${allowed}.`);
    const write = 'create_issue_comment';
    expect(githubAllowedTools('read').has(write)).toBe(false);
    expect(run(`Call ${write} on the pull request.`, read).text).toBe('');
  });

  it('a foreign name goes even when the agent has a look-alike', () => {
    const { text, dropped } = run('Call slugify on the title.', [{ name: 'slugify_text' }], { foreign: ['slugify'] });
    expect(text).toBe('');
    expect(dropped.join(' ')).toContain('slugify');
    expect(run('Call slugify_title.', [{ name: 'slugify_text' }], { foreign: ['slugify_title'] }).text).toBe('');
    // Without the hint the plain word is text.
    expect(run('Make a slugify of the title.', [{ name: 'slugify_text' }]).text).toBe('Make a slugify of the title.');
  });
});

describe('the ask’s tools are read whole', () => {
  it('"pull out the IOCs" names Extract IOCs; "check the alert" names neither alert node', () => {
    const catalog = askCatalog(types);
    expect(toolsOf('Create an agent that triages an alert: pull out the IOCs, and judge it.', catalog)).toContain('Extract IOCs');
    expect(toolsOf('Create an agent that checks the IOC list', catalog)).toContain('Extract IOCs');
    const alert = toolsOf('Create an agent that will check the alert and say what it is.', catalog);
    expect(alert).not.toContain('Normalize Alert');
    expect(alert.join(' ')).not.toMatch(/Get Alerts/);
    expect(toolsOf('pull out the text', catalog)).not.toContain('Extract IOCs');
  });
});

describe('Send email: several nodes match', () => {
  it('is said only when the draft has no mail node already', async () => {
    const model = (nodeTools: string) => {
      const turns: Array<Record<string, unknown>> = [{ toolCalls: [{ id: 'd1', name: 'propose_design', input: { summary: 'Draft', role: 'Helper', name: 'Mailer', instructions: 'Steps:\n1. Call send_email.', nodeTools } }] }, { text: 'Designed.' }];
      return { provider: 'test', model: 'scripted', async generate(request: { system?: string }) {
        if (typeof request.system === 'string' && request.system.startsWith('You write test cases')) return { text: 'Hello => A greeting\nWhat? => Reply\nOdd => Cannot help', toolCalls: [], stopReason: 'stop' as const };
        return { text: '', toolCalls: [], stopReason: 'stop' as const, ...turns.shift() };
      } };
    };
    const spec = { name: 'Mailer', description: 'x', instructions: '', ask: 'Create an agent that emails the alert summary to oncall@landflow.test', tools: ['Send email: several nodes match (Send Email, Send Mail), pick one'] };
    const withMail = await designAgent(spec, { types, actor: TEST_OWNER, model: model('messaging.emailSend') as never });
    expect(withMail.notAdded.map((n) => n.name)).not.toContain('Send email');
    const without = await designAgent(spec, { types, actor: TEST_OWNER, model: model('none') as never });
    expect(without.notAdded.map((n) => n.name)).toContain('Send email');
  });
});

describe('a design with the ag1 run’s steps', () => {
  it('names only its own tools: node types renamed, a made-up name gone', async () => {
    const instructions = 'Steps:\n1. Call grafana.getAlerts.\n2. Call core.httpRequest on the URL.\n3. Send the summary with send_summary.\n4. Explain each alert.';
    const turns: Array<Record<string, unknown>> = [{ toolCalls: [{ id: 'd1', name: 'propose_design', input: { summary: 'Draft', role: 'Helper', name: 'Alert watcher', instructions, nodeTools: 'grafana.getAlerts' } }] }, { text: 'Designed.' }];
    const model = { provider: 'test', model: 'scripted', async generate(request: { system?: string }) {
      if (typeof request.system === 'string' && request.system.startsWith('You write test cases')) return { text: 'Hello => A greeting\nWhat? => Reply\nOdd => Cannot help', toolCalls: [], stopReason: 'stop' as const };
      return { text: '', toolCalls: [], stopReason: 'stop' as const, ...turns.shift() };
    } };
    const result = await designAgent({ name: 'Alert watcher', description: 'x', instructions: '', ask: 'Create an agent that lists the firing alerts in Grafana. Use the Get Alerts tool.', tools: ['Get Alerts'] }, { types, actor: TEST_OWNER, model: model as never });
    const text = (result.config as Partial<AgentConfig>).instructions ?? '';
    expect(text).not.toMatch(/grafana\.|core\.|send_summary/);
    expect(text).toMatch(/Call get_alerts\./);
    expect(text).toContain('Explain each alert.');
    void agentStore;
  });
});
