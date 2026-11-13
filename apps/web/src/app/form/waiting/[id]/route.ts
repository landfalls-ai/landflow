/**
 * The next page of a form: GET /form/waiting/<executionId> shows the page a waiting execution
 * waits on (a Form node, or a Wait node set to "On Form Submitted"); POST submits it and resumes
 * the run with the submission as that node's output. Once the run is done, the page shows the end
 * screen (a Form node's ending, or the trigger's "Form Submitted Text"). File fields are stored with the execution
 * (`item.binary.<field>`).
 */
import type { Workflow } from '@landflow/engine';
import type { BinaryRef } from '@landflow/protocol';
import { binaryLimits } from '@/lib/server/binary/access';
import { BinaryTooLargeError } from '@/lib/server/binary/store';
import {
  answerSubmission,
  DEFAULT_SUBMITTED_TEXT,
  FORM_TRIGGER,
  finishedResponse,
  formPage,
  messagePage,
  parseSubmission,
  storeSubmissionFiles,
  submissionItem,
  waitingPage,
} from '@/lib/server/forms';
import { resolvePrincipal } from '@/lib/server/auth';
import { canResource } from '@/lib/server/projects/access';
import { handler } from '@/lib/server/http';
import { liveExecution, resumeExecution, ResumeError, type RunReply } from '@/lib/server/runner';
import { checkResume } from '@/lib/server/resume-signing';
import { store } from '@/lib/server/store';
import { logger } from '@/lib/server/telemetry';
import { deferred } from '@/lib/server/webhooks';
import type { ExecutionRecord } from '@/lib/shared/types';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const notFound = () => messagePage({ title: 'Form not found', message: 'This form doesn’t exist or has expired.', status: 404 });
const tooLarge = (limit: number) =>
  messagePage({ title: 'File too large', message: `Uploads can be up to ${Math.floor(limit / (1024 * 1024))} MiB.`, status: 413 });
const invalid = () => messagePage({ title: 'Form not found', message: 'This link is not valid.', status: 403 });
/** The form's own address keeps `?sig=`, so a submit carries it too. */
const actionFor = (id: string, request: Request) => {
  const sig = new URL(request.url).searchParams.get('sig');
  return `/form/waiting/${id}${sig ? `?sig=${encodeURIComponent(sig)}` : ''}`;
};
const signatureRefused = (id: string, request: Request, record: ExecutionRecord, action: 'read' | 'run') => {
  if (record.status !== 'waiting' || !record.wait) return false;
  // Signed-in people reach the page from the editor and the Run Trace, which don't hold the signature: they skip it
  // for a workflow they may read (the page) or run (the submit). Anyone else needs the signed link.
  const resolved = resolvePrincipal(request);
  if (resolved.ok && resolved.principal && canResource(resolved.principal.user, 'workflow', record.workflowId, action)) return false;
  const result = checkResume(id, new URL(request.url).searchParams.get('sig'), record.wait);
  if (result.ok && result.legacy) logger.info('form resume accepted without a signature: the wait was saved before resume URLs were signed', { 'landflow.execution.id': id });
  return !result.ok;
};
const processing = () => messagePage({ title: 'Just a moment…', message: 'Your response is being processed.', refresh: 2 });

/** The end screen's texts when no Form node sets one: the Form Trigger's "Form Submitted Text". */
function fallbackFor(record: ExecutionRecord): { title: string; message: string } {
  const workflow: Workflow | undefined = record.workflow;
  const trigger = workflow?.nodes.find((n) => n.type === FORM_TRIGGER);
  const options = (trigger?.parameters.options ?? {}) as { formSubmittedText?: string };
  return { title: String(trigger?.parameters.formTitle ?? '') || 'Form', message: options.formSubmittedText || DEFAULT_SUBMITTED_TEXT };
}

export const GET = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (liveExecution(id)) return processing();
  const record = store.getExecution(id);
  if (!record) return notFound();
  if (signatureRefused(id, request, record, 'read')) return invalid();
  const page = waitingPage(record);
  if (page) return formPage(page, { action: actionFor(id, request) });
  if (record.status === 'waiting') return messagePage({ title: 'Not a form', message: 'This execution isn’t waiting for a form submission.', status: 409 });
  return finishedResponse(record, fallbackFor(record));
});

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (liveExecution(id)) return processing();
  const record = store.getExecution(id);
  if (!record) return notFound();
  if (signatureRefused(id, request, record, 'run')) return invalid();
  const page = waitingPage(record);
  if (!page) return record.status === 'waiting' ? messagePage({ title: 'Not a form', message: 'This execution isn’t waiting for a form submission.', status: 409 }) : finishedResponse(record, fallbackFor(record));
  const { maxBytes } = binaryLimits();
  if (Number(request.headers.get('content-length')) > maxBytes) return tooLarge(maxBytes);
  let data: FormData;
  try {
    data = await request.formData();
  } catch {
    return messagePage({ title: 'Invalid submission', message: 'Send the form as application/x-www-form-urlencoded or multipart/form-data.', status: 400 });
  }
  const formMode = record.wait?.data?.formMode === 'test' ? 'test' : 'production';
  const submission = parseSubmission(page, data, formMode);
  if (Object.keys(submission.errors).length) return formPage(page, { action: actionFor(id, request), values: submission.values, errors: submission.errors, status: 400 });

  // Files go into the execution's scope, so they're deleted with it.
  let binary: Record<string, BinaryRef> | undefined;
  if (Object.keys(submission.files).length) {
    try {
      binary = await storeSubmissionFiles(submission.files, id);
    } catch (caught) {
      if (caught instanceof BinaryTooLargeError) return tooLarge(caught.maxBytes);
      throw caught;
    }
  }
  const reply = deferred<RunReply>();
  try {
    // resumeExecution claims the execution synchronously, so a double submit gets a ResumeError.
    const run = resumeExecution(id, { kind: 'form', outputs: [[submissionItem(submission.json, binary)]], onReply: (value) => reply.resolve(value) });
    return await answerSubmission(run, reply.promise, fallbackFor(record));
  } catch (caught) {
    if (caught instanceof ResumeError) return caught.status === 409 ? processing() : messagePage({ title: 'Form not found', message: caught.message, status: caught.status });
    throw caught;
  }
});
