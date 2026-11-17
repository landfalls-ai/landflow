import { describe, expect, it, vi } from 'vitest';
import { AcknowledgeAlert } from '../src/nodes/acknowledge-alert';
import { GetAlertDetails } from '../src/nodes/get-alert-details';
import { GetAlerts } from '../src/nodes/get-alerts';

// AG03: the host sends a credential only for a slot the descriptor declares.
describe('the Grafana nodes declare their credential', () => {
  const nodes = [new GetAlerts(), new GetAlertDetails(), new AcknowledgeAlert()];

  it('each requires grafana_alertmanager_api_token', () => {
    for (const node of nodes) expect(node.description.credentials).toEqual([{ name: 'grafana_alertmanager_api_token', required: true }]);
  });

  it('reads are idempotent, the silence is a write', () => {
    expect(nodes.map((n) => n.description.idempotent)).toEqual([true, true, false]);
  });

  it('a URL with a trailing slash calls …/api/v2/alerts once', async () => {
    const http = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK', json: async () => [] });
    await new GetAlerts().execute({
      getInputData: () => [{ json: {} }],
      getCredentials: () => ({ url: 'http://127.0.0.1:53163/api/alertmanager/grafana/', token: 't' }),
      http,
      getNodeParameter: vi.fn(),
    } as never);
    expect(http).toHaveBeenCalledTimes(1);
    expect(http.mock.calls[0][0]).toBe('http://127.0.0.1:53163/api/alertmanager/grafana/api/v2/alerts?active=true&silenced=false&inhibited=false');
  });
});
