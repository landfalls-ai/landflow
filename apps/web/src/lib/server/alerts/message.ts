/**
 * What an alert says, once, and how each channel formats it: an email (text and HTML), a Slack message (text and
 * blocks), a webhook's JSON body, and Telegram HTML. Every alert names the workflow, links to the execution, and gives
 * the failing node and the error; a digest counts the alerts a throttle window held back.
 */
import type { AlertEvent } from '../../shared/alerts';
import type { ExecutionRecord } from '../../shared/types';
import { waitingSince } from './rules';

export interface AlertNotice {
  event: AlertEvent;
  rule: { id: string; name: string };
  workflow: { id: string; name: string };
  execution?: {
    id: string;
    url: string;
    mode: string;
    startedAt: string;
    finishedAt?: string;
    /** The node that failed (or waits). */
    node?: string;
    error?: string;
    /** Which automatic retry this was (1 = the first). */
    retryAttempt?: number;
    /** `waiting`: since when, and for what. */
    waitingSince?: string;
    waitingFor?: string;
  };
  /** A throttle window's held-back alerts. */
  digest?: { count: number; minutes: number; since: string; lastError?: string; lastExecutionUrl?: string };
  /** Sent with "Send test". */
  test?: boolean;
  /** Where all the workflow's executions are listed. */
  executionsUrl: string;
  at: string;
}

const MAX_ERROR = 1_000;

/** Base of the links in alerts: LANDFLOW_PUBLIC_URL, else localhost (as the runner's resume and error-workflow links). */
export function publicUrl(): string {
  return (process.env.LANDFLOW_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/+$/, '');
}

export const executionUrl = (workflowId: string, executionId: string) => `${publicUrl()}/workflows/${workflowId}/executions/${executionId}`;
export const executionsUrl = (workflowId: string) => `${publicUrl()}/workflows/${workflowId}/executions`;

