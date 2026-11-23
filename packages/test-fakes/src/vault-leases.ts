/**
 * An OpenBao / Vault stand-in that issues leased credentials (the database engine's `creds` endpoint): every read of
 * `<mount>creds/<role>` makes a new user with its own password and lease, `sys/leases/renew` extends a lease and
 * `sys/leases/revoke` ends it. `state()` lists what was issued and what was revoked, so a test can check that a run's
 * user is gone after it. `failNext('revoke', n)` fails the next n revokes (a store that is up but refusing), `down()` and
 * `up()` make every call fail (a store that is away), for the revoke-with-retry cases. Accepts the token in `x-vault-token`;
 * the token login (`auth/token/lookup-self`) answers like a root token. Test-only; node built-ins only.
 */
import { defineFake, type FakeReply, type FakeRequest } from './harness';

export const VAULT_LEASES_TOKEN = 'leases-root-token-0123456789';

export interface IssuedLease {
  leaseId: string;
  mount: string;
  role: string;
  username: string;
  password: string;
  /** Seconds the first lease lasted, and the lease's current length after renewals. */
  leaseSeconds: number;
  renewals: number;
  /** Increments sent with renew calls. */
  increments: number[];
  issuedAt: number;
}

export interface VaultLeasesState {
  /** Leases that have not been revoked, by lease id. */
  active: Record<string, IssuedLease>;
  /** Lease ids revoked, in order. */
  revoked: string[];
  /** Everything issued, in order (revoked ones too). */
  issued: IssuedLease[];
  /** Revoke calls that failed (scripted or down). */
  failedRevokes: number;
  /** Every call fails with 503 while true. */
  down: boolean;
  /** The next n revoke calls answer 500. */
  failRevokes: number;
}

export interface VaultLeasesOptions {
  /** Dynamic mounts (with a trailing slash); default `database/`. */
  mounts?: string[];
  /** The lease length a role gives (seconds, default 900) and the longest a renewal can reach (default 3600). */
  defaultTtl?: number;
  maxTtl?: number;
}

export function fakeVaultLeases(options: VaultLeasesOptions = {}) {
  const mounts = options.mounts ?? ['database/'];
  const defaultTtl = options.defaultTtl ?? 900;
  const maxTtl = options.maxTtl ?? 3600;
  let live: VaultLeasesState;
  let counter = 0;
  const fresh = (): VaultLeasesState => {
    live = { active: {}, revoked: [], issued: [], failedRevokes: 0, down: false, failRevokes: 0 };
    return live;
  };

  const error = (status: number, ...messages: string[]): FakeReply => ({ status, body: { errors: messages } });

  const fake = defineFake<VaultLeasesState>({
    name: 'vault-leases',
    token: VAULT_LEASES_TOKEN,
    auth: (request: FakeRequest, token) => request.headers['x-vault-token'] === token,
    refusal: () => error(403, 'permission denied'),
    initial: fresh,
    routes: (state, request): FakeReply => {
      if (state.down) {
        if (request.path === '/v1/sys/leases/revoke') state.failedRevokes += 1;
        return error(503, 'Vault is sealed');
      }
      const path = request.path.replace(/^\/v1\//, '');
      if (path === 'auth/token/lookup-self') return { body: { data: { ttl: 0, renewable: false } } };
      const mount = mounts.find((m) => path.startsWith(m));
      const creds = mount && /^creds\/([^/]+)$/.exec(path.slice(mount.length));
      if (request.method === 'GET' && mount && creds) {
        const role = creds[1];
        if (role === 'missing') return error(400, `role "${role}" not found`);
        counter += 1;
        const leaseId = `${mount}creds/${role}/lease${String(counter).padStart(6, '0')}`;
        const issued: IssuedLease = {
          leaseId,
          mount,
          role,
          username: `v-token-${role}-${counter}x${Math.random().toString(36).slice(2, 8)}`,
          password: `Pw-${counter}-${Math.random().toString(36).slice(2, 12)}-${Math.random().toString(36).slice(2, 12)}`,
          leaseSeconds: defaultTtl,
          renewals: 0,
          increments: [],
          issuedAt: Date.now(),
        };
        state.active[leaseId] = issued;
        state.issued.push(issued);
        return { body: { lease_id: leaseId, lease_duration: defaultTtl, renewable: true, data: { username: issued.username, password: issued.password } } };
      }
      if (request.method === 'PUT' && path === 'sys/leases/renew') {
        const { lease_id: leaseId, increment } = (request.body ?? {}) as { lease_id?: string; increment?: number };
        const lease = leaseId ? state.active[leaseId] : undefined;
        if (!lease) return error(400, 'lease not found');
        const seconds = Math.min(Number(increment) || defaultTtl, maxTtl);
        lease.renewals += 1;
        lease.increments.push(Number(increment) || 0);
        lease.leaseSeconds = seconds;
        return { body: { lease_id: leaseId, lease_duration: seconds, renewable: true } };
      }
      if (request.method === 'PUT' && path === 'sys/leases/revoke') {
        if (state.failRevokes > 0) {
          state.failRevokes -= 1;
          state.failedRevokes += 1;
          return error(500, 'internal error');
        }
        const { lease_id: leaseId } = (request.body ?? {}) as { lease_id?: string };
        if (!leaseId || !state.active[leaseId]) return error(400, 'lease not found');
        delete state.active[leaseId];
        state.revoked.push(leaseId);
        return { status: 204, body: undefined };
      }
      return error(404, 'unsupported path');
    },
  });

  return {
    ...fake,
    // The wrapped fake's getters (`url`) must stay live: spread would copy their current value.
    get url() {
      return fake.url;
    },
    /** The next `times` revoke calls fail with 500. */
    failNext(kind: 'revoke', times = 1) {
      if (kind === 'revoke') live.failRevokes += times;
    },
    /** Every call fails with 503 until `up()`. */
    down() {
      live.down = true;
    },
    up() {
      live.down = false;
    },
    /** A copy of what the fake holds (the issued passwords included: a test compares them with what a run leaked). */
    state: () => structuredClone(live),
  };
}

export type FakeVaultLeases = ReturnType<typeof fakeVaultLeases>;
