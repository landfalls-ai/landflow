/**
 * The Spotlight scenario suite's runner (docs/development.md "Spotlight scorecard"). Every `spotlight-scenarios/<owner>.ts`
 * is found with import.meta.glob: a package adds a file, never edits an index. The unit form (scripted model) always runs
 * and every check must hold; the live form (LANDFLOW_INTEGRATION=spotlight, Ollama at OLLAMA_URL) asks the local model
 * LANDFLOW_SPOTLIGHT_RUNS times and counts the checks into the scorecard.
 */
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';
import type { Outcome, Scenario } from './spotlight-scenarios/scenario';
import { ECHO_PORT, addPlugins, checkRunnerModel, liveEnabled, assertUnit, prepare, prepareLive, reportOf, runScenario, tables } from './spotlight-scenarios/harness';

const live = liveEnabled();
const MODEL = process.env.LANDFLOW_SPOTLIGHT_MODEL || 'qwen3-coder:30b';
const RUNS = Number(process.env.LANDFLOW_SPOTLIGHT_RUNS) || undefined;
const ONLY = (process.env.LANDFLOW_SPOTLIGHT_ONLY ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const REPORT = process.env.LANDFLOW_SPOTLIGHT_REPORT || join(tmpdir(), 'landflow-spotlight-scorecard.json');

/**
 * Nothing may leave this machine in the live form. Static imports are hoisted, so the harness and the server modules are
 * already loaded here, and a module that took `dns.lookup` by name before the guard keeps the unpatched one: the guard
 * must be on from the process's start (`NODE_OPTIONS=--require …/local-only.cjs`, the documented command). Fail fast.
 */
if (live && !(globalThis as Record<symbol, unknown>)[Symbol.for('landflow.localOnly')]) {
  throw new Error('Spotlight scorecard: the local-only guard is not loaded. Run with NODE_OPTIONS="--require $PWD/test/spotlight-scenarios/local-only.cjs" (docs/development.md, "Spotlight scorecard").');
}

/** Every scenario of every owner, in file order. */
function allScenarios(): Scenario[] {
  const files = import.meta.glob<{ default: Scenario[] }>('./spotlight-scenarios/sb*.ts', { eager: true });
  return Object.keys(files).sort().flatMap((path) => files[path].default);
}

const wanted = (s: Scenario) => !ONLY.length || ONLY.includes(s.id.toLowerCase()) || ONLY.includes(s.owner.toLowerCase());

const scenarios = allScenarios();
const ran: Array<{ scenario: Scenario; outcome: Outcome }> = [];
const skipped: Array<{ id: string; reason: string }> = scenarios.filter((s) => s.live?.skip).map((s) => ({ id: s.id, reason: s.live!.skip! }));
const startedAt = new Date().toISOString();
let echo: { port: number; log: string[]; close: () => Promise<void> } | undefined;

beforeAll(async () => {
  prepare({ live });
  if (!live) return;
  await checkRunnerModel(MODEL); // AG02: Ollama and the model for a local one, the provider's key in the environment for another
  await prepareLive();
  await addPlugins();
  // The stand-in for the outside world: the evaluation's echo server, on this machine only.
  const log: string[] = [];
  const port = Number(process.env.LANDFLOW_SPOTLIGHT_ECHO_PORT) || ECHO_PORT;
  const server = createServer((req, res) => {
    log.push(`127.0.0.1:${port} ${req.method} ${(req.url ?? '/').split('?')[0]}`);
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const unauthorized = (req.url ?? '').startsWith('/secure') && req.headers.authorization !== 'Bearer eval-token';
      // `?fail=NNN` answers with that status (SB03's scenarios describe a 404, 500 or 503 from the step's destination).
      const fail = Number(new URL(req.url ?? '/', 'http://x').searchParams.get('fail'));
      if (fail >= 400 && fail < 600) {
        res.writeHead(fail, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `status ${fail}` }));
        return;
      }
      res.writeHead(unauthorized ? 401 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(unauthorized ? { error: 'unauthorized' } : { ok: true, received: Buffer.concat(chunks).toString('utf8') }));
    });
  });
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(port, '127.0.0.1', resolve));
  echo = { port, log, close: () => new Promise((resolve) => server.close(() => resolve())) };
});

afterAll(async () => {
  if (!live) return;
  await echo?.close();
  // Nothing ran (Ollama or the model was missing): leave an earlier scorecard at the path alone.
  if (!ran.length) return;
  const report = reportOf(MODEL, startedAt, ran, skipped);
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${tables(report, scenarios)}\n\nSpotlight scorecard written to ${REPORT}\n`);
});

const JOBS = { build: 'Build', fix: 'Fix one step', agent: 'Agents' } as const;
for (const job of ['build', 'fix', 'agent'] as const) {
  describe(`Spotlight scenarios: ${JOBS[job]}`, () => {
    for (const scenario of scenarios.filter((s) => s.job === job)) {
      const runs = RUNS ?? scenario.live?.runs ?? 3;
      it.skipIf(!scenario.script)(`${scenario.id} (scripted)`, async () => {
        assertUnit(scenario, await runScenario(scenario, 'unit'));
      });
      it.skipIf(!live || !wanted(scenario) || Boolean(scenario.live?.skip))(
        `${scenario.id} (live ×${runs})`,
        async () => {
          for (let i = 0; i < runs; i++) {
            const outcome = await runScenario(scenario, 'live', { model: MODEL, ...(echo && { echo }) });
            ran.push({ scenario, outcome });
          }
          // Passes when every run finished: a reply's error and the checks are counted in the scorecard, not asserted.
        },
        15 * 60_000,
      );
    }
  });
}
