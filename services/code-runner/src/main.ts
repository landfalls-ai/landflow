/**
 * Landflow code runner: runs Code node snippets (JavaScript on Node, Python on CPython with the standard library
 * only), each in a fresh, locked-down child process.
 *
 *   CODE_RUNNER_SECRET=… pnpm --filter code-runner dev        # http://127.0.0.1:7300, OS limits only
 *   docker compose -p landflow -f deploy/compose.yml up -d code-runner   # the real boundary: see deploy/README.md
 *
 * Settings: config.ts (CODE_RUNNER_*). Isolation layers: isolation.ts.
 */
import { startCodeRunner, VERSION } from './server';
import { describeIsolation } from './isolation';

try {
  const runner = await startCodeRunner();
  const { config, isolation } = runner;
  const layers = Object.entries(describeIsolation(isolation, config))
    .map(([name, value]) => `${name}=${value}`)
    .join(' ');
  console.log(`[code-runner] ${VERSION} listening on http://${config.host}:${runner.server.address() && (runner.server.address() as { port: number }).port}`);
  console.log(`[code-runner] node ${isolation.node.version}, python ${isolation.python?.version ?? 'not available'}`);
  console.log(`[code-runner] limits: ${JSON.stringify(config.limits)}, concurrency ${config.concurrency} (+${config.maxQueue} queued)`);
  console.log(`[code-runner] isolation: ${layers}`);
  if (!isolation.osSandbox && !process.env.CODE_RUNNER_IN_CONTAINER) {
    console.warn('[code-runner] no OS sandbox here: snippets only get resource limits and in-process guards. Run the Docker image for real isolation.');
  }
  const shutdown = () => runner.close().then(() => process.exit(0));
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} catch (error) {
  console.error(`[code-runner] ${(error as Error).message}`);
  process.exit(1);
}
