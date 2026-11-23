/**
 * The tier reaches nothing beyond loopback, from the page and from the host process:
 *   - the page guard (fixtures.ts) fails a test whose page asked for another host (`test.fail()`: the failure is the pass);
 *   - the scratch host has every outside fetch sent to a proxy address that refuses (scratch-host.ts), so an HTTP Request
 *     node aimed at a TEST-NET address fails at once with a refused connection and never leaves the machine.
 */
import { expect, test } from './fixtures';

test.describe('the page guard', () => {
  test.fail(true, 'a page that leaves loopback must fail the test');
  test('fails a page that asks for another host', async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/login`, { waitUntil: 'domcontentloaded' });
    // A navigation (the page's own CSP would stop a script's fetch before the network): the guard aborts it and records it.
    await page.goto('http://outside.example.test/ping').catch(() => undefined);
  });
});

test('an outside fetch from the host process is refused, not sent', async ({ signedIn: page, baseURL }) => {
  const request = page.context().request;
  const headers = { origin: baseURL as string };
  const created = await request.post(`${baseURL}/api/workflows`, {
    headers,
    data: {
      name: 'Outside fetch',
      nodes: [
        { id: 't', name: 'Manual Trigger', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        { id: 'h', name: 'HTTP Request', type: 'core.httpRequest', typeVersion: 1, position: [220, 0], parameters: { method: 'GET', url: 'http://203.0.113.7/outside' } },
      ],
      connections: [{ id: 'e1', type: 'main', source: 't', sourceIndex: 0, target: 'h', targetIndex: 0 }],
    },
  });
  expect(created.status()).toBe(201);
  const { workflow } = (await created.json()) as { workflow: { id: string } };
  const stream = await (await request.post(`${baseURL}/api/workflows/${workflow.id}/run`, { headers, data: {} })).text();
  expect(stream).toContain('"type":"execution.finished"');
  expect(stream, 'the HTTP Request must not succeed').not.toMatch(/"type":"execution.finished"[^\n]*"status":"success"/);
  // Unproxied, a TEST-NET address hangs until a timeout; refused by the proxy address it fails within milliseconds.
  const finished = /"type":"execution.finished"[^\n]*"durationMs":(\d+)/.exec(stream) ?? /"durationMs":(\d+)[^\n]*"type":"execution.finished"/.exec(stream);
  expect(Number(finished?.[1]), 'it failed at once').toBeLessThan(2000);
  expect(stream).toContain('fetch failed');
});
