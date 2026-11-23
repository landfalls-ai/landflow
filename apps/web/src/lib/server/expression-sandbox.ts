/**
 * Which sandbox `{{ }}` expressions run in, chosen once at start-up from the environment (the engine reads none):
 * LANDFLOW_EXPRESSION_SANDBOX = `realm` (default, node:vm) or `isolate` (isolated-vm: own heap, memory cap,
 * LANDFLOW_EXPRESSION_MEMORY_MB). Asking for `isolate` where isolated-vm cannot load refuses the boot in the production
 * profile and falls back to the realm, with a warning, in development; an unknown value does the same, because a
 * misspelt security setting must not quietly give the weaker backend.
 */
import { configureExpressionSandbox, DEFAULT_ISOLATE_MEMORY_MB, isolateUnavailable } from '@landflow/engine';
import { ConfigError, envInt, envString, profile } from './config';
import { logger } from './telemetry/logger';

export function configureExpressionSandboxFromEnv(): 'realm' | 'isolate' {
  const asked = (envString('LANDFLOW_EXPRESSION_SANDBOX') ?? 'realm').toLowerCase();
  if (asked !== 'realm' && asked !== 'isolate') {
    const message = `LANDFLOW_EXPRESSION_SANDBOX must be realm or isolate, not "${asked}"`;
    if (profile() === 'production') throw new ConfigError([message]);
    logger.warn(`${message}; using realm`);
    configureExpressionSandbox({ backend: 'realm' });
    return 'realm';
  }
  if (asked === 'realm') {
    configureExpressionSandbox({ backend: 'realm' });
    return 'realm';
  }
  const unavailable = isolateUnavailable();
  if (unavailable) {
    const message = `LANDFLOW_EXPRESSION_SANDBOX=isolate, but isolated-vm cannot load (${unavailable}). Install it and start with NODE_OPTIONS=--no-node-snapshot, or use realm.`;
    if (profile() === 'production') throw new ConfigError([message]);
    logger.warn(`${message} Using the realm.`);
    configureExpressionSandbox({ backend: 'realm' });
    return 'realm';
  }
  configureExpressionSandbox({ backend: 'isolate', memoryMb: envInt('LANDFLOW_EXPRESSION_MEMORY_MB', { fallback: DEFAULT_ISOLATE_MEMORY_MB, min: 8, max: 4096 }) });
  return 'isolate';
}
