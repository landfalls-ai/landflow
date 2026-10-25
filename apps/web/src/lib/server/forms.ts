/**
 * Hosted forms (n8n's Form Trigger and Form nodes): server-rendered pages at /form/<path> for
 * the Form Trigger of an active workflow, and /form/waiting/<executionId> for the next page of
 * a run that waits on a Form node (or a Wait node set to "On Form Submitted"). Plain HTML with a
 * little CSS in Landflow's monochrome look and no client script; the browser's own validation
 * plus a server-side check. A submission becomes `{ <field>: value, submittedAt, formMode }`.
 */
import type { BinaryRef, JsonObject, NodeItem } from '@landflow/protocol';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { ExecutionRecord, FormCompletion } from '../shared/types';
import type { RunReply } from './runner';
import { readMultipart } from './binary/http';
import { store } from './store';

export const FORM_TRIGGER = 'core.formTrigger';
export const FORM_NODE = 'core.form';

export type FormFieldType = 'text' | 'textarea' | 'number' | 'email' | 'password' | 'date' | 'dropdown' | 'checkbox' | 'radio' | 'file';

/** One field, as the nodes' "Form Elements" store it (n8n's names). */
export interface FormField {
  fieldLabel?: string;
  /** Key in the submitted item (default: the label). */
  fieldName?: string;
  fieldType?: FormFieldType;
  requiredField?: boolean;
  placeholder?: string;
  /** Dropdown, checkbox and radio choices: one per line (or n8n's `{ values: [{ option }] }`). */
  fieldOptions?: string | { values?: Array<{ option?: string }> };
  /** Dropdown: allow several choices. */
  multiselect?: boolean;
  /** File: allow several files. */
  multipleFiles?: boolean;
  /** File: what the picker offers, e.g. ".pdf, image/*" (the browser's `accept`). */
  acceptFileTypes?: string;
}

/** A page of a form, as stored with a waiting execution or built from a Form Trigger. */
export interface FormPage {
  title: string;
  description?: string;
  fields: FormField[];
  buttonLabel?: string;
}

export const DEFAULT_SUBMITTED_TEXT = 'Your response has been recorded';

// ---------------------------------------------------------------------------
// Fields and submissions
// ---------------------------------------------------------------------------

/** The fields of a "Form Elements" parameter (`{ values: [...] }`), without empty ones. */
export function formFieldsOf(parameter: unknown): FormField[] {
  const values = (parameter as { values?: FormField[] } | undefined)?.values;
  return (Array.isArray(values) ? values : []).filter((field) => String(field.fieldLabel ?? field.fieldName ?? '').trim());
}

export function optionsOf(field: FormField): string[] {
  const raw = field.fieldOptions;
  const list = typeof raw === 'string' ? raw.split(/\r?\n|,/) : (raw?.values ?? []).map((v) => v.option ?? '');
  return list.map((option) => option.trim()).filter(Boolean);
}

const keyOf = (field: FormField) => String(field.fieldName || field.fieldLabel || '').trim();

export interface ParsedSubmission {
  json: JsonObject;
  /** Field index → message, for fields that failed validation. */
  errors: Record<number, string>;
  /** What was entered, to fill the form in again. */
  values: Record<number, string[]>;
  /** Uploaded files by field key, stored once the submission is accepted (storeSubmissionFiles). */
  files: Record<string, File[]>;
}

