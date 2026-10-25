/**
 * The next page of a form: GET /form/waiting/<executionId> shows the page a waiting execution
 * waits on (a Form node, or a Wait node set to "On Form Submitted"); POST submits it and resumes
 * the run with the submission as that node's output. Once the run is done, the page shows the end
 * screen (a Form node's ending, or the trigger's "Form Submitted Text").
 */
import type { Workflow } from '@landflow/engine';
import {
  answerSubmission,
  DEFAULT_SUBMITTED_TEXT,
  FORM_TRIGGER,
  finishedResponse,
  formPage,
  messagePage,
  parseSubmission,
  submissionItem,
  waitingPage,
} from '@/lib/server/forms';
import { handler } from '@/lib/server/http';
import { liveExecution, resumeExecution, ResumeError, type RunReply } from '@/lib/server/runner';
import { store } from '@/lib/server/store';
import { deferred } from '@/lib/server/webhooks';
import type { ExecutionRecord } from '@/lib/shared/types';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

const notFound = () => messagePage({ title: 'Form not found', message: 'This form doesn’t exist or has expired.', status: 404 });
const processing = () => messagePage({ title: 'Just a moment…', message: 'Your response is being processed.', refresh: 2 });

/** The end screen's texts when no Form node sets one: the Form Trigger's "Form Submitted Text". */
function fallbackFor(record: ExecutionRecord): { title: string; message: string } {
  const workflow: Workflow | undefined = record.workflow;
  const trigger = workflow?.nodes.find((n) => n.type === FORM_TRIGGER);
  const options = (trigger?.parameters.options ?? {}) as { formSubmittedText?: string };
  return { title: String(trigger?.parameters.formTitle ?? '') || 'Form', message: options.formSubmittedText || DEFAULT_SUBMITTED_TEXT };
}

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (liveExecution(id)) return processing();
  const record = store.getExecution(id);
  if (!record) return notFound();
  const page = waitingPage(record);
  if (page) return formPage(page, { action: `/form/waiting/${id}` });
  if (record.status === 'waiting') return messagePage({ title: 'Not a form', message: 'This execution isn’t waiting for a form submission.', status: 409 });
  return finishedResponse(record, fallbackFor(record));
});

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (liveExecution(id)) return processing();
  const record = store.getExecution(id);
  if (!record) return notFound();
  const page = waitingPage(record);
  if (!page) return record.status === 'waiting' ? messagePage({ title: 'Not a form', message: 'This execution isn’t waiting for a form submission.', status: 409 }) : finishedResponse(record, fallbackFor(record));
  let data: FormData;
  try {
    data = await request.formData();
  } catch {
    return messagePage({ title: 'Invalid submission', message: 'Send the form as application/x-www-form-urlencoded or multipart/form-data.', status: 400 });
  }
  const formMode = record.wait?.data?.formMode === 'test' ? 'test' : 'production';
  const submission = parseSubmission(page, data, formMode);
  if (Object.keys(submission.errors).length) return formPage(page, { action: `/form/waiting/${id}`, values: submission.values, errors: submission.errors, status: 400 });

  const reply = deferred<RunReply>();
  try {
    // resumeExecution claims the execution synchronously, so a double submit gets a ResumeError.
    const run = resumeExecution(id, { kind: 'form', outputs: [[submissionItem(submission.json)]], onReply: (value) => reply.resolve(value) });
    return await answerSubmission(run, reply.promise, fallbackFor(record));
  } catch (caught) {
    if (caught instanceof ResumeError) return caught.status === 409 ? processing() : messagePage({ title: 'Form not found', message: caught.message, status: caught.status });
    throw caught;
  }
});
