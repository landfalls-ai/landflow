/**
 * The SCIM discovery endpoints (RFC 7644 §4): ServiceProviderConfig (PATCH and filters yes; bulk, sort, ETags and
 * password changes no; bearer tokens), ResourceTypes (User, Group) and Schemas (the attributes Landflow keeps).
 */
import { SCHEMAS } from './http';

export function serviceProviderConfig(base: string) {
  return {
    schemas: [SCHEMAS.serviceProviderConfig],
    documentationUri: 'https://github.com/landflow/landflow#scim-provisioning',
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 500 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'OAuth Bearer Token',
        description: 'A Landflow API key with the scim scope (Settings → Security → SCIM), sent as Authorization: Bearer lf_…',
        primary: true,
      },
    ],
    meta: { resourceType: 'ServiceProviderConfig', location: `${base}/ServiceProviderConfig` },
  };
}

const RESOURCE_TYPES = [
  { id: 'User', name: 'User', endpoint: '/Users', description: 'Landflow users', schema: SCHEMAS.user, schemaExtensions: [{ schema: SCHEMAS.enterpriseUser, required: false }] },
  { id: 'Group', name: 'Group', endpoint: '/Groups', description: 'Groups, mapped to project memberships or instance roles', schema: SCHEMAS.group },
];

export function resourceTypes(base: string) {
  return RESOURCE_TYPES.map((type) => ({ schemas: [SCHEMAS.resourceType], ...type, meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/${type.id}` } }));
}

type Attribute = {
  name: string;
  type: 'string' | 'boolean' | 'complex' | 'reference' | 'dateTime';
  multiValued: boolean;
  description: string;
  required: boolean;
  caseExact: boolean;
  mutability: 'readOnly' | 'readWrite' | 'immutable' | 'writeOnly';
  returned: 'always' | 'never' | 'default' | 'request';
  uniqueness: 'none' | 'server' | 'global';
  subAttributes?: Attribute[];
  referenceTypes?: string[];
};

const attr = (name: string, description: string, extra: Partial<Attribute> = {}): Attribute => ({
  name,
  type: 'string',
  multiValued: false,
  description,
  required: false,
  caseExact: false,
  mutability: 'readWrite',
  returned: 'default',
  uniqueness: 'none',
  ...extra,
});

const SCHEMA_DOCS = [
  {
    id: SCHEMAS.user,
    name: 'User',
    description: 'A Landflow user',
    attributes: [
      attr('userName', 'The user’s email address (unique)', { required: true, uniqueness: 'server' }),
      attr('name', 'The display name, as formatted or given and family name', {
        type: 'complex',
        subAttributes: [attr('formatted', 'Full name'), attr('givenName', 'Given name'), attr('familyName', 'Family name')],
      }),
      attr('displayName', 'The name shown in Landflow'),
      attr('emails', 'The email address (the same as userName)', { type: 'complex', multiValued: true, subAttributes: [attr('value', 'Address'), attr('type', 'work'), attr('primary', 'Primary', { type: 'boolean' })] }),
      attr('active', 'Whether the user can sign in (false signs them out)', { type: 'boolean' }),
      attr('groups', 'Groups the user is in', {
        type: 'complex',
        multiValued: true,
        mutability: 'readOnly',
        subAttributes: [attr('value', 'Group id', { mutability: 'readOnly' }), attr('display', 'Group name', { mutability: 'readOnly' })],
      }),
    ],
  },
  {
    id: SCHEMAS.group,
    name: 'Group',
    description: 'A group of users, mapped to project memberships or instance roles (LANDFLOW_SCIM_GROUP_MAP)',
    attributes: [
      attr('displayName', 'The group’s name (unique)', { required: true, uniqueness: 'server' }),
      attr('members', 'The users in the group', {
        type: 'complex',
        multiValued: true,
        subAttributes: [attr('value', 'User id', { mutability: 'immutable' }), attr('display', 'User name', { mutability: 'readOnly' })],
      }),
    ],
  },
];

export function schemas(base: string) {
  return SCHEMA_DOCS.map((schema) => ({ schemas: [SCHEMAS.schema], ...schema, meta: { resourceType: 'Schema', location: `${base}/Schemas/${schema.id}` } }));
}
