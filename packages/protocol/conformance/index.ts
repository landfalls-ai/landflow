/**
 * Loader and types of the conformance kit (see README.md in this directory). Runners import this from
 * `@landflow/protocol/conformance`, read the suites and send each case over their binding.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JsonObject, NodeItem, PluginManifest } from '../src/types';
import type { McpToolDefinition } from '../src/mcp-tools';

export const CONFORMANCE_KIT = 'landflow.conformance/v1' as const;

/** The directory holding `fixtures/`, `manifests/` and `plugin-manifest.json`. */
export const conformanceDir = dirname(fileURLToPath(import.meta.url));

export type ConformanceFace = 'http' | 'grpc' | 'messaging' | 'mcp';
export type ConformanceMethod = 'execute' | 'loadOptions' | 'testCredentials' | 'health' | 'getManifest';
export type ConformanceOutcome = 'reply' | 'node-error' | 'transport-error' | 'no-reply';

/**
 * The error codes a binding reports for failures around the plugin (README: "Transport error codes"). The first eight
 * are the `lferror` codes of the messaging envelope (docs/protocol.md §14.6), so a messaging runner compares them
 * literally; the rest are failures the caller detects itself.
 */
export type TransportErrorCode =
  | 'expired'
  | 'cancelled'
  | 'too_large'
  | 'not_found'
  | 'bad_request'
  | 'internal'
  | 'unavailable'
  | 'manifest_mismatch'
  | 'unauthenticated'
  | 'unroutable'
  | 'no_consumers'
  | 'not_connected'
  | 'connection_lost';

export const TRANSPORT_ERROR_CODES: readonly TransportErrorCode[] = [
  'expired',
  'cancelled',
  'too_large',
  'not_found',
  'bad_request',
  'internal',
  'unavailable',
  'manifest_mismatch',
  'unauthenticated',
  'unroutable',
  'no_consumers',
  'not_connected',
  'connection_lost',
];

export type DeliveryMode = 'at-most-once' | 'at-least-once';

export interface ConformanceCall {
  method: ConformanceMethod;
  node?: string;
  parameters?: JsonObject;
  items?: NodeItem[];
  deadlineMs?: number;
  cancelAfterMs?: number;
  idempotencyKey?: string;
  repeat?: number;
  padBytes?: number;
  tamper?: 'signature' | 'ciphertext' | 'manifestHash';
  loadOptions?: { method: string };
  testCredentials?: { credentialType: string; data: JsonObject };
  credentials?: Record<string, JsonObject>;
}

export interface ConformanceExpectation {
  outcome: ConformanceOutcome | ConformanceOutcome[];
  code?: TransportErrorCode;
  outputs?: NodeItem[][];
  errorMessage?: string;
  ran?: boolean;
  signalAborted?: boolean;
  withinMs?: number;
  deliveryMode?: DeliveryMode;
  count?: number;
  note?: string;
}

export interface ConformanceCase {
  id: string;
  description: string;
  applies?: ConformanceFace[];
  call: ConformanceCall;
  expect: ConformanceExpectation;
}

export interface ConformanceSuite {
  kit: typeof CONFORMANCE_KIT;
  suite: string;
  description: string;
  applies?: ConformanceFace[];
  cases: ConformanceCase[];
}

/** The MCP tool-mapping suite has its own shape: a manifest and the tools it must produce. */
export interface McpToolsFixture {
  kit: typeof CONFORMANCE_KIT;
  suite: 'mcp-tools';
  description: string;
  cases: Array<{ id: string; description: string; manifest: PluginManifest; tools: McpToolDefinition[] }>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** The names of the behavioural suites (every `fixtures/*.json` except `mcp-tools`). */
export function listConformanceSuites(): string[] {
  return readdirSync(join(conformanceDir, 'fixtures'))
    .filter((file) => file.endsWith('.json') && file !== 'mcp-tools.json')
    .map((file) => file.slice(0, -'.json'.length))
    .sort();
}

export function loadConformanceSuite(name: string): ConformanceSuite {
  const suite = readJson<ConformanceSuite>(join(conformanceDir, 'fixtures', `${name}.json`));
  if (suite.kit !== CONFORMANCE_KIT) throw new Error(`${name}.json: unknown kit "${suite.kit}"`);
  return suite;
}

/** Every behavioural suite, optionally only the cases that apply to one face. */
export function loadConformanceSuites(face?: ConformanceFace): ConformanceSuite[] {
  return listConformanceSuites()
    .map((name) => loadConformanceSuite(name))
    .filter((suite) => !face || !suite.applies || suite.applies.includes(face))
    .map((suite) => (face ? { ...suite, cases: suite.cases.filter((c) => !c.applies || c.applies.includes(face)) } : suite));
}

export function loadMcpToolsFixture(): McpToolsFixture {
  return readJson<McpToolsFixture>(join(conformanceDir, 'fixtures', 'mcp-tools.json'));
}

/** The manifest of the conformance plugin every runner embeds (README: "The conformance plugin"). */
export function loadConformancePluginManifest(): PluginManifest {
  return readJson<PluginManifest>(join(conformanceDir, 'plugin-manifest.json'));
}

/** The synthetic manifests the MCP fixture is generated from, by file name. */
export function loadConformanceManifests(): Record<string, PluginManifest> {
  const dir = join(conformanceDir, 'manifests');
  return Object.fromEntries(
    readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((file) => [file.slice(0, -'.json'.length), readJson<PluginManifest>(join(dir, file))]),
  );
}

/** `ExecuteRequest` fields a runner derives from a case: the node ref, parameters (padded when asked) and items. */
export function conformanceExecuteInput(manifest: PluginManifest, call: ConformanceCall): { node: { id: string; name: string; type: string; typeVersion: number }; parameters: JsonObject; items: NodeItem[] } {
  if (call.method !== 'execute' || !call.node) throw new Error('conformanceExecuteInput: an execute case needs a node');
  const descriptor = manifest.nodes.find((n) => n.name === call.node);
  if (!descriptor) throw new Error(`conformance plugin has no node "${call.node}"`);
  const parameters: JsonObject = { ...(call.parameters ?? {}) };
  if (call.padBytes) parameters.message = String(parameters.message ?? '').padEnd(call.padBytes, 'x');
  const typeVersion = Array.isArray(descriptor.version) ? Math.max(...descriptor.version) : descriptor.version;
  return {
    node: { id: `n-${call.node}`, name: descriptor.displayName, type: `${manifest.plugin.id}.${descriptor.name}`, typeVersion },
    parameters,
    items: call.items ?? [{ json: {} }],
  };
}

/** Does a reply match `expect.outputs`? Each listed item's JSON must be a subset of the real item's JSON, branch by branch. */
export function outputsMatch(expected: NodeItem[][] | undefined, actual: NodeItem[][]): boolean {
  if (!expected) return true;
  if (expected.length !== actual.length) return false;
  return expected.every((branch, b) => branch.length === actual[b]?.length && branch.every((item, i) => isSubset(item.json, actual[b][i].json)));
}

function isSubset(part: unknown, whole: unknown): boolean {
  if (part === whole) return true;
  if (typeof part !== 'object' || part === null || typeof whole !== 'object' || whole === null) return false;
  if (Array.isArray(part)) return Array.isArray(whole) && part.length === whole.length && part.every((v, i) => isSubset(v, whole[i]));
  return Object.entries(part).every(([key, value]) => isSubset(value, (whole as Record<string, unknown>)[key]));
}
