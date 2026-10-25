import type { NodeDescriptor, PortDescriptor } from './types';

/** "go-crypto" + "hash" → "go-crypto.hash" */
export function qualifyType(pluginId: string, nodeName: string): string {
  return `${pluginId}.${nodeName}`;
}

/** "go-crypto.hash" → { pluginId: "go-crypto", nodeName: "hash" } */
export function splitType(type: string): { pluginId: string; nodeName: string } {
  const dot = type.indexOf('.');
  if (dot <= 0) throw new Error(`Invalid node type "${type}" (expected "<pluginId>.<nodeName>")`);
  return { pluginId: type.slice(0, dot), nodeName: type.slice(dot + 1) };
}

export function versionsOf(descriptor: Pick<NodeDescriptor, 'version'>): number[] {
  return Array.isArray(descriptor.version) ? descriptor.version : [descriptor.version];
}

export function defaultVersionOf(descriptor: Pick<NodeDescriptor, 'version' | 'defaultVersion'>): number {
  return descriptor.defaultVersion ?? Math.max(...versionsOf(descriptor));
}

export function mainPorts(ports: PortDescriptor[]): PortDescriptor[] {
  return ports.filter((port) => port.type === 'main');
}

/**
 * Ports with their handle index (the n-th port of its type, counted over all ports so hidden
 * ones keep their slot) and whether `parameters` show them (see PortDescriptor.displayOptions).
 */
export function indexedPorts(ports: PortDescriptor[], parameters: Record<string, unknown> = {}): Array<{ port: PortDescriptor; index: number; visible: boolean }> {
  const counters: Record<string, number> = {};
  return ports.map((port) => ({ port, index: (counters[port.type] = (counters[port.type] ?? -1) + 1), visible: isPropertyVisible(port, parameters) }));
}

/** The ports `parameters` show. */
export function visiblePorts(ports: PortDescriptor[], parameters: Record<string, unknown> = {}): PortDescriptor[] {
  return ports.filter((port) => isPropertyVisible(port, parameters));
}

/**
 * Parameter values that show `port`: the first allowed value of each `show` condition. Used when a node is
 * added from a sub-node slot (a vector store dropped on an agent's Tool slot switches to "As Tool").
 */
export function portParameters(port: PortDescriptor): Record<string, unknown> {
  return Object.fromEntries(Object.entries(port.displayOptions?.show ?? {}).flatMap(([key, values]) => (values.length ? [[key, values[0]]] : [])));
}

/** Initial parameter values for a fresh node, taken from property defaults. */
export function defaultParameters(descriptor: Pick<NodeDescriptor, 'properties'>): Record<string, unknown> {
  return withPropertyDefaults(descriptor.properties);
}

/**
 * `parameters` plus the default of every unset property that is visible for them. As in n8n, the first visible
 * property of a name supplies its default, so `operation` takes the default of the variant shown for the chosen
 * `resource`. Repeated until nothing changes, because a default can make another property visible.
 */
export function withPropertyDefaults(properties: NodeDescriptor['properties'], parameters: Record<string, unknown> = {}): Record<string, unknown> {
  const result = { ...parameters };
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const property of properties) {
      if (property.type === 'notice' || property.default === undefined || property.name in result) continue;
      if (!isPropertyVisible(property, result)) continue;
      result[property.name] = structuredClone(property.default);
      changed = true;
    }
    if (!changed) break;
  }
  return result;
}

/** n8n-style displayOptions evaluation against the node's current parameters. */
export function isPropertyVisible(
  property: { displayOptions?: { show?: Record<string, unknown[]>; hide?: Record<string, unknown[]> } },
  parameters: Record<string, unknown>,
): boolean {
  const { show, hide } = property.displayOptions ?? {};
  if (show) {
    for (const [key, allowed] of Object.entries(show)) {
      if (!allowed.includes(parameters[key] as never)) return false;
    }
  }
  if (hide) {
    for (const [key, blocked] of Object.entries(hide)) {
      if (blocked.includes(parameters[key] as never)) return false;
    }
  }
  return true;
}

/**
 * Sets one parameter the way n8n's editor does: a parameter whose visible property changes as a result (the
 * `operation` after switching `resource`, a field that becomes hidden) loses its value, then newly visible
 * properties get their defaults.
 */
export function changeParameter(properties: NodeDescriptor['properties'], values: Record<string, unknown>, name: string, value: unknown): Record<string, unknown> {
  const shown = (key: string, parameters: Record<string, unknown>) =>
    properties.find((p) => p.name === key && p.type !== 'notice' && isPropertyVisible(p, parameters));
  const next: Record<string, unknown> = { ...values, [name]: value };
  const names = new Set(properties.map((p) => p.name));
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (const key of names) {
      if (key === name || !(key in next) || shown(key, values) === shown(key, next)) continue;
      delete next[key];
      changed = true;
    }
    if (!changed) break;
  }
  return withPropertyDefaults(properties, next);
}