/** Read a submitted form (`f0`, `f1`… by field index) into an item, checking required fields and types. */
export function parseSubmission(page: FormPage, data: FormData, formMode: 'production' | 'test'): ParsedSubmission {
  const json: JsonObject = {};
  const errors: Record<number, string> = {};
  const values: Record<number, string[]> = {};
  const files: Record<string, File[]> = {};
  page.fields.forEach((field, index) => {
    if (field.fieldType === 'file') {
      // A file input sends an empty, nameless part when nothing was picked.
      const picked = data.getAll(`f${index}`).filter((v): v is File => typeof v !== 'string' && (v.size > 0 || v.name !== ''));
      if (field.requiredField && !picked.length) errors[index] = 'Choose a file';
      const list = field.multipleFiles ? picked : picked.slice(0, 1);
      if (list.length) files[keyOf(field)] = list;
      json[keyOf(field)] = field.multipleFiles ? list.map((f) => f.name) : (list[0]?.name ?? '');
      return;
    }
    const entered = data.getAll(`f${index}`).map((v) => String(v).trim()).filter((v) => v !== '');
    values[index] = entered;
    const type = field.fieldType ?? 'text';
    const options = optionsOf(field);
    if (field.requiredField && !entered.length) errors[index] = 'This field is required';
    let value: JsonObject[string];
    if (type === 'number') {
      value = entered.length ? Number(entered[0]) : null;
      if (typeof value === 'number' && Number.isNaN(value)) errors[index] = 'Enter a number';
    } else if (type === 'checkbox') {
      value = options.length ? entered.filter((v) => options.includes(v)) : entered.length > 0;
    } else if (type === 'dropdown' && field.multiselect) {
      value = entered.filter((v) => options.includes(v));
    } else if ((type === 'dropdown' || type === 'radio') && options.length) {
      value = entered[0] && options.includes(entered[0]) ? entered[0] : '';
      if (entered[0] && !options.includes(entered[0])) errors[index] = 'Choose one of the options';
    } else if (type === 'email') {
      value = entered[0] ?? '';
      if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) errors[index] = 'Enter an email address';
    } else value = entered[0] ?? '';
    json[keyOf(field)] = value;
  });
  json.submittedAt = new Date().toISOString();
  json.formMode = formMode;
  return { json, errors, values, files };
}

// ---------------------------------------------------------------------------
// Finding forms
// ---------------------------------------------------------------------------

export const normalizePath = (path: unknown) => String(path ?? '').trim().replace(/^\/+|\/+$/g, '');

/** The active workflow whose Form Trigger serves /form/<path>. */
export function findFormTrigger(path: string): { workflow: Workflow; node: WorkflowNode } | undefined {
  for (const workflow of store.listWorkflows()) {
    if (!workflow.active) continue;
    const node = workflow.nodes.find((n) => n.type === FORM_TRIGGER && !n.disabled && normalizePath(n.parameters.path) === path);
    if (node) return { workflow, node };
  }
  return undefined;
}

/** A Form Trigger's first page. */
export function triggerPage(node: WorkflowNode): FormPage {
  const options = (node.parameters.options ?? {}) as { buttonLabel?: string };
  return {
    title: String(node.parameters.formTitle ?? '') || 'Form',
    ...(node.parameters.formDescription ? { description: String(node.parameters.formDescription) } : {}),
    fields: formFieldsOf(node.parameters.formFields),
    buttonLabel: options.buttonLabel || 'Submit',
  };
}

/** Whether a run of this workflow can show more pages (a Form node, or a Wait node waiting for a form). */
export function hasFormPages(workflow: Workflow): boolean {
  return workflow.nodes.some((n) => !n.disabled && (n.type === FORM_NODE || (n.type === 'core.wait' && n.parameters.resume === 'form')));
}

/** The page a waiting execution shows, when it waits for a form. */
export function waitingPage(record: ExecutionRecord | undefined): FormPage | undefined {
  if (record?.status !== 'waiting' || record.wait?.resume !== 'form') return undefined;
  const form = record.wait.data?.form as FormPage | undefined;
  return form && Array.isArray(form.fields) ? form : undefined;
}

// ---------------------------------------------------------------------------
// Answering a submission
// ---------------------------------------------------------------------------

/**
 * What the browser gets after a submission, once the run has a Form node end screen, waits for
 * the next page, or finishes (whichever comes first).
 */
export async function answerSubmission(
  run: Promise<ExecutionRecord>,
  reply: Promise<RunReply>,
  fallback: { title: string; message: string },
): Promise<Response> {
  const outcome = await Promise.race([reply.then((value) => ({ reply: value }) as const), run.then((record) => ({ record }) as const)]);
  if ('reply' in outcome) {
    if (outcome.reply.type === 'form') return completionResponse(outcome.reply.completion, fallback.title);
    return messagePage({ title: fallback.title, message: fallback.message });
  }
  return finishedResponse(outcome.record, fallback);
}

