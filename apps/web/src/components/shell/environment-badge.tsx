'use client';
/**
 * The environment badge under the product mark (LANDFLOW_ENVIRONMENT): which environment this instance is, and a
 * lock when it is protected. Nothing without an environment.
 */
import Link from 'next/link';
import { Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useEnvironment } from '@/lib/client/environment';

/** Production red, staging amber, anything else the accent. */
const toneOf = (name: string) =>
  /^prod/i.test(name) ? 'border-rdbd bg-rddim text-rd' : /^(stag|uat|pre|qa|test)/i.test(name) ? 'border-warnbd bg-warndim text-warn' : 'border-acbd bg-acdim text-ac';

export function EnvironmentBadge() {
  const environment = useEnvironment();
  if (!environment?.name) return null;
  return (
    <Link
      href="/settings#environments"
      title={environment.protected ? `${environment.name}: protected, workflows are read-only here (they change by pull or promotion)` : `Environment: ${environment.name}`}
      className={cn('mx-2.5 mb-2 flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.06em]', toneOf(environment.name))}
      data-testid="environment-badge"
    >
      {environment.protected && <Lock className="size-3 shrink-0" strokeWidth={2} />}
      <span className="truncate">{environment.name}</span>
    </Link>
  );
}
