/** Serve the debug demo plugin: `tsx apps/web/test/fixtures/debug-demo-main.ts <port> <buggy|fixed>` (loopback only). */
import { startDemoPlugin, type DemoVariant } from './debug-demo-plugin';

const port = Number(process.argv[2] ?? 7391);
const variant = (process.argv[3] ?? 'fixed') as DemoVariant;
const plugin = await startDemoPlugin({ port, variant });
console.log(`debug demo plugin (${variant}) on ${plugin.url}`);
