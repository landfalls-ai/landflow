/** Settings → Security's SCIM card (GET /api/settings/security `scim`): the base URL, every SCIM token, the group map. */
import type { ScimSecurityView } from '../../shared/auth';
import { apiKeyUses } from '../auth/api-key-uses';
import { apiKeyView, listApiKeys } from '../auth/api-keys';
import { listUsers } from '../auth/users';
import { trustedProxies } from '../net/client-address';
import { countGroups, describeGroupMap } from './groups';
import { scimBaseUrl } from './http';

export async function scimSecurityView(request?: Request): Promise<ScimSecurityView> {
  const users = listUsers();
  const counts = await apiKeyUses(users.flatMap((user) => listApiKeys(user.id).filter((key) => key.scopes.includes('scim') && key.maxUses).map((key) => key.id)));
  return {
    baseUrl: scimBaseUrl(request),
    tokens: users.flatMap((user) =>
      listApiKeys(user.id)
        .filter((key) => key.scopes.includes('scim'))
        // The last address is personal data: its owner sees it (Settings → API keys), and the audit log; not this list of every admin's tokens.
        .map((key) => ({ ...apiKeyView({ ...key, lastUsedIp: undefined }, counts.get(key.id)), userName: user.name })),
    ),
    addressUnverified: trustedProxies() === 0,
    groupMap: describeGroupMap(),
    groups: countGroups(),
    provisionedUsers: users.filter((user) => user.provisionedBy === 'scim').length,
  };
}
