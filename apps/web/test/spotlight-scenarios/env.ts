/**
 * Imported first by ./harness.ts: this run's own data directory and a quiet host, before any server module reads them
 * (the suite's test files run in parallel and must not share one database).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-spotlight-scenarios-'));
process.env.LANDFLOW_DATA_DIR = dataDir;
process.once('exit', () => rmSync(dataDir, { recursive: true, force: true }));
process.env.LANDFLOW_REGISTRY_GRPC_PORT = 'off';
process.env.LANDFLOW_SCAN_ON_START = 'false';
process.env.LANDFLOW_PLUGINS = '';
