/**
 * Credential types that extend others (`CredentialTypeDescriptor.extends`, n8n's `extends: ['oAuth2Api']`). The
 * registry passes every type it lists through `withExtends`, so the form, the defaults and the vault's validation
 * all see the merged properties, and OAuth2 types (core.oAuth2Api and its descendants) are flagged `oauth2`.
 */
import type { PropertyDescriptor } from '@landflow/protocol';
import { OAUTH2_CREDENTIAL } from '../../shared/oauth2';
import type { CredentialTypeInfo } from '../../shared/types';

const CORE = 'core';

/** A parent's qualified type: `plugin.name` as is; a local name is a type of the same plugin when it has one, else the core plugin's. */
export function qualifyParent(name: string, pluginId: string, known: { has(type: string): boolean }): string {
  if (name.includes('.')) return name;
  return known.has(`${pluginId}.${name}`) ? `${pluginId}.${name}` : `${CORE}.${name}`;
}

/** Parent properties first; a child property of the same name replaces the parent's in place; the child's others follow. */
export function mergeProperties(parent: PropertyDescriptor[], child: PropertyDescriptor[]): PropertyDescriptor[] {
  const replacements = new Map(child.map((property) => [property.name, property]));
  const inherited = new Set(parent.map((property) => property.name));
  return [...parent.map((property) => replacements.get(property.name) ?? property), ...child.filter((property) => !inherited.has(property.name))];
}

/**
 * The types with their parents' properties merged in (depth first, in `extends` order) and `extendsTypes` set.
 * Unknown parents (a plugin that is not registered) and cycles are skipped.
 */
export function withExtends(infos: CredentialTypeInfo[]): CredentialTypeInfo[] {
  const byType = new Map(infos.map((info) => [info.type, info]));
  const resolved = new Map<string, { properties: PropertyDescriptor[]; chain: string[] }>();

  const resolve = (info: CredentialTypeInfo, path: Set<string>): { properties: PropertyDescriptor[]; chain: string[] } => {
    const done = resolved.get(info.type);
    if (done) return done;
    let properties: PropertyDescriptor[] = [];
    const chain: string[] = [];
    for (const name of info.descriptor.extends ?? []) {
      const parent = byType.get(qualifyParent(name, info.pluginId, byType));
      if (!parent || parent.type === info.type || path.has(parent.type)) continue;
      const inherited = resolve(parent, new Set([...path, info.type]));
      properties = mergeProperties(properties, inherited.properties);
      chain.push(parent.type, ...inherited.chain);
    }
    const result = { properties: mergeProperties(properties, info.descriptor.properties), chain: [...new Set(chain)] };
    resolved.set(info.type, result);
    return result;
  };

  return infos.map((info) => {
    if (!info.descriptor.extends?.length) return info.type === OAUTH2_CREDENTIAL ? { ...info, oauth2: true } : info;
    const { properties, chain } = resolve(info, new Set());
    return {
      ...info,
      descriptor: { ...info.descriptor, properties },
      ...(chain.length > 0 && { extendsTypes: chain }),
      ...(chain.includes(OAUTH2_CREDENTIAL) && { oauth2: true }),
    };
  });
}
