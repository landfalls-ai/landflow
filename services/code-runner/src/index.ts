/** The code runner as a library: start one in-process (tests, the host's test suite) and the wire types. */
export { startCodeRunner, VERSION, type CodeRunner } from './server';
export { loadConfig, DEFAULT_JS_BUILTINS, type RunnerConfig } from './config';
export { probeIsolation, describeIsolation, type Isolation } from './isolation';
export * from './protocol';
