/**
 * n8n's Form Trigger and Form nodes. The host serves the pages (lib/server/forms.ts): the
 * trigger's form at /form/<path> while the workflow is active, and each Form page at
 * /form/waiting/<executionId>, where the run waits until it is submitted. The Form node's
 * "Form Ending" sets the screen shown after the last page.
 */
import { defineNode, NodeOperationError, type JsonObject, type NodeItem, type PropertyDescriptor } from '@landflow/sdk';
import type { FormCompletion } from '../../shared/types';
import { formFieldsOf, normalizePath, type FormPage } from '../forms';

const main = [{ type: 'main' as const }];

/** "Form Elements": the fields of a page (n8n's names). */
export const formFieldsProperty: PropertyDescriptor = {
  name: 'formFields',
  displayName: 'Form Elements',
  type: 'fixedCollection',
  typeOptions: { multipleValues: true },
  placeholder: 'Add form element',
  default: { values: [{ fieldLabel: 'Name', fieldType: 'text', requiredField: true }] },
  groups: [
    {
      name: 'values',
      displayName: 'Element',
      values: [
        { name: 'fieldLabel', displayName: 'Field Label', type: 'string', default: '', placeholder: 'e.g. What is your name?', required: true },
        {
          name: 'fieldType',
          displayName: 'Element Type',
          type: 'options',
          default: 'text',
          options: [
            { name: 'Text', value: 'text' },
            { name: 'Textarea', value: 'textarea' },
            { name: 'Number', value: 'number' },
            { name: 'Email', value: 'email' },
            { name: 'Password', value: 'password' },
            { name: 'Date', value: 'date' },
            { name: 'Dropdown List', value: 'dropdown' },
            { name: 'Checkboxes', value: 'checkbox', description: 'With options: pick any; without: one yes/no box' },
            { name: 'Radio Buttons', value: 'radio' },
            { name: 'File', value: 'file', description: 'An upload: the file goes to item.binary.<field name>' },
          ],
        },
        { name: 'fieldOptions', displayName: 'Options', type: 'string', default: '', typeOptions: { rows: 3 }, description: 'Dropdown, checkboxes and radio buttons: one choice per line' },
        { name: 'multiselect', displayName: 'Multiple Choice', type: 'boolean', default: false, description: 'Dropdown: allow several choices' },
        { name: 'multipleFiles', displayName: 'Multiple Files', type: 'boolean', default: false, description: 'File: allow several files (item.binary.<field>0, <field>1…)' },
        { name: 'acceptFileTypes', displayName: 'Accepted File Types', type: 'string', default: '', placeholder: 'e.g. .pdf, image/*', description: 'File: what the file picker offers' },
        { name: 'requiredField', displayName: 'Required Field', type: 'boolean', default: false },
        { name: 'placeholder', displayName: 'Placeholder', type: 'string', default: '' },
        { name: 'fieldName', displayName: 'Field Name', type: 'string', default: '', description: 'Key in the output item (default: the label)' },
      ],
    },
  ],
};

/** A page as stored with the wait: the fields and texts, resolved for the first item. */
export function pageOf(title: unknown, description: unknown, fields: unknown, buttonLabel: unknown): FormPage {
  const page: FormPage = { title: String(title ?? '').trim() || 'Form', fields: formFieldsOf(fields), buttonLabel: String(buttonLabel ?? '').trim() || 'Submit' };
  if (String(description ?? '').trim()) page.description = String(description);
  if (!page.fields.length) throw new NodeOperationError('Add at least one form element');
  return page;
}

/** The page's mode: a manual (editor) run is a test. */
export const formModeOf = (mode: string) => (mode === 'manual' ? 'test' : 'production');

export const formTrigger = defineNode({
  description: {
    name: 'formTrigger',
    displayName: 'On Form Submission',
    description: 'Start the workflow when someone submits a form hosted at /form/<path>',
    version: 1,
    kind: 'trigger',
    // A form is an HTTP endpoint, like the Webhook trigger.
    triggerSource: 'webhook',
    categories: ['Triggers'],
    icon: 'lucide:clipboard-list',
    color: '#f97316',
    subtitle: '/form/{{path}}',
    keywords: ['form', 'survey', 'submission', 'page'],
    inputs: [],
    outputs: main,
    properties: [
      { name: 'path', displayName: 'Form Path', type: 'string', default: 'my-form', required: true, noDataExpression: true, description: 'The form is served at /form/<path>' },
      { name: 'formTitle', displayName: 'Form Title', type: 'string', default: 'Contact us', required: true, noDataExpression: true },
      { name: 'formDescription', displayName: 'Form Description', type: 'string', default: '', typeOptions: { rows: 2 }, noDataExpression: true, description: 'Shown under the title' },
      formFieldsProperty,
      {
        name: 'responseMode',
        displayName: 'Respond When',
        type: 'options',
        default: 'onReceived',
        noDataExpression: true,
        options: [
          { name: 'Form Is Submitted', value: 'onReceived', description: 'Show the end screen straight away' },
          { name: 'Workflow Finishes', value: 'lastNode', description: 'Show it once the run is done (or a Form node ends the form)' },
        ],
      },
      {
        name: 'options',
        displayName: 'Options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        values: [
          { name: 'buttonLabel', displayName: 'Button Label', type: 'string', default: 'Submit' },
          { name: 'formSubmittedText', displayName: 'Form Submitted Text', type: 'string', default: 'Your response has been recorded', description: 'The end screen, unless a Form node sets one' },
        ],
      },
      {
        name: 'notice',
        displayName: 'Activate the workflow to serve the form. Each submission is an item { <field>: value, submittedAt, formMode }; add Form nodes for more pages.',
        type: 'notice',
      },
    ],
  },
  execute(ctx) {
    // The host hands over the submission; a manual run gets an example with the field names.
    const items = ctx.getInputData();
    const fields = formFieldsOf(ctx.getNodeParameter('formFields', 0));
    const path = normalizePath(ctx.getNodeParameter('path', 0));
    if (path.startsWith('waiting/') || path === 'waiting') throw new NodeOperationError('The form path can’t start with “waiting”', { description: '/form/waiting/… shows the pages of waiting runs.' });
    return [
      items.map((item, index): NodeItem => {
        if (Object.keys(item.json).length) return { ...item, pairedItem: { item: index } };
        const json: JsonObject = Object.fromEntries(
          fields.map((f) => [String(f.fieldName || f.fieldLabel).trim(), f.fieldType === 'number' ? 0 : f.fieldType === 'checkbox' ? false : f.fieldType === 'file' && f.multipleFiles ? [] : '']),
        );
        return { json: { ...json, submittedAt: new Date().toISOString(), formMode: 'test' }, pairedItem: { item: index } };
      }),
    ];
  },
});

