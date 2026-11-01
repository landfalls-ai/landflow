/**
 * Find Runbook: for each alert, the runbook (a workflow tagged `runbook`) written for alerts of the same kind
 * (docs/runbooks.md). The item gets `runbook` ({ id, name, url, startUrl, … } or null) and `runbookFound`; with a
 * match, `runbookLine` is a sentence for a Slack message or a Landfall note.
 */
import { defineNode, type JsonObject } from '@landflow/sdk';
import { alertKindOf, alertKindSlug, findRunbooks } from '../runbooks';

const main = [{ type: 'main' as const }];

export const findRunbookNode = defineNode({
  description: {
    name: 'findRunbook',
    displayName: 'Find Runbook',
    description: 'Look up the runbook for an alert of the same kind, with a link to open it and one to start it',
    version: 1,
    kind: 'action',
    categories: ['Flow'],
    icon: 'lucide:book-open-check',
    color: '#f59e0b',
        keywords: ['runbook', 'playbook', 'incident', 'alert', 'landfall', 'triage'],
    inputs: main,
    outputs: main,
    properties: [
      {
        name: 'alertKind',
        displayName: 'Alert',
        type: 'string',
        default: '{{ $json.alert.labels?.alertname ?? $json.alert.title }}',
        required: true,
        description: 'The alert’s name: by default its alertname label, else its title, from Normalize Alert. Any title or kind slug works; an alert object is read the same way',
      },
      { name: 'baseUrl', displayName: 'Base URL', type: 'string', default: '', placeholder: 'https://flow.example.com', description: 'Put in front of the runbook links so they work in Slack and Landfall. Empty: links start with /workflows/' },
    ],
  },
  execute(ctx) {
    const base = String(ctx.getNodeParameter('baseUrl', 0, '') ?? '').trim().replace(/\/+$/, '');
    const out = ctx.getInputData().map((item, i) => {
      const alert = ctx.getNodeParameter<unknown>('alertKind', i);
      const alertKind = alertKindOf(alert) || alertKindSlug(String(alert ?? ''));
      const [best, ...others] = alertKind ? findRunbooks(alertKind) : [];
      if (!best) return { ...item, json: { ...item.json, alertKind, runbook: null, runbookFound: false } };
      const runbook: JsonObject = {
        id: best.id,
        name: best.name,
        alertKind: best.alertKind,
        match: best.match,
        published: best.published,
        approvals: best.approvals,
        url: `${base}${best.url}`,
        // POST { input: { alert } } to start a run in the background (a signed-in member or an API key with run rights).
        startUrl: `${base}/api/workflows/${best.id}/execute`,
      };
      const line = `Runbook for this kind of alert: ${best.name}${best.published ? '' : ' (draft, not published yet)'} — ${runbook.url}`;
      return { ...item, json: { ...item.json, alertKind, runbook, runbookFound: true, runbookLine: line, otherRunbooks: others.map((r) => ({ id: r.id, name: r.name, url: `${base}${r.url}` })) } };
    });
    return [out];
  },
});
