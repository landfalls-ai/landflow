// placeholder until C36-A merges: C36-A owns the outside settings (key `access_outside`).
export type OutsideSettings = { enabled: boolean; domains: string[]; google: { enabled: boolean; credentialId?: string } };

export const outsideSettings = (): OutsideSettings => ({ enabled: false, domains: [], google: { enabled: false } });
export const domainAllowed = (email: string): boolean => outsideSettings().domains.includes(email.slice(email.lastIndexOf('@') + 1).toLowerCase());
