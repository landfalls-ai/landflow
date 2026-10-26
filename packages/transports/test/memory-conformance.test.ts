/**
 * The conformance suite against the in-memory driver, in several guises: the default broker, and simulated brokers
 * without headers (structured mode), with native replies, with a small message limit, that cannot report undeliverable
 * events, and with latency. Every real driver runs the same suite against its container (see src/driver.ts).
 */
import { runConformance } from '../src/conformance';
import { MemoryBroker, type MemoryBrokerOptions } from '../src/memory';

function target(name: string, options: MemoryBrokerOptions) {
  const broker = new MemoryBroker(options);
  return { name, driver: () => broker.driver(), config: { connectionId: 'mem-test' }, tap: (fn: Parameters<MemoryBroker['tap']>[0]) => broker.tap(fn) };
}

runConformance(target('memory (default)', {}));
runConformance(target('memory without headers (structured mode)', { capabilities: { headers: false } }));
runConformance(target('memory with native replies', { capabilities: { replies: 'native' } }));
runConformance(target('memory with a 64 KiB limit', { capabilities: { maxMessageBytes: 64 * 1024 } }));
runConformance(target('memory that cannot report undeliverable events', { capabilities: { undeliverable: 'unknown' } }));
runConformance(target('memory with 15 ms latency', { latencyMs: 15 }));
