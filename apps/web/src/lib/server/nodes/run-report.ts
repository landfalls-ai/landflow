/**
 * Run report (docs/run-trace.md#the-run-report): at the end of a flow, build the report of this run from its journal —
 * the six built-in checks over what every actor did, who called whom, cycles, problems, claims against evidence — record
 * the checks in the journal (each on the span it is about), save the report as an artifact of the run and output it,
 * Markdown included, for the next node to post (a GitHub comment, a ticket note, Slack). A connected chat model may add a
 * few lines written only from those facts. The gate: failed checks go out on "Send back" (route), wait for a person to
 * accept them or send the work back (ask), or only warn.
 */
import { defineNode, NodeOperationError, type PropertyDescriptor } from '@landflow/sdk';
import type { LanguageModel } from '@landflow/engine';
import type { JsonObject, NodeItem } from '@landflow/protocol';
import { resolveRunProfile, type RunGate } from '../../shared/run-profiles';
import { foldChanges } from '../../shared/run-changes';
import { buildRunReport, type ReportCheck } from '../../shared/run-report';
import type { JournalEvent } from '../../shared/run-trace';
import { foldJournal } from '../../shared/run-trace-model';
import { journalOf, journalStore, liveJournal } from '../journal';

const properties: PropertyDescriptor[] = [
  {
    name: 'profile',
    displayName: 'Profile',
    type: 'options',
    default: 'flow',
    noDataExpression: true,
    description: 'The claims, role rules and words the checks use',
    options: [
      { name: 'From Workflow Settings', value: 'flow', description: 'Settings → Run trace → Profile (Generic when unset)' },
      { name: 'Generic', value: 'generic', description: 'Any flow: the checks that need no domain knowledge' },
      { name: 'Software Delivery', value: 'software', description: 'Tests and typecheck against what agents say, read-only reviewers, every change pushed' },
      { name: 'Customer Support', value: 'support', description: 'Promised emails, refunds and ticket changes against what was done' },
    ],
  },
  {
    name: 'gate',
    displayName: 'When a Check Fails',
    type: 'options',
    default: 'profile',
    noDataExpression: true,
    options: [
      { name: 'As the Profile Says', value: 'profile', description: 'Software delivery sends the work back; the others only warn' },
      { name: 'Send the Work Back', value: 'route', description: 'Output on “Send back”: connect it to whoever fixes the work' },
      { name: 'Ask a Person', value: 'ask', description: 'Wait until someone accepts the failed checks or sends the work back' },
      { name: 'Only Warn', value: 'warn', description: 'Always output on “Passed”, with the failed checks in the report' },
    ],
  },
  { name: 'title', displayName: 'Title', type: 'string', default: 'Run report', description: 'The heading of the report' },
  {
    name: 'summarize',
    displayName: 'Add a Summary',
    type: 'boolean',
    default: false,
    description: 'Whether the connected chat model writes a few lines from the report’s facts (and nothing else)',
  },
];

/** Every event of the run so far, the ones still waiting to be written included. */
function journalEvents(executionId: string): JournalEvent[] {
  liveJournal(executionId)?.flush();
  const events: JournalEvent[] = [];
  for (let after = 0; ; ) {
    const page = journalStore.read(executionId, after, 2000);
    events.push(...page);
    if (page.length < 2000) return events;
    after = page[page.length - 1].seq;
  }
}

const SUMMARY_SYSTEM =
  'You summarize a multi-agent run for the person who owns it. Write two to four plain sentences: what was asked, what was delivered, and what failed or is left. Use only the facts in the report; never add, guess or soften anything. No headings, no lists.';

/** What the work's fixer is told when it goes back: the failed checks and what should happen next. */
function sendBackText(failed: ReportCheck[], next: string[]): string {
  return [`The run report found ${failed.length} failed check${failed.length === 1 ? '' : 's'}:`, ...failed.map((c) => `- ${c.name}: ${c.message ?? 'failed'}`), '', 'What should happen next:', ...next.map((n) => `- ${n}`)].join('\n');
}

