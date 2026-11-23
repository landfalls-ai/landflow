/**
 * Against the real Linear API. Skipped unless LANDFLOW_INTEGRATION contains `linear` and LINEAR_API_KEY is set (a
 * throwaway workspace's key): it only reads (viewer, users, issues changed in the last day).
 */
import { describe, expect, it } from 'vitest';
import { Linear } from '../src/nodes/linear';
import { jsonOf, run, testCredentials } from './helpers';

const live = (process.env.LANDFLOW_INTEGRATION ?? '').split(/[,\s]+/).includes('linear') && Boolean(process.env.LINEAR_API_KEY);
const credentials = () => ({ linearApi: { apiKey: process.env.LINEAR_API_KEY!, baseUrl: process.env.LINEAR_BASE_URL ?? 'https://api.linear.app' } });

describe.skipIf(!live)('Linear (live)', () => {
  it('authenticates', async () => {
    expect((await testCredentials('linearApi', credentials().linearApi)).ok).toBe(true);
  });
  it('lists users and recently changed issues', async () => {
    const users = jsonOf(await run(Linear, { authentication: 'apiKey', resource: 'user', operation: 'getAll', returnAll: false, limit: 5 }, { credentials: credentials() }));
    expect(users.length).toBeGreaterThan(0);
    const issues = await run(Linear, { authentication: 'apiKey', resource: 'issue', operation: 'getManySince', since: '', returnAll: false, limit: 5 }, { credentials: credentials() });
    expect(issues.error).toBeUndefined();
  });
});
