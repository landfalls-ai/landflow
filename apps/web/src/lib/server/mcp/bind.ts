/**
 * Binding credentials for an MCP call or subscription (docs/transports.md "Credentials, permissions and audit"): for each
 * credential slot of a node, the grant's credential for that type, else the one the request's `_meta` names, else the
 * caller's newest credential of the type. Shared by tool calls (./plugin-servers.ts) and trigger subscriptions (./triggers.ts).
 */
import type { JsonObject, McpCredentialSelector } from '@landflow/protocol';
import type { Role } from '../../shared/auth';
import { credentials } from '../credentials/vault';
import { visibleIds } from '../projects/access';
import type { McpCaller } from './identity';

export const callerLabel = (caller: McpCaller) => `${caller.kind}:${caller.subject}`;

/** What of a tool's or trigger's binding the credential logic reads. */
export interface CredentialBinding {
  credentials: string[];
  credentialSelectors: McpCredentialSelector[];
}

/** A node's credential slot (`twilioApi`, `core.httpBearerAuth`) as the vault's fully qualified type. */
export function qualifyCredentialType(pluginId: string, name: string): string {
  return name.includes('.') ? name : `${pluginId}.${name}`;
}

export interface BoundCredentials {
  /** By the node's slot name, as the runner expects them. */
  credentials: Record<string, { id: string; name: string }>;
  /** Credential selector parameters (`authentication`) set for the bound type. */
  parameters: JsonObject;
  /** Why the call cannot run (a named credential the caller may not use, or of the wrong type). */
  error?: string;
}

/**
 * Bind credentials for a call: for each credential slot of the node, the grant's credential for that type, else the
 * one `_meta` names, else the caller's newest credential of that type. Only credentials the caller's projects may use
 * count (a grant's choice is trusted: it was made by an admin from the project's credentials). A slot without any
 * stays empty; the vault then fails the run only when the node requires it.
 */
export function bindCredentials(caller: McpCaller, pluginId: string, binding: CredentialBinding, granted: Record<string, string>, requested: Record<string, string> | undefined): BoundCredentials {
  const out: BoundCredentials = { credentials: {}, parameters: {} };
  if (!binding.credentials.length) return out;
  const all = credentials.list();
  const visible = caller.userId ? visibleIds({ id: caller.userId, role: (caller.role ?? 'member') as Role }, 'credential', all.map((c) => c.id)) : new Set<string>();
  const mayUse = (id: string) => !visible || visible.has(id);
  const who = callerLabel(caller);
  let selected = false;
  for (const slot of binding.credentials) {
    const type = qualifyCredentialType(pluginId, slot);
    const fromGrant = granted[type] ?? granted[slot];
    const wanted = fromGrant ?? requested?.[type] ?? requested?.[slot];
    let chosen: { id: string; name: string } | undefined;
    if (wanted) {
      const credential = all.find((c) => c.id === wanted);
      if (!credential) return { ...out, error: `Credential ${wanted} (for ${type}) does not exist` };
      if (credential.type !== type) return { ...out, error: `Credential "${credential.name}" is a ${credential.type}, not a ${type}` };
      if (!fromGrant && !mayUse(credential.id)) return { ...out, error: `Credential "${credential.name}" is not available to ${who}` };
      chosen = { id: credential.id, name: credential.name };
    } else {
      const candidate = all.filter((c) => c.type === type && mayUse(c.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (candidate) chosen = { id: candidate.id, name: candidate.name };
    }
    if (!chosen) continue;
    out.credentials[slot] = chosen;
    // The parameter that picks the auth method (`authentication: oAuth2`): set for the first slot that has a credential.
    if (!selected) {
      for (const selector of binding.credentialSelectors) {
        if (slot in selector.byCredential) {
          out.parameters[selector.parameter] = selector.byCredential[slot];
          selected = true;
        }
      }
    }
  }
  return out;
}

