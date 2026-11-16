/**
 * Imported first by ./harness.ts: this run's own data directory and a quiet host, before any server module reads them
 * (the suite's test files run in parallel and must not share one database).
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// No exit handler removes the directory: the host flushes insights.json in its own exit handler, which runs after ours
// would have, and an ENOENT there ends the run non-zero. Stale directories of earlier runs go at the next import instead.
const prefix = 'landflow-spotlight-scenarios-';
for (const name of readdirSync(tmpdir())) {
  if (!name.startsWith(prefix)) continue;
  try {
    const path = join(tmpdir(), name);
    if (Date.now() - statSync(path).mtimeMs > 60 * 60 * 1000) rmSync(path, { recursive: true, force: true });
  } catch {
    /* another run removed it first */
  }
}
const dataDir = mkdtempSync(join(tmpdir(), prefix));
process.env.LANDFLOW_DATA_DIR = dataDir;
process.env.LANDFLOW_REGISTRY_GRPC_PORT = 'off';
process.env.LANDFLOW_SCAN_ON_START = 'false';
process.env.LANDFLOW_PLUGINS = '';
