/**
 * Four-eyes publishing on the host (Settings → Governance): `workflows publish`, `unpublish`, `activate` and
 * `deactivate` don't publish but record a request, and the CLI says so with exit 8 and `approval_pending`, the
 * request in `details.request`. Once someone else approves, the workflow is published.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cliFor, startHost, web, type Host } from './host';

let host: Host;
let cli: ReturnType<typeof cliFor>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let governance: any;

const node = (id: string, name: string, type: string, parameters: Record<string, unknown> = {}) => ({ id, name, type, typeVersion: 1, position: [0, 0], parameters });

beforeAll(async () => {
  host = await startHost();
  cli = cliFor(host);
  governance = await web('lib/server/governance/policy');
  governance.updateGovernancePolicy({ fourEyes: { enabled: true, notifyEmail: false } });
});

afterAll(async () => {
  governance?.updateGovernancePolicy({ fourEyes: { enabled: false } });
  await host?.close();
});

describe('four-eyes publishing', () => {
  it('reports a pending approval with exit 8, then publishes once someone else approves', async () => {
    const store = (await web('lib/server/store')).store;
    const workflow = store.saveWorkflow({ id: 'wf_cli_approval', name: 'Needs approval', nodes: [node('start', 'Start', 'core.manualTrigger')], connections: [] });

    const published = await cli(['workflows', 'publish', workflow.id, '--note', 'ship it', '--json']);
    expect(published.code).toBe(8);
    expect(published.json).toEqual({
      ok: false,
      error: {
        code: 'approval_pending',
        message: expect.stringMatching(/^Publishing “Needs approval” needs approval: request pr_\S+ is waiting for another person/),
        status: 202,
        details: { workflowId: workflow.id, request: expect.objectContaining({ kind: 'publish', status: 'pending', note: 'ship it' }) },
      },
    });
    const human = await cli(['workflows', 'activate', workflow.id]);
    expect(human.code).toBe(8);
    expect(human.stderr).toMatch(/Activating “Needs approval” needs approval/);

    const { publishedVersionId } = await web('lib/server/publications');
    expect(publishedVersionId(workflow.id)).toBeUndefined();

    // Someone else approves: published.
    const approvals = await web('lib/server/governance/approvals');
    const users = await web('lib/server/auth/users');
    const approver = await users.createUser({ email: 'approver@cli.test', name: 'Approver', role: 'admin', password: 'approver-password-1' });
    const [pending] = approvals.listRequests({ workflowId: workflow.id });
    await approvals.approveRequest(pending.id, approver);
    expect(publishedVersionId(workflow.id)).toBe(pending.versionId);

    const unpublish = await cli(['workflows', 'unpublish', workflow.id, '--json']);
    expect(unpublish.code).toBe(8);
    expect(unpublish.json.error).toMatchObject({ code: 'approval_pending', details: { request: { kind: 'unpublish' } } });
  });
});
