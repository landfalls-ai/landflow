/** `node dist/main.mjs`: a Landflow network runner (README). Settings come from the environment only. */
import { loadConfig, VERSION } from './config';
import { runLoop } from './poll';

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => controller.abort());
  log(`Landflow network runner ${VERSION} “${config.name}” polling ${config.url.origin}; ${config.allow.length ? `may reach ${config.allow.map((entry) => entry.text).join(', ')}` : 'the allow-list is empty: every call will be refused'}`);
  const end = await runLoop(config, controller.signal, log);
  process.exit(end === 'revoked' ? 3 : 0);
}

void main();
