/**
 * What the audit log hears from the plugin registry beyond the UI's bus events: an endpoint joining a plugin that
 * already exists (the step that hands it decrypted credentials) and a version change. The registry emits, audit/index.ts
 * listens; this small module keeps the two from importing each other.
 */
import { singleton } from '../singleton';

export type RegistryAuditEvent =
  | { type: 'plugin.endpoint_added'; pluginId: string; endpoint: string; source: string; transport: string }
  | { type: 'plugin.updated'; pluginId: string; endpoint: string; from: string; to: string };

type Listener = (event: RegistryAuditEvent) => void;

const listeners = () => singleton('registry-audit-listeners', () => new Set<Listener>());

export const registryAudit = {
  emit: (event: RegistryAuditEvent) => {
    for (const listener of listeners()) listener(event);
  },
  subscribe: (listener: Listener) => {
    listeners().add(listener);
    return () => listeners().delete(listener);
  },
};