const clip = (text: string | undefined, max = MAX_ERROR) => (text && text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** "45 min", "3 h 5 min", "2 days". */
export function durationText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

/** The node a failed run stopped at, by name. */
function failingNode(record: ExecutionRecord): string | undefined {
  return record.error?.nodeName ?? (record.error?.nodeId ? record.nodeNames?.[record.error.nodeId] : undefined) ?? (record.lastNodeId ? record.nodeNames?.[record.lastNodeId] : undefined);
}

export function noticeFor(rule: { id: string; name: string }, event: AlertEvent, record: ExecutionRecord): AlertNotice {
  const waiting = event === 'waiting';
  return {
    event,
    rule: { id: rule.id, name: rule.name },
    workflow: { id: record.workflowId, name: record.workflowName },
    execution: {
      id: record.executionId,
      url: executionUrl(record.workflowId, record.executionId),
      mode: record.mode,
      startedAt: record.startedAt,
      ...(record.finishedAt && !waiting && { finishedAt: record.finishedAt }),
      ...((waiting ? record.wait?.nodeName : failingNode(record)) && { node: waiting ? record.wait?.nodeName : failingNode(record) }),
      ...(!waiting && { error: clip(record.error?.message) ?? 'Unknown error' }),
      ...(record.retryAttempt && { retryAttempt: record.retryAttempt }),
      ...(waiting && { waitingSince: waitingSince(record), ...(record.wait?.resume && { waitingFor: record.wait.resume }) }),
    },
    executionsUrl: executionsUrl(record.workflowId),
    at: new Date().toISOString(),
  };
}

export function digestNotice(
  rule: { id: string; name: string },
  workflow: { id: string; name: string },
  digest: { count: number; minutes: number; since: string; event?: string; lastError?: string; lastExecutionId?: string },
): AlertNotice {
  return {
    event: (digest.event as AlertEvent | undefined) ?? 'failed',
    rule: { id: rule.id, name: rule.name },
    workflow,
    digest: {
      count: digest.count,
      minutes: digest.minutes,
      since: digest.since,
      ...(digest.lastError && { lastError: clip(digest.lastError) }),
      ...(digest.lastExecutionId && { lastExecutionUrl: executionUrl(workflow.id, digest.lastExecutionId) }),
    },
    executionsUrl: executionsUrl(workflow.id),
    at: new Date().toISOString(),
  };
}

/** What "Send test" sends: a made-up failure, marked as a test. */
export function testNotice(): AlertNotice {
  const now = new Date().toISOString();
  return {
    event: 'failed',
    rule: { id: 'test', name: 'Test' },
    workflow: { id: 'example', name: 'Example workflow' },
    execution: { id: 'test', url: `${publicUrl()}/settings#alerts`, mode: 'trigger', startedAt: now, finishedAt: now, node: 'HTTP Request', error: 'This is a test alert from Landflow: the channel works.' },
    test: true,
    executionsUrl: `${publicUrl()}/settings#alerts`,
    at: now,
  };
}

const VERB: Record<AlertEvent, string> = { failed: 'Failed', timedOut: 'Timed out', retriesExhausted: 'Failed after retries', waiting: 'Waiting' };

/** One line: the subject of an email, the first line elsewhere. */
export function subjectOf(notice: AlertNotice): string {
  const name = notice.workflow.name;
  if (notice.test) return 'Test alert from Landflow';
  if (notice.digest) {
    const what = notice.event === 'waiting' ? 'runs waiting too long' : notice.digest.count === 1 ? 'more failure' : 'more failures';
    return `${name}: ${notice.digest.count} ${what} in the last ${durationText(notice.digest.minutes * 60_000)}`;
  }
  const execution = notice.execution;
  if (notice.event === 'waiting' && execution?.waitingSince) return `Waiting for ${durationText(Date.now() - Date.parse(execution.waitingSince))}: ${name}`;
  if (notice.event === 'retriesExhausted' && execution?.retryAttempt) return `Failed after ${execution.retryAttempt} ${execution.retryAttempt === 1 ? 'retry' : 'retries'}: ${name}`;
  return `${VERB[notice.event]}: ${name}`;
}

/** The facts, as label/value pairs (the link last). */
export function factsOf(notice: AlertNotice): { label: string; value: string; url?: string }[] {
  const facts: { label: string; value: string; url?: string }[] = [{ label: 'Workflow', value: notice.workflow.name }];
  const execution = notice.execution;
  if (notice.digest) {
    if (notice.digest.lastError) facts.push({ label: 'Latest error', value: notice.digest.lastError });
    facts.push({ label: 'Executions', value: notice.executionsUrl, url: notice.executionsUrl });
    return facts;
  }
  if (execution?.node) facts.push({ label: notice.event === 'waiting' ? 'Waiting at' : 'Failed node', value: execution.node });
  if (execution?.error) facts.push({ label: 'Error', value: execution.error });
  if (execution?.waitingFor) facts.push({ label: 'Waiting for', value: execution.waitingFor === 'time' ? 'a timer' : `a ${execution.waitingFor}` });
  if (execution) facts.push({ label: 'Started', value: `${execution.startedAt.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')} (${execution.mode})` });
  if (execution) facts.push({ label: 'Execution', value: execution.url, url: execution.url });
  return facts;
}

const footer = (notice: AlertNotice) => (notice.test ? 'Sent from Settings → Alerts.' : `Alert rule “${notice.rule.name}” · Landflow`);

export function textOf(notice: AlertNotice): string {
  return [subjectOf(notice), '', ...factsOf(notice).map((fact) => `${fact.label}: ${fact.value}`), '', footer(notice)].join('\n');
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

export function htmlOf(notice: AlertNotice): string {
  const rows = factsOf(notice)
    .map(
      (fact) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#777;font-size:13px;vertical-align:top;white-space:nowrap">${escapeHtml(fact.label)}</td><td style="padding:4px 0;font-size:13px;line-height:1.5;word-break:break-word">${
          fact.url ? `<a href="${escapeHtml(fact.url)}" style="color:#1c1c1a">${escapeHtml(fact.value)}</a>` : escapeHtml(fact.value)
        }</td></tr>`,
    )
    .join('');
  const link = notice.digest ? notice.executionsUrl : notice.execution?.url;
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f4;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1c1c1a">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e6e6e1;border-radius:16px;padding:28px">
<div style="font-weight:700;font-size:13px;letter-spacing:.02em;color:#b42318">LANDFLOW ALERT</div>
<h1 style="font-size:18px;margin:12px 0 14px">${escapeHtml(subjectOf(notice))}</h1>
<table style="border-collapse:collapse">${rows}</table>
${link ? `<p style="margin:20px 0 0"><a href="${escapeHtml(link)}" style="display:inline-block;background:#1c1c1a;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:999px">${notice.digest ? 'Open executions' : 'Open execution'}</a></p>` : ''}
<p style="font-size:12px;color:#777;margin:18px 0 0">${escapeHtml(footer(notice))}</p>
</div></body></html>`;
}

/** Slack's mrkdwn needs &, < and > escaped. */
const slackEscape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** An incoming-webhook body: `text` for notifications, blocks for the message itself. */
export function slackPayload(notice: AlertNotice) {
  const facts = factsOf(notice);
  const link = facts.find((fact) => fact.url);
  const fields = facts.filter((fact) => !fact.url && fact.label !== 'Error' && fact.label !== 'Latest error');
  const error = facts.find((fact) => fact.label === 'Error' || fact.label === 'Latest error');
  return {
    text: `${notice.test ? '' : ':rotating_light: '}${subjectOf(notice)}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: subjectOf(notice).slice(0, 150), emoji: true } },
      { type: 'section', fields: fields.slice(0, 10).map((fact) => ({ type: 'mrkdwn', text: `*${fact.label}*\n${slackEscape(fact.value)}` })) },
      ...(error ? [{ type: 'section', text: { type: 'mrkdwn', text: `*${error.label}*\n\`\`\`${slackEscape(error.value).slice(0, 2_900)}\`\`\`` } }] : []),
      ...(link ? [{ type: 'section', text: { type: 'mrkdwn', text: `<${link.url}|${notice.digest ? 'Open executions' : 'Open execution'}>` } }] : []),
      { type: 'context', elements: [{ type: 'mrkdwn', text: slackEscape(footer(notice)) }] },
    ],
  };
}

