/**
 * Readable labels for the people an agent has memories of (C09): the agent page's Person picker keeps user ids as option values
 * but shows a name (and the email only when two people share a name). Channel users (`slack:…`, `teams:…`, `telegram:…`) and
 * the old shared `you` get a plain label; an unknown id shows as is, so nothing disappears.
 */
export interface PersonName {
  id: string;
  name: string;
  email?: string;
}

const CHANNELS: Record<string, string> = { slack: 'Slack', teams: 'Microsoft Teams', telegram: 'Telegram' };

/** One label per id, in the order given. */
export function personLabels(ids: string[], users: PersonName[]): Record<string, string> {
  const byId = new Map(users.map((u) => [u.id, u]));
  const taken = new Map<string, number>();
  const nameOf = (id: string): string | undefined => byId.get(id)?.name;
  for (const id of ids) {
    const n = nameOf(id)?.toLowerCase();
    if (n) taken.set(n, (taken.get(n) ?? 0) + 1);
  }
  const out: Record<string, string> = {};
  for (const id of ids) {
    const user = byId.get(id);
    if (user) {
      const clash = (taken.get(user.name.toLowerCase()) ?? 0) > 1;
      out[id] = clash && user.email ? `${user.name} (${user.email})` : user.name;
      continue;
    }
    const [channel, ...rest] = id.split(':');
    if (id === 'you') out[id] = 'You (shared, before sign-in)';
    else if (rest.length && CHANNELS[channel]) out[id] = `${CHANNELS[channel]} user ${rest.join(':')}`;
    else out[id] = id;
  }
  return out;
}
