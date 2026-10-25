/**
 * Hosted forms of Form Triggers: GET /form/<path> shows the form of the active workflow whose
 * On Form Submission trigger has that path; POST submits it and starts a run with
 * `{ <field>: value, submittedAt, formMode }`. The answer follows the trigger's "Respond When":
 * the end screen right away, or once the run finishes, shows a Form node's ending, or waits on its
 * next page (a redirect to /form/waiting/<executionId>). File fields arrive as `item.binary.<field>` (413 past
 * LANDFLOW_BINARY_MAX_BYTES). Plain HTML, no client script.
 *
 * A submission with an `Idempotency-Key` header that was seen for the workflow within the retention window
 * starts no new run (it gets the end screen again); a workflow at its concurrency limit that skips runs answers 429.
 */
import { context } from '@opentelemetry/api';
import type { BinaryRef } from '@landflow/protocol';
import { binaryLimits, deleteExecutionBinary } from '@/lib/server/binary/access';
import { BinaryTooLargeError } from '@/lib/server/binary/store';
import {
  DEFAULT_SUBMITTED_TEXT,
  findFormTrigger,
  formPage,
  hasFormPages,
  messagePage,
  normalizePath,
  parseSubmission,
  storeSubmissionFiles,
  submissionItem,
  triggerPage,
  answerSubmission,
} from '@/lib/server/forms';
import { handler } from '@/lib/server/http';
import { findIdempotent, idempotencyKeyOf } from '@/lib/server/idempotency';
import { DuplicateRunError, newExecutionId, runWorkflow, RunSkippedError, type RunReply } from '@/lib/server/runner';
import { startTrigger } from '@/lib/server/telemetry';
import { deferred } from '@/lib/server/webhooks';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ path: string[] }> };

const tooLarge = (limit: number) =>
  messagePage({ title: 'File too large', message: `Uploads can be up to ${Math.floor(limit / (1024 * 1024))} MiB.`, status: 413 });

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
  const { maxBytes } = binaryLimits();
  if (Number(request.headers.get('content-length')) > maxBytes) return tooLarge(maxBytes);
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
  const idempotencyKey = idempotencyKeyOf(request);
  const replayed = () => {
    const response = messagePage(fallback);
    response.headers.set('idempotent-replayed', 'true');
    return response;
  };
  if (idempotencyKey && findIdempotent(workflow.id, idempotencyKey)) return replayed();
  // Files are stored under the run's id before it starts; they go if it never does.
  const executionId = newExecutionId();
  let binary: Record<string, BinaryRef> | undefined;
  if (Object.keys(submission.files).length) {
    try {
      binary = await storeSubmissionFiles(submission.files, executionId);
    } catch (caught) {
      void deleteExecutionBinary(executionId);
      if (caught instanceof BinaryTooLargeError) return tooLarge(caught.maxBytes);
      throw caught;
    }
  }
  const trigger = startTrigger({ source: 'form', workflowId: workflow.id, nodeName: node.name });
  const reply = deferred<RunReply>();
  let started = false;
  const run = context.with(trigger.context, () =>
    runWorkflow({
      workflow,
      mode: 'webhook',
      startNodeId: node.id,
      triggerItems: [submissionItem(submission.json, binary)],
      executionId,
      ...(idempotencyKey && { idempotencyKey }),
      onStart: () => (started = true),
      onReply: (value) => reply.resolve(value),
    }),
  );
  run.then(
    () => trigger.end(),
    (caught) => {
      if (!started && binary) void deleteExecutionBinary(executionId);
      trigger.end(caught);
    },
  );
  if (!started) {
    // Turned down before it started (onStart is called synchronously otherwise).
    const caught = await run.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    if (caught instanceof DuplicateRunError) return replayed();
    if (caught instanceof RunSkippedError) return messagePage({ title: 'Please try again later', message: 'This form is busy right now. Submit it again in a moment.', status: 429 });
    if (caught !== undefined) throw caught;
  }
  // "Form Is Submitted" with no further pages: the end screen now, while the run goes on.
  if (node.parameters.responseMode !== 'lastNode' && !hasFormPages(workflow)) {
    run.catch(() => undefined);
    return messagePage(fallback);
  }
  return answerSubmission(run, reply.promise, fallback);
});
