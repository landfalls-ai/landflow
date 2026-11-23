// placeholder until C36-A merges: C36-A (`outside-identity`) owns this module; only the signatures C36-B codes against are here.
/** An outside requester: a person without a Landflow account, proven by an email link or Google sign-in. `id` is `ext_…`. */
export type OutsideRequester = { id: string; email: string; name: string | null; verifiedBy: 'link' | 'google'; blocked: boolean };

export const getOutsideRequester = (_id: string): OutsideRequester | undefined => undefined;
export const outsideRequesterByEmail = (_email: string): OutsideRequester | undefined => undefined;
