/**
 * Imported first by ./harness.ts: this run's own data directory and a quiet host, before any server module reads them
 * (the suite's test files run in parallel and must not share one database).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// No exit handler removes the directory: the host flushes insights.json in its own exit handler, which runs after ours
// would have, and an ENOENT there ends the run non-zero. Stale directories of earlier runs go at the next import instead.
const prefix = 'landflow-spotlight-scenarios-';
/** Whether the process that made this directory (its `pid` file) still runs: a long run's directory is not stale. */
function alive(path: string): boolean {
  try {
    process.kill(Number(readFileSync(join(path, 'pid'), 'utf8')), 0);
    return true;
  } catch (caught) {
    return (caught as NodeJS.ErrnoException).code === 'EPERM'; // no pid file or no such process: nobody is using it
  }
}
for (const name of readdirSync(tmpdir())) {
  if (!name.startsWith(prefix)) continue;
  try {
    const path = join(tmpdir(), name);
    if (Date.now() - statSync(path).mtimeMs > 60 * 60 * 1000 && !alive(path)) rmSync(path, { recursive: true, force: true });
  } catch {
    /* another run removed it first */
  }
}
const dataDir = mkdtempSync(join(tmpdir(), prefix));
writeFileSync(join(dataDir, 'pid'), String(process.pid));
process.env.LANDFLOW_DATA_DIR = dataDir;
process.env.LANDFLOW_REGISTRY_GRPC_PORT = 'off';
process.env.LANDFLOW_SCAN_ON_START = 'false';
process.env.LANDFLOW_PLUGINS = '';
