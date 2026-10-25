/**
 * SCIM 2.0 provisioning (RFC 7643/7644) for Okta, Entra ID and other identity providers, served at /scim/v2: Users
 * (./users), Groups (./groups, ./group-resources) mapped to project memberships and instance roles, filters
 * (./filter), pagination (./list) and discovery (./discovery). Authentication is a bearer API key with the `scim`
 * scope (./auth), created in Settings → Security.
 */
export * from './auth';
export * from './discovery';
export * from './filter';
export * from './group-resources';
export * from './groups';
export * from './http';
export * from './list';
export * from './users';
export * from './settings';
