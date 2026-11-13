/**
 * Re-seal every stored secret with the primary key of LANDFLOW_ENCRYPTION_KEYS, for a host that is stopped:
 * `pnpm --filter @landflow/web rotate-key` with the same environment (data directory, config store, database URL) as the
 * host. Idempotent. Exits 1 when some value could not be opened (keep its old key in the ring).
 */
import { recordAudit } from '../src/lib/server/audit';
import { rotateEncryption } from '../src/lib/server/credentials/rotate';

const result = rotateEncryption();
recordAudit({ action: 'encryption.rotate', target: { type: 'settings', id: 'encryption', name: 'Encryption key' }, details: { primary: result.primary, resealed: result.resealed, current: result.current, failed: result.failed.length, stores: result.stores, via: 'script' } });
console.log(`Primary key ${result.primary}: re-sealed ${result.resealed}, already current ${result.current}, failed ${result.failed.length}.`);
for (const [name, count] of Object.entries(result.stores)) console.log(`  ${name}: ${count}`);
for (const id of result.failed) console.error(`  could not open ${id}`);
if (result.failed.length) console.error('Do not remove an old key from LANDFLOW_ENCRYPTION_KEYS yet.');
process.exit(result.failed.length ? 1 : 0);
