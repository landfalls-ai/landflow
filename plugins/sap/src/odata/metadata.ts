/**
 * `$metadata` (EDMX): entity sets, keys, properties, types and the `sap:` annotations. Parsed with a small tolerant reader (no XML
 * dependency): SAP's EDMX is regular, and anything it does not understand is ignored. The result is cached per credential identity,
 * service and edition (spec 1.4: large, so cached with a TTL, default one hour).
 */
export interface MetaProperty {
  name: string;
  type: string;
  nullable: boolean;
  maxLength?: number;
  /** `sap:creatable`, `sap:updatable`, `sap:filterable`: absent when the service does not say. */
  creatable?: boolean;
  updatable?: boolean;
  filterable?: boolean;
  /** `sap:display-format` (`Date` for a date-only `Edm.DateTime`). */
  displayFormat?: string;
}

export interface MetaEntityType {
  name: string;
  keys: string[];
  properties: MetaProperty[];
  navigation: string[];
}

export interface MetaEntitySet {
  name: string;
  entityType: string;
  creatable?: boolean;
  updatable?: boolean;
  deletable?: boolean;
}

export interface ServiceMetadata {
  entitySets: MetaEntitySet[];
  entityTypes: Record<string, MetaEntityType>;
}

const attributes = (tag: string): Record<string, string> => {
  const found: Record<string, string> = {};
  for (const match of tag.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) found[match[1]] = match[3] ?? match[4] ?? '';
  return found;
};
const flag = (value: string | undefined): boolean | undefined => (value === undefined ? undefined : value !== 'false');
const local = (name: string) => name.slice(name.lastIndexOf('.') + 1);

export function parseMetadata(xml: string): ServiceMetadata {
  const entityTypes: Record<string, MetaEntityType> = {};
  for (const match of xml.matchAll(/<EntityType\b([^>]*?)(\/>|>([\s\S]*?)<\/EntityType>)/g)) {
    const name = attributes(match[1]).Name;
    if (!name) continue;
    const body = match[3] ?? '';
    const keyBlock = /<Key\b[^>]*>([\s\S]*?)<\/Key>/.exec(body)?.[1] ?? '';
    const keys = [...keyBlock.matchAll(/<PropertyRef\b([^>]*?)\/?>/g)].map((m) => attributes(m[1]).Name).filter(Boolean);
    const properties: MetaProperty[] = [];
    for (const p of body.matchAll(/<Property\b([^>]*?)\/?>/g)) {
      const a = attributes(p[1]);
      if (!a.Name) continue;
      properties.push({
        name: a.Name,
        type: a.Type ?? 'Edm.String',
        nullable: a.Nullable !== 'false',
        ...(a.MaxLength && { maxLength: Number(a.MaxLength) }),
        ...(a['sap:creatable'] !== undefined && { creatable: flag(a['sap:creatable']) }),
        ...(a['sap:updatable'] !== undefined && { updatable: flag(a['sap:updatable']) }),
        ...(a['sap:filterable'] !== undefined && { filterable: flag(a['sap:filterable']) }),
        ...(a['sap:display-format'] && { displayFormat: a['sap:display-format'] }),
      });
    }
    const navigation = [...body.matchAll(/<NavigationProperty\b([^>]*?)\/?>/g)].map((m) => attributes(m[1]).Name).filter(Boolean);
    entityTypes[name] = { name, keys, properties, navigation };
  }
  const entitySets: MetaEntitySet[] = [];
  for (const match of xml.matchAll(/<EntitySet\b([^>]*?)\/?>/g)) {
    const a = attributes(match[1]);
    const type = a.EntityType ?? a.EntityTypeName;
    if (!a.Name || !type) continue;
    entitySets.push({
      name: a.Name,
      entityType: local(type),
      ...(a['sap:creatable'] !== undefined && { creatable: flag(a['sap:creatable']) }),
      ...(a['sap:updatable'] !== undefined && { updatable: flag(a['sap:updatable']) }),
      ...(a['sap:deletable'] !== undefined && { deletable: flag(a['sap:deletable']) }),
    });
  }
  return { entitySets, entityTypes };
}

export const entityTypeOf = (meta: ServiceMetadata, entitySet: string): MetaEntityType | undefined => {
  const set = meta.entitySets.find((s) => s.name === entitySet);
  return set ? meta.entityTypes[set.entityType] : undefined;
};

const DATE_NAME = /(change|modif|update|last)/i;
const DATE_TYPES = new Set(['Edm.DateTime', 'Edm.DateTimeOffset', 'Edm.Date']);

/** Properties of date or datetime type, the ones whose name suggests a change first. */
export function timestampProperties(type: MetaEntityType | undefined): MetaProperty[] {
  const dates = (type?.properties ?? []).filter((p) => DATE_TYPES.has(p.type));
  return [...dates.filter((p) => DATE_NAME.test(p.name)), ...dates.filter((p) => !DATE_NAME.test(p.name))];
}

/** A date-only property: a day, no time, so the poll widens its overlap to a day. */
export const isDateOnly = (p: MetaProperty | undefined, name: string): boolean =>
  p ? p.type === 'Edm.Date' || (p.type === 'Edm.DateTime' && p.displayFormat === 'Date') || (p.type === 'Edm.DateTime' && /Date$/.test(p.name) && !/DateTime$/.test(p.name)) : /Date$/.test(name) && !/DateTime$/.test(name);

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

interface Cached {
  at: number;
  meta: ServiceMetadata;
}
const cache = new Map<string, Cached>();
const MAX_ENTRIES = 64;

export const metadataTtlMs = () => {
  const seconds = Number(process.env.LANDFLOW_SAP_METADATA_TTL_SECONDS);
  return (Number.isFinite(seconds) && seconds >= 0 ? seconds : 3600) * 1000;
};

export function cachedMetadata(key: string, now = Date.now()): ServiceMetadata | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (now - hit.at > metadataTtlMs()) {
    cache.delete(key);
    return undefined;
  }
  return hit.meta;
}

export function storeMetadata(key: string, meta: ServiceMetadata, now = Date.now()) {
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: now, meta });
}

export const clearMetadataCache = () => cache.clear();
export const metadataCacheSize = () => cache.size;

/** Types of the key properties of an entity set, for `keyPredicate`. */
export function keyTypes(meta: ServiceMetadata | undefined, entitySet: string): Record<string, string> {
  const type = meta ? entityTypeOf(meta, entitySet) : undefined;
  return Object.fromEntries((type?.properties ?? []).filter((p) => type?.keys.includes(p.name)).map((p) => [p.name, p.type]));
}