/** The answer for a run that has finished or stopped to wait. */
export function finishedResponse(record: ExecutionRecord, fallback: { title: string; message: string }): Response {
  if (record.status === 'waiting' && record.wait?.resume === 'form') return redirect(`/form/waiting/${record.executionId}`);
  if (record.formCompletion) return completionResponse(record.formCompletion, fallback.title);
  if (record.status === 'error') return messagePage({ title: 'Something went wrong', message: 'There was a problem submitting your response. Please try again later.', status: 500 });
  if (record.status === 'canceled') return messagePage({ title: 'Form closed', message: 'This form is no longer accepting responses.', status: 410 });
  return messagePage(fallback);
}

export function completionResponse(completion: FormCompletion, fallbackTitle: string): Response {
  if (completion.respondWith === 'redirect' && completion.url) return redirect(completion.url);
  return messagePage({ title: completion.title || fallbackTitle, message: completion.message ?? '' });
}

export function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location } });
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

const STYLE = `
:root{--bg:#fafafa;--sf:#fff;--hair:rgba(0,0,0,.08);--bd:#e4e4e4;--t1:#141414;--t2:#5a5a5a;--t3:#737373;--ac:#141414;--on-ac:#fff;--rd:#c0271e;--focus:rgba(0,0,0,.16);color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0d0d0d;--sf:#161616;--hair:rgba(255,255,255,.09);--bd:rgba(255,255,255,.16);--t1:#f2f2f2;--t2:#a8a8a8;--t3:#858585;--ac:#fafafa;--on-ac:#0d0d0d;--rd:#ff6157;--focus:rgba(255,255,255,.22);color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--t1);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;flex-direction:column;align-items:center;padding:48px 16px}
main{width:100%;max-width:520px;background:var(--sf);border:1px solid var(--hair);border-radius:14px;padding:32px;box-shadow:0 1px 0 var(--hair)}
h1{margin:0 0 6px;font-size:22px;font-weight:650;letter-spacing:-.01em}
.desc{margin:0 0 24px;color:var(--t2);white-space:pre-line}
.field{margin:0 0 18px}
label,.legend{display:block;margin:0 0 6px;font-weight:550}
.req{color:var(--rd);margin-left:2px}
input[type=text],input[type=email],input[type=password],input[type=number],input[type=date],select,textarea{width:100%;padding:9px 11px;border:1px solid var(--bd);border-radius:9px;background:var(--sf);color:var(--t1);font:inherit}
input[type=file]{width:100%;padding:8px 0;color:var(--t2,inherit);font:inherit}
textarea{min-height:96px;resize:vertical}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--ac);box-shadow:0 0 0 3px var(--focus)}
.choice{display:flex;align-items:center;gap:8px;margin:4px 0;font-weight:400}
.choice input{accent-color:var(--ac);width:16px;height:16px;margin:0}
.error{margin:6px 0 0;color:var(--rd);font-size:13px}
button{margin-top:8px;width:100%;padding:10px 14px;border:0;border-radius:999px;background:var(--ac);color:var(--on-ac);font:inherit;font-weight:600;cursor:pointer}
button:hover{opacity:.88}
.message{margin:0;color:var(--t2);white-space:pre-line}
footer{margin-top:20px;color:var(--t3);font-size:12px}
`;

