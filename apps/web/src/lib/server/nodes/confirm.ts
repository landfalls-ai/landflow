/**
 * Ask a Person (`core.confirmDraft`): send a draft to a person, wait for their answer, continue with it.
 *
 * It waits the way an AI Agent waits for a tool approval (lib/server/approvals.ts): the execution is saved as waiting
 * (`resume: 'webhook'`, `rerun: true`) with `wait.data.approval` = one call, `confirm`, and the request in
 * `approval.confirm`. A person answers in the execution view or the Run Trace (POST /api/executions/:id/approvals),
 * from Slack (Approve / Edit / Reject; Edit opens a modal with the draft) or from a signed email link. The execution
 * survives a restart like any waiting one, and a timeout settles it with the node's default outcome.
 *
 * It asks once per run, not once per item: the draft is read from the first item. The output is one item,
 * `{ approved, edited, text, originalText, comment, by, at, channel }`, on "Approved" or on "Rejected".
 */
import { defineNode, NodeOperationError, type IExecuteContext, type JsonObject } from '@landflow/sdk';
import { CONFIRM_CALL, type ConfirmRequest } from '../approvals';
import { parseAddresses, sendApprovalEmails } from '../approval-email';
import { mailConfigured } from '../auth/mail';
import { confirmBlocks, confirmDecidedBlocks, postMessage, SLACK_CREDENTIAL, SLACK_OAUTH2_CREDENTIAL, slackCredential, updateMessage } from '../slack';
import { decisionsOf } from './ai';

const main = [{ type: 'main' as const }];
const show = (channel: string) => ({ show: { channel: [channel] } });

type Channel = 'chat' | 'slack' | 'email';

/** What the node keeps while the execution waits. */
interface ConfirmState {
  slack?: { channel: string; ts: string };
  $resume?: { kind: string; data?: JsonObject; error?: string };
}

