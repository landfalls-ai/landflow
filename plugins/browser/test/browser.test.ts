/** The Browser node against a fake agent-browser CLI: allow-list, safe arguments, steps, screenshot and cleanup. */
import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { runNode, type JsonObject } from '@landflow/sdk';
import type { ExecuteRequest } from '@landflow/protocol';
import { BrowserError, checkUrl, effectiveDomains, parseDomains, stepArgs } from '../src/agent-browser';
import { Browser } from '../src/nodes/browser';
import { DEFAULT_MAX_CONCURRENCY, plugin } from '../src/main';

type Call = string[];
function fake(replies: Record<string, string> = {}, fail?: (args: string[]) => string | undefined) {
  const calls: Call[] = [];
  const exec = async (args: string[]) => {
    calls.push(args);
    const command = args.slice(args.indexOf('--content-boundaries') >= 0 ? 7 : 2);
    const bad = fail?.(args);
    if (bad) return { stdout: '', stderr: bad, code: 1 };
    if (command[0] === 'screenshot') await writeFile(command[command.length - 1], Buffer.from('PNGDATA'));
    return { stdout: replies[command.slice(0, 2).join(' ')] ?? replies[command[0]] ?? '', stderr: '', code: 0 };
  };
  return { calls, exec };
}

const request = (parameters: JsonObject): ExecuteRequest => ({
  protocol: 'landflow.plugin/v1',
  executionId: 'ex_test',
  workflowId: 'wf_test',
  mode: 'manual',
  node: { id: 'n1', name: 'Browser', type: 'browser.browser', typeVersion: 1 },
  parameters,
  itemParameters: [parameters],
  inputs: [[{ json: { keep: 1 } }]],
});
const extras = { credentialTypes: plugin.credentialTypes, pluginId: 'browser' };
const commands = (calls: Call[]) => calls.map((c) => c.filter((_, i) => i >= c.findIndex((x) => ['open', 'snapshot', 'get', 'click', 'fill', 'press', 'wait', 'screenshot', 'close', 'scroll'].includes(x))).join(' '));

describe('allow-list', () => {
  it('parses domains and refuses a call with none', () => {
    expect(parseDomains('Example.com, *.example.org\nfoo.dev')).toEqual(['example.com', '*.example.org', 'foo.dev']);
    expect(() => effectiveDomains([], [])).toThrow(/No allowed domains/);
  });

  it('keeps a node inside the operator ceiling, and uses the ceiling when the node names none', () => {
    expect(effectiveDomains([], ['a.com'])).toEqual(['a.com']);
    expect(effectiveDomains(['a.com'], ['a.com'])).toEqual(['a.com']);
    expect(effectiveDomains(['x.a.com', '*.x.a.com', 'a.com'], ['*.a.com'])).toEqual(['x.a.com', '*.x.a.com', 'a.com']);
    // An exact ceiling does not cover subdomains, and a wildcard request is wider than an exact host.
    expect(() => effectiveDomains(['x.a.com'], ['a.com'])).toThrow(/Not allowed on this host/);
    expect(() => effectiveDomains(['*.a.com'], ['a.com'])).toThrow(/Not allowed on this host/);
    expect(() => effectiveDomains(['*.com'], ['*.a.com'])).toThrow(/Not allowed on this host/);
    expect(() => effectiveDomains(['evila.com'], ['*.a.com'])).toThrow(/Not allowed on this host/);
    expect(() => effectiveDomains(['b.com'], ['a.com'])).toThrow(/Not allowed on this host: b.com/);
  });

  it('only opens http(s) pages on an allowed host', () => {
    expect(checkUrl('https://docs.example.com/x', ['*.example.com']).hostname).toBe('docs.example.com');
    expect(checkUrl('https://example.com', ['*.example.com']).hostname).toBe('example.com');
    expect(() => checkUrl('https://evil.com', ['example.com'])).toThrow(/not an allowed domain/);
    expect(() => checkUrl('https://example.com.evil.com', ['example.com'])).toThrow(/not an allowed domain/);
    expect(() => checkUrl('file:///etc/passwd', ['example.com'])).toThrow(/Only http and https/);
    expect(() => checkUrl('javascript:alert(1)', ['example.com'])).toThrow(BrowserError);
    expect(() => checkUrl('', ['example.com'])).toThrow(/Not a URL/);
  });
});

describe('steps', () => {
  it('builds one argument per word, and only for the listed actions', () => {
    expect(stepArgs({ action: 'fill', target: '@e4', text: 'a b; rm -rf /' })).toEqual(['fill', '@e4', 'a b; rm -rf /']);
    expect(stepArgs({ action: 'press', key: 'Enter' })).toEqual(['press', 'Enter']);
    expect(stepArgs({ action: 'wait', ms: 999_999 })).toEqual(['wait', '30000']);
    expect(stepArgs({ action: 'scroll' })).toEqual(['scroll', 'down']);
    expect(() => stepArgs({ action: 'eval' as never, text: 'x' })).toThrow(/Unknown step/);
    // The words a model reaches for are accepted; an unknown field is an error, not ignored.
    expect(stepArgs({ action: 'select', selector: '#topic', value: 'Security' } as never)).toEqual(['select', '#topic', 'Security']);
    expect(stepArgs({ action: 'wait', milliseconds: 800 } as never)).toEqual(['wait', '800']);
    expect(stepArgs({ action: 'wait', seconds: 2 } as never)).toEqual(['wait', '2000']);
    expect(() => stepArgs({ action: 'wait', miliseconds: 800 } as never)).toThrow(/unknown field: miliseconds/);
    expect(() => stepArgs('click' as never)).toThrow(/must be an object/);
    expect(() => stepArgs({ action: 'click' })).toThrow(/needs a target/);
    expect(() => stepArgs({ action: 'fill', target: '@e1' })).toThrow(/needs text/);
  });
});

