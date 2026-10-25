/**
 * Test forms: /form-test/<path> serves the form of the On Form Submission trigger an editor listens for ("Listen for test
 * event" or "Open test form", POST /api/workflows/:id/listen), and 404 otherwise. GET shows the form (as often as you
 * like), POST submits it once: the submission (`formMode: 'test'`) runs the workflow the editor sent when it started
 * listening as a manual run, which the editor shows live, and the answer follows the trigger's "Respond When" as on
 * /form/<path>. A multi-page form goes on at /form/waiting/<executionId>; until the run finishes, GET here reloads its
 * current page. The trigger's authentication and IP allow-list apply; file fields arrive as `item.binary.<field>`.
 * See lib/server/test-webhooks.ts.
 */
import type { BinaryRef } from '@landflow/protocol';
import type { WorkflowNode } from '@landflow/engine';
import { binaryLimits, deleteExecutionBinary } from '@/lib/server/binary/access';
import { BinaryTooLargeError } from '@/lib/server/binary/store';
import { clusterActive } from '@/lib/server/cluster/state';
import { refreshRows } from '@/lib/server/db/replication';
import {
  answerSubmission,
  DEFAULT_SUBMITTED_TEXT,
  formPage,
  hasFormPages,
  messagePage,
  normalizePath,
  parseSubmission,
  redirect,
  storeSubmissionFiles,
  submissionItem,
  triggerPage,
  waitingPage,
} from '@/lib/server/forms';
import { handler } from '@/lib/server/http';
import { liveExecution, type RunReply } from '@/lib/server/runner';
import { store } from '@/lib/server/store';
import { claimTestListener, failTestEvent, findTestListener, runTestEvent, testFormMiss, type TestListener } from '@/lib/server/test-webhooks';
import { checkWebhookAuth } from '@/lib/server/webhook-auth';
import { deferred } from '@/lib/server/webhooks';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ path: string[] }> };

const tooLarge = (limit: number) =>
  messagePage({ title: 'File too large', message: `Uploads can be up to ${Math.floor(limit / (1024 * 1024))} MiB.`, status: 413 });

/** The trigger's authentication and IP allow-list (as on /form/<path>), refused calls as an HTML page. */
async function refused(request: Request, node: WorkflowNode): Promise<Response | undefined> {
  const auth = await checkWebhookAuth(request, node, 'Form Trigger', 'Form');
  if (auth.ok) return undefined;
  const { status } = auth.response;
  const message = status === 403 ? 'You are not allowed to open this form.' : status === 401 ? 'Sign in to open this form.' : 'This form is not set up correctly.';
  const page = messagePage({ title: status === 403 ? 'Access denied' : status === 401 ? 'Sign-in required' : 'Form unavailable', message, status });
  const challenge = auth.response.headers.get('www-authenticate');
  if (challenge) page.headers.set('www-authenticate', challenge);
  return page;
}

/** A test form that was submitted: the run's next page when it waits for one, else a note that it was submitted. */
async function submitted(listener: TestListener, status = 200): Promise<Response> {
  const id = listener.executionId;
  if (clusterActive()) await refreshRows('executions', { id }).catch(() => {});
  if (!liveExecution(id) && waitingPage(store.getExecution(id))) return redirect(`/form/waiting/${id}`);
  return messagePage({ title: 'Form submitted', message: 'This test form was submitted and its test run is in progress. Listen for a test event in the editor to submit it again.', status });
}

export const GET = handler(async (request: Request, { params }: Ctx) => {
  const path = normalizePath((await params).path.join('/'));
  const found = await findTestListener('form', path);
  if (!found) return testFormMiss();
  const denied = await refused(request, found.node);
  if (denied) return denied;
  if (found.claimed) return submitted(found.listener);
  return formPage(triggerPage(found.node), { action: `/form-test/${path}` });
});

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const path = normalizePath((await params).path.join('/'));
  const found = await findTestListener('form', path);
  if (!found) return testFormMiss();
  const { listener, node } = found;
  const denied = await refused(request, node);
  if (denied) return denied;
  if (found.claimed) return submitted(listener, 409);
  const page = triggerPage(node);
  const { maxBytes } = binaryLimits();
  if (Number(request.headers.get('content-length')) > maxBytes) return tooLarge(maxBytes);
  let data: FormData;
  try {
    data = await request.formData();
  } catch {
    return messagePage({ title: 'Invalid submission', message: 'Send the form as application/x-www-form-urlencoded or multipart/form-data.', status: 400 });
  }
  // A submission that fails the checks shows the form again and leaves the listener as it was.
  const submission = parseSubmission(page, data, 'test');
  if (Object.keys(submission.errors).length) return formPage(page, { action: `/form-test/${path}`, values: submission.values, errors: submission.errors, status: 400 });
  if (!(await claimTestListener(listener))) return testFormMiss();

  const { executionId } = listener;
  let binary: Record<string, BinaryRef> | undefined;
  if (Object.keys(submission.files).length) {
    try {
      binary = await storeSubmissionFiles(submission.files, executionId);
    } catch (caught) {
      void deleteExecutionBinary(executionId);
      failTestEvent(listener, `The test form submission failed: ${(caught as Error).message}`);
      if (caught instanceof BinaryTooLargeError) return tooLarge(caught.maxBytes);
      throw caught;
    }
  }
  const options = (node.parameters.options ?? {}) as { formSubmittedText?: string };
  const fallback = { title: page.title, message: options.formSubmittedText || DEFAULT_SUBMITTED_TEXT };
  const reply = deferred<RunReply>();
  const { run, started } = runTestEvent(listener, submissionItem(submission.json, binary), { onReply: (value) => reply.resolve(value) });
  if ((await started) !== undefined) {
    if (binary) void deleteExecutionBinary(executionId);
    return messagePage({ title: 'Something went wrong', message: 'The test run could not start. See the editor for details.', status: 500 });
  }
  // "Form Is Submitted" with no further pages: the end screen now, while the run goes on.
  if (node.parameters.responseMode !== 'lastNode' && !hasFormPages(listener.workflow)) {
    run.catch(() => undefined);
    return messagePage(fallback);
  }
  return answerSubmission(run, reply.promise, fallback);
});
