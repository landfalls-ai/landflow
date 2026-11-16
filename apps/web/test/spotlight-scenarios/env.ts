/**
 * Imported first by ./harness.ts: this run's own data directory and a quiet host, before any server module reads them
 * (the suite's test files run in parallel and must not share one database).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LANDFLOW_DATA_DIR = mkdtempSync(join(tmpdir(), 'landflow-spotlight-scenarios-'));
process.env.LANDFLOW_REGISTRY_GRPC_PORT = 'off';
process.env.LANDFLOW_SCAN_ON_START = 'false';
process.env.LANDFLOW_PLUGINS = '';
