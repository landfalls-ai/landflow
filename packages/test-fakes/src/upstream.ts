/**
 * An upstream that records the headers of every request and answers `200 { headers }` with them: what a credentialed API
 * looks like to the secret-routes check (docs/a2a.md, "Secret routes"). A sandbox sends `Authorization: x`, kagent's egress
 * gateway swaps in the real value, and `state().requests` shows which one arrived. It accepts every request (no token of
 * its own: the point is to see what was sent). The gateway's swap itself is only provable on a cluster.
 */
import { defineFake, type FakeRequest } from './harness';

export interface UpstreamRequest {
  method: string;
  path: string;
  /** Lower-cased names; a repeated header is joined with ", ". */
  headers: Record<string, string>;
}

export interface UpstreamState {
  requests: UpstreamRequest[];
}

const flat = (headers: FakeRequest['headers']): Record<string, string> => Object.fromEntries(Object.entries(headers).flatMap(([name, value]) => (value === undefined ? [] : [[name, Array.isArray(value) ? value.join(', ') : value]])));

export function fakeUpstream() {
  return defineFake<UpstreamState>({
    name: 'upstream',
    token: 'none',
    auth: () => true,
    initial: () => ({ requests: [] }),
    routes: (state, request) => {
      const headers = flat(request.headers);
      state.requests.push({ method: request.method, path: request.path, headers });
      return { status: 200, body: { headers } };
    },
  });
}