function document(title: string, body: string, head = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>${head}<style>${STYLE}</style></head><body><main>${body}</main><footer>Powered by Landflow</footer></body></html>`;
}

function html(markup: string, status = 200): Response {
  return new Response(markup, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

function fieldMarkup(field: FormField, index: number, entered: string[] = [], error?: string): string {
  const id = `f${index}`;
  const label = escapeHtml(field.fieldLabel || field.fieldName);
  const required = field.requiredField ? ' required' : '';
  const star = field.requiredField ? '<span class="req" aria-hidden="true">*</span>' : '';
  const placeholder = field.placeholder ? ` placeholder="${escapeHtml(field.placeholder)}"` : '';
  const type = field.fieldType ?? 'text';
  const options = optionsOf(field);
  const errorMarkup = error ? `<p class="error" id="${id}-error">${escapeHtml(error)}</p>` : '';
  const described = error ? ` aria-describedby="${id}-error" aria-invalid="true"` : '';
  let control: string;
  if (type === 'textarea') {
    control = `<label for="${id}">${label}${star}</label><textarea id="${id}" name="${id}"${placeholder}${required}${described}>${escapeHtml(entered[0] ?? '')}</textarea>`;
  } else if (type === 'dropdown') {
    const multiple = field.multiselect ? ' multiple' : '';
    const first = field.multiselect ? '' : `<option value="">${escapeHtml(field.placeholder || 'Choose…')}</option>`;
    const choices = options.map((o) => `<option value="${escapeHtml(o)}"${entered.includes(o) ? ' selected' : ''}>${escapeHtml(o)}</option>`).join('');
    control = `<label for="${id}">${label}${star}</label><select id="${id}" name="${id}"${multiple}${required}${described}>${first}${choices}</select>`;
  } else if (type === 'checkbox' && !options.length) {
    control = `<label class="choice"><input type="checkbox" name="${id}" value="on"${entered.length ? ' checked' : ''}${required}${described}> ${label}${star}</label>`;
  } else if (type === 'checkbox' || type === 'radio') {
    const inputType = type === 'checkbox' ? 'checkbox' : 'radio';
    const choices = options
      .map((o, i) => `<label class="choice"><input type="${inputType}" name="${id}" value="${escapeHtml(o)}"${entered.includes(o) ? ' checked' : ''}${type === 'radio' && i === 0 ? required : ''}> ${escapeHtml(o)}</label>`)
      .join('');
    control = `<fieldset style="border:0;margin:0;padding:0"${described}><legend class="legend">${label}${star}</legend>${choices}</fieldset>`;
  } else if (type === 'file') {
    const multiple = field.multipleFiles ? ' multiple' : '';
    const accept = field.acceptFileTypes?.trim() ? ` accept="${escapeHtml(field.acceptFileTypes.trim())}"` : '';
    control = `<label for="${id}">${label}${star}</label><input id="${id}" name="${id}" type="file"${multiple}${accept}${required}${described}>`;
  } else {
    const value = entered[0] ? ` value="${escapeHtml(entered[0])}"` : '';
    const step = type === 'number' ? ' step="any"' : '';
    control = `<label for="${id}">${label}${star}</label><input id="${id}" name="${id}" type="${type}"${value}${placeholder}${step}${required}${described}>`;
  }
  return `<div class="field">${control}${errorMarkup}</div>`;
}

/** A form page; `values` and `errors` refill it after a failed check. */
export function formPage(page: FormPage, options: { action: string; values?: Record<number, string[]>; errors?: Record<number, string>; status?: number }): Response {
  const fields = page.fields.map((field, index) => fieldMarkup(field, index, options.values?.[index], options.errors?.[index])).join('');
  const description = page.description ? `<p class="desc">${escapeHtml(page.description)}</p>` : '';
  const body = `<h1>${escapeHtml(page.title)}</h1>${description}<form method="post" action="${escapeHtml(options.action)}" accept-charset="utf-8"${page.fields.some((f) => f.fieldType === 'file') ? ' enctype="multipart/form-data"' : ''}>${fields}<button type="submit">${escapeHtml(page.buttonLabel || 'Submit')}</button></form>`;
  return html(document(page.title, body), options.status);
}

/** A page with a title and a message (completion, errors); `refresh` reloads it after that many seconds. */
export function messagePage(options: { title: string; message: string; status?: number; refresh?: number }): Response {
  const head = options.refresh ? `<meta http-equiv="refresh" content="${options.refresh}">` : '';
  return html(document(options.title, `<h1>${escapeHtml(options.title)}</h1><p class="message">${escapeHtml(options.message)}</p>`, head), options.status);
}

/** The submission as the item a run receives. */
export function submissionItem(json: JsonObject, binary?: Record<string, BinaryRef>): NodeItem {
  return { json, ...(binary && Object.keys(binary).length && { binary }) };
}

/**
 * Store a submission's files in an execution's scope: `item.binary.<field>`, or `<field>0`, `<field>1`… for a
 * field with several files (as the Webhook trigger names multipart files).
 */
export async function storeSubmissionFiles(files: Record<string, File[]>, executionId: string): Promise<Record<string, BinaryRef>> {
  const form = new FormData();
  for (const [key, list] of Object.entries(files)) for (const file of list) form.append(key, file);
  return (await readMultipart(form, executionId)).binary;
}
