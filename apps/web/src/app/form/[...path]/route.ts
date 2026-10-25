/**
 * Hosted forms of Form Triggers: GET /form/<path> shows the form of the active workflow whose
 * On Form Submission trigger has that path; POST submits it and starts a run with
 * `{ <field>: value, submittedAt, formMode }`. The answer follows the trigger's "Respond When":
 * the end screen right away, or once the run finishes, shows a Form node's ending, or waits on its
 * next page (a redirect to /form/waiting/<executionId>). Plain HTML, no client script.
 */
import { context } from '@opentelemetry/api';
import { DEFAULT_SUBMITTED_TEXT, findFormTrigger, formPage, hasFormPages, messagePage, normalizePath, parseSubmission, submissionItem, triggerPage, answerSubmission } from '@/lib/server/forms';
import { handler } from '@/lib/server/http';
import { runWorkflow, type RunReply } from '@/lib/server/runner';
import { startTrigger } from '@/lib/server/telemetry';
import { deferred } from '@/lib/server/webhooks';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ path: string[] }> };

const notFound = () => messagePage({ title: 'Form not found', message: 'This form doesn’t exist, or its workflow isn’t active.', status: 404 });

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const path = normalizePath((await params).path.join('/'));
  const found = findFormTrigger(path);
  if (!found) return notFound();
  return formPage(triggerPage(found.node), { action: `/form/${path}` });
});

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const path = normalizePath((await params).path.join('/'));
  const found = findFormTrigger(path);
  if (!found) return notFound();
  const { workflow, node } = found;
  const page = triggerPage(node);
  let data: FormData;
  try {
    data = await request.formData();
  } catch {
    return messagePage({ title: 'Invalid submission', message: 'Send the form as application/x-www-form-urlencoded or multipart/form-data.', status: 400 });
  }
  const submission = parseSubmission(page, data, 'production');
  if (Object.keys(submission.errors).length) return formPage(page, { action: `/form/${path}`, values: submission.values, errors: submission.errors, status: 400 });

  const options = (node.parameters.options ?? {}) as { formSubmittedText?: string };
  const fallback = { title: page.title, message: options.formSubmittedText || DEFAULT_SUBMITTED_TEXT };
  const trigger = startTrigger({ source: 'form', workflowId: workflow.id, nodeName: node.name });
  const reply = deferred<RunReply>();
  const run = context.with(trigger.context, () =>
    runWorkflow({ workflow, mode: 'webhook', startNodeId: node.id, triggerItems: [submissionItem(submission.json)], onReply: (value) => reply.resolve(value) }),
  );
  run.then(
    () => trigger.end(),
    (caught) => trigger.end(caught),
  );
  // "Form Is Submitted" with no further pages: the end screen now, while the run goes on.
  if (node.parameters.responseMode !== 'lastNode' && !hasFormPages(workflow)) {
    run.catch(() => undefined);
    return messagePage(fallback);
  }
  return answerSubmission(run, reply.promise, fallback);
});