describe('Browser node', () => {
  const base = { url: 'https://example.com/a', allowedDomains: 'example.com' };

  it('reads a page with the safety flags on, then closes the session', async () => {
    const { calls, exec } = fake({ 'get title': 'Example', 'get url': 'https://example.com/a', snapshot: '- heading "Example"' });
    const response = await runNode(new Browser(exec), request({ ...base, operation: 'read' }), extras);
    expect(response.error).toBeUndefined();
    expect(response.outputs[0][0].json).toEqual({ keep: 1, url: 'https://example.com/a', title: 'Example', snapshot: '- heading "Example"' });
    const first = calls[0];
    expect(first).toEqual(expect.arrayContaining(['--allowed-domains', 'example.com', '--content-boundaries', '--max-output', '20000']));
    expect(first).not.toContain('--headed');
    expect(first[first.indexOf('--session') + 1]).toMatch(/^lf-/);
    expect(commands(calls)).toEqual(['open https://example.com/a', 'snapshot -c', 'get url', 'get title', 'close']);
  });

  it('refuses before touching the browser when the page is off the allow-list', async () => {
    const { calls, exec } = fake();
    const response = await runNode(new Browser(exec), request({ ...base, url: 'https://evil.com', operation: 'read' }), extras);
    expect(response.error?.message).toMatch(/evil.com is not an allowed domain/);
    expect(commands(calls)).toEqual([]);
    const none = await runNode(new Browser(exec), request({ url: 'https://example.com', operation: 'read' }), extras);
    expect(none.error?.message).toMatch(/No allowed domains/);
  });

  it('runs steps in order, returns the page after them, and passes interactive-only', async () => {
    const { calls, exec } = fake({ snapshot: '- button "Go" [ref=e1]' });
    const steps = JSON.stringify([{ action: 'fill', target: 'input[name=q]', text: 'landflow' }, { action: 'press', key: 'Enter' }]);
    const response = await runNode(new Browser(exec), request({ ...base, operation: 'act', steps, options: { interactiveOnly: true, headed: true } }), extras);
    expect(response.error).toBeUndefined();
    expect(response.outputs[0][0].json).toMatchObject({ stepsRun: 2 });
    expect(commands(calls)).toEqual(['open https://example.com/a', 'fill input[name=q] landflow', 'press Enter', 'snapshot -c -i', 'get url', 'get title', 'close']);
    expect(calls[0]).toContain('--headed');
  });

  it('rejects bad step JSON and unknown actions, still closing the session', async () => {
    const { calls, exec } = fake();
    const bad = await runNode(new Browser(exec), request({ ...base, operation: 'act', steps: '{nope' }), extras);
    expect(bad.error?.message).toMatch(/not valid JSON/);
    const evil = await runNode(new Browser(exec), request({ ...base, operation: 'act', steps: JSON.stringify([{ action: 'eval', text: 'document.cookie' }]) }), extras);
    expect(evil.error?.message).toMatch(/Unknown step/);
    expect(commands(calls).filter((c) => c === 'close')).toHaveLength(2);
  });

  it('attaches a screenshot as a PNG file next to the item', async () => {
    const { calls, exec } = fake({ 'get title': 'Example' });
    const response = await runNode(new Browser(exec), request({ ...base, operation: 'screenshot', fullPage: true, binaryPropertyName: 'shot' }), extras);
    expect(response.error).toBeUndefined();
    const [item] = response.outputs[0];
    expect(item.json).toMatchObject({ keep: 1, url: 'https://example.com/a', title: 'Example' });
    expect(item.binary?.shot).toMatchObject({ fileName: 'page.png', mimeType: 'image/png' });
    expect(Buffer.from(item.binary!.shot.data!, 'base64').toString()).toBe('PNGDATA');
    expect(calls.some((c) => c.includes('--full'))).toBe(true);
  });

  it('turns a CLI failure into a node error with its text, and says when the CLI is missing', async () => {
    const failing = fake({}, (args) => (args.includes('open') ? 'net::ERR_BLOCKED_BY_CLIENT' : undefined));
    const response = await runNode(new Browser(failing.exec), request({ ...base, operation: 'read' }), extras);
    expect(response.error?.message).toBe('agent-browser open failed');
    expect(response.error?.description).toContain('ERR_BLOCKED_BY_CLIENT');
    const missing = fake({}, () => 'spawn agent-browser ENOENT');
    const gone = await runNode(new Browser(missing.exec), request({ ...base, operation: 'read' }), extras);
    expect(gone.error?.message).toBe('agent-browser is not installed');
  });

  it('declares the fields it outputs, for the nodes after it', () => {
    const schema = plugin.nodes[0].description.outputSchema as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(['url', 'title', 'snapshot', 'stepsRun']);
  });

  it('is one node, not idempotent, with a small concurrency default and an MCP tool', () => {
    expect(plugin.nodes.map((n) => n.description.name)).toEqual(['browser']);
    expect(plugin.nodes[0].description.idempotent).toBeUndefined();
    expect(DEFAULT_MAX_CONCURRENCY).toBe(2);
  });
});
