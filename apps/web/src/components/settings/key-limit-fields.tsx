'use client';
/**
 * The two limits a key or SCIM token gets at creation, fixed afterwards: the addresses it may be used from and a use cap.
 * One component for Settings → API keys and the SCIM card, so both check what is typed with the server's own rule
 * (shared/ip-entry.ts) and warn the same way when the caller's address can't be trusted (no LANDFLOW_TRUSTED_PROXIES).
 */
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { checkAllowList } from '@/lib/shared/ip-entry';
import { FieldLabel, Input, Textarea } from '@/components/ui/inputs';

/** The lines of the address box: one entry each; commas and spaces also separate them. */
export const entriesOf = (text: string) => text.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean);

/** The state behind the two fields, with the checks and the body fields to send. */
export function useKeyLimits() {
  const [addresses, setAddresses] = useState('');
  const [cap, setCap] = useState('');
  const list = entriesOf(addresses);
  const checked = list.length ? checkAllowList(list) : undefined;
  const problem = checked && !checked.ok ? checked.problem : undefined;
  const maxUses = cap.trim() === '' ? undefined : Number(cap);
  const capProblem = maxUses !== undefined && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1_000_000) ? 'Use a whole number from 1 to 1,000,000' : undefined;
  return {
    addresses,
    setAddresses,
    cap,
    setCap,
    problem,
    capProblem,
    invalid: Boolean(problem || capProblem),
    body: { ...(checked?.ok && { allowedIps: checked.entries }), ...(maxUses && !capProblem && { maxUses }) },
  };
}

export function KeyLimitFields({ limits, addressUnverified }: { limits: ReturnType<typeof useKeyLimits>; addressUnverified?: boolean }) {
  const { addresses, setAddresses, cap, setCap, problem, capProblem } = limits;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_200px]">
      <div>
        <FieldLabel>Only from these addresses (optional)</FieldLabel>
        <Textarea value={addresses} onChange={(e) => setAddresses(e.target.value)} rows={3} placeholder={'10.0.0.0/8\n203.0.113.7'} aria-label="Only from these addresses" aria-invalid={Boolean(problem)} className="font-mono text-[12px]" />
        <p className={cn('mt-1 text-[11px]', problem ? 'text-rd' : 'text-t3')}>{problem ?? 'One address or range (10.0.0.0/8) per line, up to 50. Leave empty to allow any address. Can’t be changed later.'}</p>
        {addressUnverified && addresses.trim() !== '' && (
          <p className="mt-1 text-[11px] text-warn" role="note">
            No reverse proxy count is set (LANDFLOW_TRUSTED_PROXIES), so a caller can write its own address and get around this list. Set it first for the list to protect the key.
          </p>
        )}
      </div>
      <div>
        <FieldLabel>Stop after (optional)</FieldLabel>
        <Input value={cap} onChange={(e) => setCap(e.target.value)} inputMode="numeric" placeholder="No limit" aria-label="Stop after this many uses" aria-invalid={Boolean(capProblem)} />
        <p className={cn('mt-1 text-[11px]', capProblem ? 'text-rd' : 'text-t3')}>{capProblem ?? 'Uses; the key is kept, marked “used up”.'}</p>
      </div>
    </div>
  );
}
