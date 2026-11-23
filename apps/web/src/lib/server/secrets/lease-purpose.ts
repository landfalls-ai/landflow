/** What a leased secret's sealed strings are bound to: its own row, so one row's values can't be copied into another's (C30). */
export const leaseValuesPurpose = (rowId: string) => `secrets.lease:${rowId}`;
export const leaseIdPurpose = (rowId: string) => `secrets.lease.id:${rowId}`;