export const formNode = defineNode({
  description: {
    name: 'form',
    displayName: 'Form',
    description: 'Show the next page of a form, or its end screen',
    version: 1,
    kind: 'action',
    categories: ['Flow'],
    icon: 'lucide:file-text',
    color: '#22c55e',
    subtitle: '{{operation}}',
    keywords: ['form', 'page', 'multi-step', 'completion'],
    inputs: main,
    outputs: main,
    properties: [
      {
        name: 'operation',
        displayName: 'Page Type',
        type: 'options',
        default: 'page',
        noDataExpression: true,
        options: [
          { name: 'Next Form Page', value: 'page', description: 'The run waits until this page is submitted' },
          { name: 'Form Ending', value: 'completion', description: 'What the person sees after the last page' },
        ],
      },
      { name: 'formTitle', displayName: 'Page Title', type: 'string', default: '', displayOptions: { show: { operation: ['page'] } } },
      { name: 'formDescription', displayName: 'Page Description', type: 'string', default: '', typeOptions: { rows: 2 }, displayOptions: { show: { operation: ['page'] } } },
      { ...formFieldsProperty, displayOptions: { show: { operation: ['page'] } } },
      { name: 'buttonLabel', displayName: 'Button Label', type: 'string', default: 'Submit', displayOptions: { show: { operation: ['page'] } } },
      {
        name: 'respondWith',
        displayName: 'On n8n Form Submission',
        type: 'options',
        default: 'text',
        displayOptions: { show: { operation: ['completion'] } },
        options: [
          { name: 'Show Completion Screen', value: 'text' },
          { name: 'Redirect to URL', value: 'redirect' },
        ],
      },
      { name: 'completionTitle', displayName: 'Completion Title', type: 'string', default: 'Thank you', displayOptions: { show: { operation: ['completion'], respondWith: ['text'] } } },
      { name: 'completionMessage', displayName: 'Completion Message', type: 'string', default: '', typeOptions: { rows: 2 }, displayOptions: { show: { operation: ['completion'], respondWith: ['text'] } } },
      { name: 'redirectUrl', displayName: 'URL', type: 'string', default: '', placeholder: 'https://example.com', displayOptions: { show: { operation: ['completion'], respondWith: ['redirect'] } } },
      {
        name: 'notice',
        displayName: 'Use after an On Form Submission trigger. Each page is served at /form/waiting/<execution id>; its output is the submitted fields.',
        type: 'notice',
      },
    ],
  },
  async execute(ctx) {
    const items = ctx.getInputData();
    if (ctx.getNodeParameter('operation', 0) === 'completion') {
      const completion: FormCompletion =
        ctx.getNodeParameter('respondWith', 0) === 'redirect'
          ? { respondWith: 'redirect', url: String(ctx.getNodeParameter('redirectUrl', 0) ?? '').trim() }
          : { respondWith: 'text', title: String(ctx.getNodeParameter('completionTitle', 0) ?? ''), message: String(ctx.getNodeParameter('completionMessage', 0) ?? '') };
      if (completion.respondWith === 'redirect' && !completion.url) throw new NodeOperationError('Set the URL to redirect to');
      // Loaded lazily: the runner needs the registry this plugin is part of.
      const { deliverReply } = await import('../runner');
      deliverReply(ctx.getExecutionId(), { type: 'form', completion });
      return [items];
    }
    if (!ctx.putExecutionToWait) throw new NodeOperationError('A form page can only run inside a workflow execution');
    const form = pageOf(ctx.getNodeParameter('formTitle', 0), ctx.getNodeParameter('formDescription', 0), ctx.getNodeParameter('formFields', 0), ctx.getNodeParameter('buttonLabel', 0));
    ctx.putExecutionToWait({ resume: 'form', data: { form: form as unknown as JsonObject, formMode: formModeOf(ctx.mode) } });
    ctx.logger.info(`Waiting for the form page at /form/waiting/${ctx.getExecutionId()}`);
    return [items];
  },
});