const list = (value: unknown) =>
  String(value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

const slackCredentialOf = (ctx: IExecuteContext) => slackCredential(ctx.getCredentials<JsonObject>(String(ctx.getNodeParameter('slackAuthentication', 0, 'accessToken')) === 'oAuth2' ? SLACK_OAUTH2_CREDENTIAL : SLACK_CREDENTIAL));

export const confirmDraftNode = defineNode({
  description: {
    name: 'confirmDraft',
    displayName: 'Ask a Person',
    description: 'Send a draft to a person and wait: they approve, edit then approve, or reject. Continues with their answer.',
    version: 1,
    kind: 'action',
    categories: ['Flow'],
    icon: 'lucide:user-check',
    color: '#f59e0b',
    subtitle: '{{title}}',
    keywords: ['approve', 'approval', 'human', 'confirm', 'review', 'draft', 'person', 'human in the loop'],
    inputs: main,
    outputs: [
      { type: 'main', displayName: 'Approved' },
      { type: 'main', displayName: 'Rejected' },
    ],
    credentials: [
      { name: SLACK_CREDENTIAL, required: true, displayOptions: { show: { channel: ['slack'], slackAuthentication: ['accessToken'] } } },
      { name: SLACK_OAUTH2_CREDENTIAL, required: true, displayOptions: { show: { channel: ['slack'], slackAuthentication: ['oAuth2'] } } },
    ],
    properties: [
      { name: 'draft', displayName: 'Draft', type: 'string', default: '', required: true, typeOptions: { rows: 6 }, description: 'The text the person is asked about. Read from the first input item.' },
      { name: 'title', displayName: 'Title', type: 'string', default: 'Please review', description: 'The question or heading the person sees' },
      {
        name: 'channel',
        displayName: 'Ask In',
        type: 'options',
        default: 'chat',
        noDataExpression: true,
        options: [
          { name: 'Chat / Execution View', value: 'chat', description: 'The waiting execution and the Run trace show the draft with Approve, Edit and Reject' },
          { name: 'Slack', value: 'slack', description: 'A message with Approve, Edit and Reject (needs the app’s Interactivity URL)' },
          { name: 'Email', value: 'email', description: 'An email with signed, single-use Approve and Reject links (the host’s SMTP, LANDFLOW_SMTP_HOST); editing is done in the execution view' },
        ],
      },
      {
        name: 'slackAuthentication',
        displayName: 'Slack Authentication',
        type: 'options',
        default: 'accessToken',
        noDataExpression: true,
        options: [
          { name: 'Bot Token', value: 'accessToken' },
          { name: 'OAuth2 (Installed App)', value: 'oAuth2' },
        ],
        displayOptions: show('slack'),
      },
      { name: 'slackChannel', displayName: 'Slack Channel or Person', type: 'string', default: '', required: true, placeholder: 'C0123456789', description: 'Channel ID, or a member ID for a direct message', displayOptions: show('slack') },
      { name: 'emails', displayName: 'Send To', type: 'string', default: '', required: true, placeholder: 'ana@example.com, ben@example.com', description: 'Each address gets the draft with its own Approve and Reject links; the first answer counts.', displayOptions: show('email') },
      {
        name: 'approvers',
        displayName: 'Who May Answer',
        type: 'string',
        default: '',
        placeholder: 'ana@example.com, U0123ABCD',
        description: 'Emails of signed-in people and Slack member IDs, comma-separated. Empty: anyone who can see the request.',
      },
      { name: 'allowEdit', displayName: 'Allow Editing', type: 'boolean', default: true, description: 'The person may change the text before approving; the output has the edited text' },
      { name: 'timeoutMinutes', displayName: 'Timeout (Minutes)', type: 'number', default: 0, typeOptions: { minValue: 0 }, description: '0: wait until someone answers' },
      {
        name: 'onTimeout',
        displayName: 'If Nobody Answers',
        type: 'options',
        default: 'reject',
        noDataExpression: true,
        options: [
          { name: 'Reject', value: 'reject', description: 'Continue on the Rejected output' },
          { name: 'Approve', value: 'approve', description: 'Continue on the Approved output with the original text' },
          { name: 'Fail the Run', value: 'fail', description: 'Stop with an error' },
        ],
        displayOptions: { hide: { timeoutMinutes: [0] } },
      },
    ],
  },
  async execute(ctx) {
    if (!ctx.getInputData().length) return [[], []];
    const saved = ctx.getNodeState?.() as ConfirmState | undefined;
    ctx.setNodeState?.(undefined);
    const text = (() => {
      const raw = ctx.getNodeParameter('draft', 0) as unknown;
      return typeof raw === 'string' ? raw : raw === undefined || raw === null ? '' : JSON.stringify(raw, null, 2);
    })();
    const title = String(ctx.getNodeParameter('title', 0, 'Please review') ?? '').trim() || 'Please review';
    const channel = (['slack', 'email'].find((c) => c === String(ctx.getNodeParameter('channel', 0, 'chat'))) as Channel | undefined) ?? 'chat';
    const onTimeout = (['approve', 'fail'].find((c) => c === String(ctx.getNodeParameter('onTimeout', 0, 'reject'))) as 'approve' | 'fail' | undefined) ?? 'reject';

    const resume = saved?.$resume;
    if (resume) return settle(ctx, { resume, saved, text, title, channel, onTimeout });

    if (!text.trim()) throw new NodeOperationError('The draft is empty', { description: 'Set “Draft” to the text a person should look at.' });
    if (!ctx.putExecutionToWait) throw new NodeOperationError('Ask a Person needs a host that can pause executions');
    const allowEdit = Boolean(ctx.getNodeParameter('allowEdit', 0, true));
    const timeoutMinutes = Math.max(0, Number(ctx.getNodeParameter('timeoutMinutes', 0, 0)) || 0);
    const approvers = list(ctx.getNodeParameter('approvers', 0, ''));
    const node = ctx.getNode();
    const confirm: ConfirmRequest = { title, text, allowEdit, ...(approvers.length && { approvers }), ...(timeoutMinutes > 0 && { onTimeout }) };
    const approval: JsonObject = {
      nodeName: node.name,
      nodeId: node.id,
      itemIndex: 0,
      channel,
      calls: [{ id: CONFIRM_CALL, tool: CONFIRM_CALL, input: { text } }],
      requestedAt: new Date().toISOString(),
      title,
      confirm: confirm as unknown as JsonObject,
    };
    const state: ConfirmState = {};
    if (channel === 'slack') {
      const slackChannel = String(ctx.getNodeParameter('slackChannel', 0, '') ?? '').trim();
      if (!slackChannel) throw new NodeOperationError('Set the Slack channel or person to ask');
      const target = { t: 'wf' as const, e: ctx.getExecutionId(), c: CONFIRM_CALL };
      const ts = await postMessage(slackCredentialOf(ctx), { channel: slackChannel, text: `${title}\n${text.slice(0, 500)}`, blocks: confirmBlocks({ title, text, allowEdit, target }) });
      approval.slack = { channel: slackChannel, messages: ts ? { [CONFIRM_CALL]: ts } : {}, ...(approvers.length && { approvers }) };
      if (ts) state.slack = { channel: slackChannel, ts };
    }
    if (channel === 'email') {
      const to = parseAddresses(ctx.getNodeParameter('emails', 0, ''));
      if (!to.length) throw new NodeOperationError('Set the email addresses to ask');
      if (!mailConfigured()) throw new NodeOperationError('Asking by email needs the host’s SMTP: set LANDFLOW_SMTP_HOST');
      await sendApprovalEmails({
        to,
        title,
        calls: [{ tool: CONFIRM_CALL, input: { text }, target: { t: 'wf', e: ctx.getExecutionId(), c: CONFIRM_CALL }, confirm: { text } }],
        ...(timeoutMinutes > 0 && { note: `If nobody answers within ${timeoutMinutes} minutes, the request is ${onTimeout === 'fail' ? 'failed' : `${onTimeout}d`}.` }),
      });
      approval.email = { to };
    }
    ctx.logger.info(`waiting for a person: ${title}${channel === 'slack' ? ' (Slack)' : channel === 'email' ? ' (email)' : ''}`);
    ctx.putExecutionToWait({
      resume: 'webhook',
      rerun: true,
      ...(timeoutMinutes > 0 && { until: new Date(Date.now() + timeoutMinutes * 60_000).toISOString() }),
      data: { approval },
    });
    ctx.setNodeState?.(state as unknown as JsonObject);
    return [[], []];
  },
});

/** Back after the wait: the person's decision, or the timeout's default. */
async function settle(
  ctx: IExecuteContext,
  input: { resume: NonNullable<ConfirmState['$resume']>; saved: ConfirmState | undefined; text: string; title: string; channel: Channel; onTimeout: 'approve' | 'reject' | 'fail' },
) {
  const { resume, saved, text: original, title, channel, onTimeout } = input;
  const decision = decisionsOf(resume)[CONFIRM_CALL];
  const at = decision?.at ?? new Date().toISOString();
  let approved: boolean;
  let text = original;
  let comment: string | undefined;
  let by: string | undefined = decision?.by;
  let via: Channel = by?.startsWith('slack:') ? 'slack' : by?.startsWith('email:') ? 'email' : 'chat';
  if (decision) {
    approved = decision.approved;
    if (approved && typeof decision.text === 'string') text = decision.text;
    comment = decision.comment;
  } else if (resume.kind === 'timeout') {
    if (onTimeout === 'fail') {
      await tellSlack(ctx, saved, { title, text, approved: false, note: 'No answer in time: the run failed' });
      throw new NodeOperationError(`Nobody answered “${title}” in time`);
    }
    approved = onTimeout === 'approve';
    by = 'timeout';
    via = channel;
    await tellSlack(ctx, saved, { title, text, approved, note: `No answer in time: ${approved ? 'approved' : 'rejected'} automatically` });
  } else {
    // Resumed some other way (the execution's webhook URL): nobody decided, so it is not an approval.
    approved = false;
    by = 'unknown';
    via = channel;
  }
  const item = {
    json: {
      approved,
      edited: approved && text !== original,
      text,
      originalText: original,
      ...(comment && { comment }),
      ...(by && { by }),
      at,
      channel: via,
    } as JsonObject,
    pairedItem: { item: 0 },
  };
  return approved ? [[item], []] : [[], [item]];
}

/** The Slack message says how a timeout settled (a person's answer is already on it); best effort. */
async function tellSlack(ctx: IExecuteContext, saved: ConfirmState | undefined, request: { title: string; text: string; approved: boolean; note: string }) {
  if (!saved?.slack) return;
  try {
    await updateMessage(slackCredentialOf(ctx), {
      channel: saved.slack.channel,
      ts: saved.slack.ts,
      text: `${request.title}: ${request.note}`,
      blocks: confirmDecidedBlocks({ title: request.title, text: request.text, approved: request.approved, note: request.note }),
    });
  } catch (error) {
    ctx.logger.warn(`could not update the Slack message: ${(error as Error).message}`);
  }
}
