/** Triggers as MCP resources (docs/protocol.md §15.9): which nodes qualify, the URI template and URI helpers, and the query-to-parameter conversion. */
import { describe, expect, it } from 'vitest';
import {
  isMcpTriggerNode,
  mcpTriggersFromDescriptors,
  MCP_TOOL_META_KEY,
  parseTriggerResourceUri,
  triggerQueryToParameters,
  triggerResourceName,
  triggerResourceUri,
  type NodeDescriptor,
} from '../src';

const node = (patch: Partial<NodeDescriptor> & { name: string }): NodeDescriptor =>
  ({ displayName: patch.name, description: '', version: 1, kind: 'trigger', inputs: [], outputs: [{ type: 'main' }], properties: [], ...patch }) as NodeDescriptor;

const poll = node({
  name: 'newIssue',
  displayName: 'New Issue',
  description: 'Fires on new issues',
  triggerSource: 'poll',
  credentials: [{ name: 'tracker', required: true }],
  properties: [
    { name: 'pollInterval', displayName: 'Poll interval', type: 'number', default: 60 },
    { name: 'repo', displayName: 'Repo', type: 'string', default: '' },
    { name: 'limit', displayName: 'Limit', type: 'number', default: 10 },
    { name: 'closed', displayName: 'Closed', type: 'boolean', default: false },
    { name: 'labels', displayName: 'Labels', type: 'json', default: [] },
  ],
});
const hook = node({ name: 'pushed', triggerSource: 'appWebhook' });

describe('trigger resources', () => {
  it('offers poll and app-webhook triggers, not the others or opted-out ones', () => {
    expect(isMcpTriggerNode(poll)).toBe(true);
    expect(isMcpTriggerNode(hook)).toBe(true);
    expect(isMcpTriggerNode(node({ name: 'manual', triggerSource: 'manual' } as never))).toBe(false);
    expect(isMcpTriggerNode(node({ name: 'cron', triggerSource: 'schedule' } as never))).toBe(false);
    expect(isMcpTriggerNode(node({ name: 'tool', kind: 'action' } as never))).toBe(false);
    expect(isMcpTriggerNode({ ...poll, mcp: false })).toBe(false);
    expect(triggerResourceName(poll)).toBe('trigger_newIssue');
  });

  it('builds a template per trigger with the parameters as variables and the binding in _meta', () => {
    const [issue, pushed] = mcpTriggersFromDescriptors('tracker-plugin', [poll, hook, node({ name: 'manual', triggerSource: 'manual' } as never)]);
    expect(issue).toMatchObject({ name: 'trigger_newIssue', title: 'New Issue', mimeType: 'application/json' });
    expect(issue.uriTemplate).toMatch(/^landflow:\/\/triggers\/tracker-plugin\/trigger_newIssue\{\?[^}]+\}$/);
    for (const name of ['repo', 'limit', 'closed', 'labels']) expect(issue.uriTemplate).toContain(name);
    expect(issue._meta[MCP_TOOL_META_KEY]).toMatchObject({ pluginId: 'tracker-plugin', nodeName: 'newIssue', triggerSource: 'poll', credentials: ['tracker'], pollInterval: 60 });
    expect(pushed._meta[MCP_TOOL_META_KEY].triggerSource).toBe('appWebhook');
    expect(pushed.uriTemplate).toMatch(/trigger_pushed(\{\?.*\})?$/);
  });

  it('round-trips a URI with sorted, stringified parameters and rejects other URIs', () => {
    const uri = triggerResourceUri('tracker-plugin', 'trigger_newIssue', { repo: 'a/b c', limit: 5, labels: ['x', 'y'], skip: '', gone: undefined, none: null });
    expect(uri).toBe('landflow://triggers/tracker-plugin/trigger_newIssue?labels=%5B%22x%22%2C%22y%22%5D&limit=5&repo=a%2Fb+c');
    expect(triggerResourceUri('tracker-plugin', 'trigger_newIssue', { limit: 5, repo: 'a/b c', labels: ['x', 'y'] })).toBe(uri);
    expect(parseTriggerResourceUri(uri)).toEqual({ pluginId: 'tracker-plugin', name: 'trigger_newIssue', query: { labels: '["x","y"]', limit: '5', repo: 'a/b c' } });
    expect(parseTriggerResourceUri(triggerResourceUri('p', 'trigger_x'))).toEqual({ pluginId: 'p', name: 'trigger_x', query: {} });
    for (const bad of ['http://x/y', 'landflow://triggers/', 'landflow://triggers/only', 'landflow://triggers/a/b/c', 'landflow://triggers//b']) expect(parseTriggerResourceUri(bad)).toBeUndefined();
    expect(parseTriggerResourceUri('landflow://triggers/%E0%A4%A/x')).toBeUndefined();
  });

  it('converts a query by the schema types and reports what it could not', () => {
    const [issue] = mcpTriggersFromDescriptors('tracker-plugin', [poll]);
    const ok = triggerQueryToParameters(issue, { repo: 'a/b', limit: '5', closed: 'true', labels: '["x"]', extra: '1' });
    expect(ok).toEqual({ parameters: { repo: 'a/b', limit: 5, closed: true, labels: ['x'] }, ignored: ['extra'], errors: [] });
    const bad = triggerQueryToParameters(issue, { limit: 'many', closed: 'maybe', labels: '[' });
    expect(bad.parameters).toEqual({});
    expect(bad.errors.map((e) => e.split(':')[0]).sort()).toEqual(['closed', 'labels', 'limit']);
  });
});
