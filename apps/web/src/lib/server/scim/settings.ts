/** Settings → Security's SCIM card (GET /api/settings/security `scim`): the base URL, every SCIM token, the group map. */
import type { ScimSecurityView } from '../../shared/auth';
import { apiKeyView, listApiKeys } from '../auth/api-keys';
import { listUsers } from '../auth/users';
import { countGroups, describeGroupMap } from './groups';
import { scimBaseUrl } from './http';

export function scimSecurityView(request?: Request): ScimSecurityView {
  const users = listUsers();
  return {
    baseUrl: scimBaseUrl(request),
    tokens: users.flatMap((user) =>
      listApiKeys(user.id)
        .filter((key) => key.scopes.includes('scim'))
        .map((key) => ({ ...apiKeyView(key), userName: user.name })),
    ),
    groupMap: describeGroupMap(),
    groups: countGroups(),
    provisionedUsers: users.filter((user) => user.provisionedBy === 'scim').length,
  };
}