export const runReportNode = defineNode({
  description: {
    name: 'runReport',
    displayName: 'Run Report',
    description: 'Check what every agent and step of this run did, and report it: claims against evidence, who called whom, problems and fixes',
    version: 1,
    kind: 'action',
    categories: ['AI', 'Flow'],
    icon: 'lucide:clipboard-check',
    color: '#0f766e',
    subtitle: '{{profile}}',
    keywords: ['run report', 'report', 'summary', 'audit', 'checks', 'claims', 'evidence', 'gate', 'review', 'trace', 'agents'],
    inputs: [{ type: 'main' }, { type: 'ai_languageModel', displayName: 'Chat Model', maxConnections: 1 }],
    outputs: [
      { type: 'main', displayName: 'Passed' },
      { type: 'main', displayName: 'Send back' },
    ],
    properties,
  },

  async execute(ctx) {
    const items = ctx.getInputData();
    const executionId = ctx.getExecutionId();
    const node = ctx.getNode();
    const workflowId = ctx.getWorkflowId() ?? 'unknown';
    const profileSetting = ctx.getNodeParameter<string>('profile', 0, 'flow');
    // The workflow's settings: the version this run started on, else the saved workflow.
    const { liveExecution } = await import('../runner');
    const { store } = await import('../store');
    const settings = (liveExecution(executionId)?.workflow ?? store.getWorkflow(workflowId))?.settings;
    const profile = resolveRunProfile(profileSetting === 'flow' ? settings?.runProfile : profileSetting);
    const gateSetting = ctx.getNodeParameter<string>('gate', 0, 'profile');
    const gate: RunGate = gateSetting === 'route' || gateSetting === 'ask' || gateSetting === 'warn' ? gateSetting : (profile.gate ?? 'warn');
    const title = String(ctx.getNodeParameter('title', 0, 'Run report') || 'Run report');

    // Back from "Ask a person": the decision is in the node state (WaitRequest.rerun).
    const saved = ctx.getNodeState?.() as { $resume?: { kind: string; data?: JsonObject } } | undefined;
    ctx.setNodeState?.(undefined);
    const decision = saved?.$resume?.data;

    // The branch as GitHub sees it, when the run names one: the notes check reads it (files a removal took away don't count).
    const { runBranchChanges } = await import('../run-changes');
    const branch = await runBranchChanges(executionId).catch(() => undefined);
    const branchFiles = branch?.available ? branch.branch.files.filter((f) => f.status !== 'removed').map((f) => f.path) : undefined;
    const events = journalEvents(executionId);
    const changes = foldChanges(events);
    let report = buildRunReport(foldJournal(events), profile, { title, branchFiles, changes });
    if (ctx.getNodeParameter('summarize', 0, false) && !decision) {
      const [model] = (await ctx.getInputConnectionData?.<LanguageModel>('ai_languageModel')) ?? [];
      if (!model) throw new NodeOperationError('No chat model connected', { description: '“Add a Summary” needs a chat model on the “Chat Model” slot.' });
      const turn = await model.generate({ system: SUMMARY_SYSTEM, messages: [{ role: 'user', content: report.markdown }], tools: [], ...(ctx.signal && { signal: ctx.signal }) });
      if (turn.text.trim()) report = buildRunReport(foldJournal(journalEvents(executionId)), profile, { title, branchFiles, changes, summary: { text: turn.text, by: model.model } });
    }
    const failed = report.checks.filter((c) => c.status === 'fail' && !c.resolution);

    // The checks go into the journal on the span each is about (this node's own when it has none), and the report with it.
    const journal = liveJournal(executionId) ?? journalOf(executionId, { workflowId, ...(settings?.traceContent && { content: settings.traceContent }) });
    const own = journal.spanOfNode(node.id);
    if (!decision) {
      for (const check of report.checks) {
        if (check.check === 'node') continue;
        const { id: _id, check: _kind, spanId, actor: _actor, evidenceSpanId, ...fields } = check;
        const spanFor = spanId ?? own;
        if (spanFor) journal.record({ type: 'check', spanId: spanFor, check: { ...fields, ...(evidenceSpanId && { evidence: { spanId: evidenceSpanId } }) } });
      }
    }
    ctx.artifact({ name: title, kind: 'report', mimeType: 'text/markdown', text: report.markdown });

    if (failed.length && gate === 'ask' && !decision) {
      if (!ctx.putExecutionToWait) throw new NodeOperationError('“Ask a person” needs a workflow execution');
      ctx.putExecutionToWait({
        resume: 'form',
        rerun: true,
        data: {
          form: {
            title: `${report.label}: ${failed.length} check${failed.length === 1 ? '' : 's'} failed`,
            description: failed.map((c) => `• ${c.name}: ${c.message ?? ''}`).join('\n'),
            fields: [
              { fieldLabel: 'Decision', fieldName: 'decision', fieldType: 'radio', requiredField: true, fieldOptions: 'Accept as is\nSend back for a fix' },
              { fieldLabel: 'Note', fieldName: 'note', fieldType: 'textarea' },
            ],
            buttonLabel: 'Decide',
          },
          // The Needs you strip answers this wait in place (POST /api/executions/:id/gate).
          runReport: { gate: true, verdict: report.verdict, label: report.label, failed: failed.map((c) => ({ name: c.name, ...(c.spanId && { spanId: c.spanId }), ...(c.message && { message: c.message }) })) },
        } as unknown as JsonObject,
      });
      ctx.logger.info(`waiting for a person to decide on ${failed.length} failed check(s)`);
      return [items, []];
    }

    const choice = decision ? (/send|back|fix/i.test(String(decision.decision ?? '')) ? 'sent_back' : 'accepted') : undefined;
    const sendBack = failed.length > 0 && (choice ? choice === 'sent_back' : gate === 'route');
    // Sent back by the gate itself: the failed checks are settled for this round (the next report judges the fix).
    if (sendBack && !choice) {
      for (const check of failed) if (check.spanId) journal.record({ type: 'check', spanId: check.spanId, check: { name: check.name, status: check.status, ...(check.subject && { subject: check.subject }), resolution: { decision: 'sent_back', by: title } } });
    }
    journal.flush();

    const json: JsonObject = {
      verdict: report.verdict,
      label: report.label,
      profile: report.profile.id,
      failed: failed.length,
      checks: report.checks.map((c) => ({ name: c.name, status: c.status, ...(c.message && { message: c.message }), ...(c.subject && { subject: c.subject }), ...(c.resolution && { resolution: c.resolution }) })) as unknown as JsonObject[],
      next: report.next,
      report: report.markdown,
      ...(sendBack && { sendBack: sendBackText(failed, report.next) }),
      ...(choice && { decision: choice, ...(typeof decision?.note === 'string' && decision.note && { note: decision.note }), ...(typeof decision?.by === 'string' && { decidedBy: decision.by }) }),
    };
    const out: NodeItem[] = items.length ? items.map((item, i) => ({ json: { ...json }, pairedItem: { item: i } })) : [{ json }];
    return sendBack ? [[], out] : [out, []];
  },
});