/** The JSON a webhook channel POSTs. */
export function webhookPayload(notice: AlertNotice) {
  return {
    type: notice.digest ? 'alert.digest' : notice.test ? 'alert.test' : 'alert',
    event: notice.event,
    summary: subjectOf(notice),
    rule: notice.rule,
    workflow: notice.workflow,
    ...(notice.execution && { execution: notice.execution }),
    ...(notice.digest && { digest: notice.digest }),
    executionsUrl: notice.executionsUrl,
    ...(notice.test && { test: true }),
    sentAt: notice.at,
  };
}

/** Telegram's HTML parse mode (only &, < and > need escaping). */
export function telegramText(notice: AlertNotice): string {
  const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = factsOf(notice).map((fact) =>
    fact.url ? `<a href="${esc(fact.url)}">${notice.digest ? 'Open executions' : 'Open execution'}</a>` : fact.label === 'Error' || fact.label === 'Latest error' ? `<b>${esc(fact.label)}</b>\n<pre>${esc(fact.value)}</pre>` : `<b>${esc(fact.label)}:</b> ${esc(fact.value)}`,
  );
  // Errors are clipped to 1,000 characters, so this stays under Telegram's 4,096 (cutting it could break a tag).
  return [`<b>${esc(subjectOf(notice))}</b>`, '', ...lines].join('\n');
}
