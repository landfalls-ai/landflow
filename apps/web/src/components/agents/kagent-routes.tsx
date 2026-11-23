'use client';
/**
 * The kagent card's Secret routes (docs/a2a.md, "Secret routes"): which Landflow credential kagent's egress gateway sends, as
 * which header, to which hosts, for a Claude Code agent's sandbox. The sandbox sends a placeholder header and never holds the
 * value. Each route: a credential (Bearer Auth or Header Auth only), the hosts as chips, the header and prefix (filled in for
 * Bearer Auth). Problems are the server's rules (lib/shared/kagent-routes.ts) shown under the route as the person types; a
 * preview says what a deploy writes, with credential names and no value (the editor never has one).
 */
import { useState } from 'react';
import { KeyRound, Plus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CredentialCombobox } from '../credentials/credential-combobox';
import { Button } from '../ui/button';
import { CopyButton } from '../ui/copy-button';
import { Input } from '../ui/inputs';
import { PLACEHOLDER_EXAMPLE, PLACEHOLDER_HINT, ROUTE_CREDENTIAL_TYPES, ROUTE_LIMITS, ROUTE_TYPE_LABELS, draftProblem, routeDefaults, routesProblem, type KagentRouteDraft, type KagentSecretRoute } from '@/lib/shared/kagent-routes';
import type { CredentialSummary } from '@/lib/shared/types';

/** The credentials a route can use: the two types that hold one static header value. */
export const routeCredentials = (credentials: CredentialSummary[]) => credentials.filter((c) => (ROUTE_CREDENTIAL_TYPES as readonly string[]).includes(c.type));

/** What a deploy writes for these routes, as lines of text: credential names, never a value. */
export function routePreview(name: string, routes: KagentRouteDraft[]): string[] {
  const ready = routes.filter((r) => r.credential && r.hosts.length);
  if (!ready.length) return [];
  const target = `${name}-routes`;
  return [
    `Secret ${target}: ${ready.map((r, i) => `r${i} ← ${r.credential!.name}`).join(', ')} (the values stay in the vault and in this Secret)`,
    `EgressPolicy ${target}:`,
    ...ready.flatMap((r) => r.hosts.map((host) => `  ${host} → ${r.header ?? `<${r.credential!.name}’s header>`}: ${r.prefix ?? ''}<${r.credential!.name}>`)),
  ];
}

/** A prefix's spaces made visible (the trailing one in `Bearer ` is what separates it from the value). */
const visibleSpaces = (text: string) => text.replace(/ /g, '␠');

function HostChips({ index, hosts, onChange }: { index: number; hosts: string[]; onChange: (hosts: string[]) => void }) {
  const [text, setText] = useState('');
  const add = () => {
    const next = text
      .split(/[\s,]+/)
      .map((h) => h.trim())
      .filter((h) => h && !hosts.includes(h));
    if (next.length) onChange([...hosts, ...next]);
    setText('');
  };
  return (
    <div className="space-y-1.5">
      {hosts.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {hosts.map((host) => (
            <span key={host} className="inline-flex max-w-full items-center gap-1 rounded-md border border-hair bg-wl px-1.5 py-0.5 font-mono text-[11px] text-t1">
              <span className="truncate">{host}</span>
              <button type="button" aria-label={`Remove ${host}`} className="text-t3 hover:text-t1" onClick={() => onChange(hosts.filter((h) => h !== host))}>
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <Input
        aria-label={`Add a host to route ${index + 1}`}
        value={text}
        placeholder="https://api.example.com, then Enter"
        disabled={hosts.length >= ROUTE_LIMITS.hostsPerRoute}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
      />
    </div>
  );
}

export function KagentRoutes({
  name,
  routes,
  onChange,
  credentials,
  onCreate,
  disabled,
  broken,
}: {
  /** The agent's name in kagent: the preview names the objects after it. */
  name: string;
  routes: KagentRouteDraft[];
  onChange: (routes: KagentRouteDraft[]) => void;
  credentials: CredentialSummary[];
  /** Opens the credential dialog for a Bearer Auth or Header Auth credential, with the typed name and the route it is for. */
  onCreate: (name: string, index: number) => void;
  disabled?: boolean;
  /** Why a deployed route can't be sent now, by route index (the status's). */
  broken?: Array<string | undefined>;
}) {
  const usable = routeCredentials(credentials);
  const set = (index: number, patch: Partial<KagentRouteDraft>) => onChange(routes.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const listProblem = routes.every((r, i) => !draftProblem(r, i)) ? routesProblem(routes as KagentSecretRoute[]) : undefined;
  const preview = routePreview(name, routes);
  return (
    <div className="space-y-2.5">
      <p className="text-[12px] text-t3">
        {PLACEHOLDER_HINT} Only Bearer Auth and Header Auth credentials work: they hold one header value.
      </p>
      <div className="flex min-w-0 items-center gap-1 text-[12px] text-t2">
        <code className="min-w-0 truncate rounded border border-hair bg-wl px-1.5 py-0.5 font-mono text-[11px]">{PLACEHOLDER_EXAMPLE}</code>
        <CopyButton text={PLACEHOLDER_EXAMPLE} label="Copy the example" />
      </div>
      {routes.map((route, index) => {
        const problem = draftProblem(route, index);
        const shown = route.credential && !usable.some((c) => c.id === route.credential!.id) ? [...usable, { id: route.credential.id, name: route.credential.name, type: ROUTE_CREDENTIAL_TYPES[0], createdAt: '', updatedAt: '', usedBy: [] } as CredentialSummary] : usable;
        return (
          <div key={index} className="space-y-2 rounded-[10px] border border-hair bg-wl/40 p-2.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <CredentialCombobox
                  id={`kagent-route-${index}-credential`}
                  label={`Credential for route ${index + 1}`}
                  credentials={shown}
                  value={route.credential?.id}
                  disabled={disabled}
                  groupBy={(c) => ROUTE_TYPE_LABELS[c.type]}
                  onCreate={(typed) => onCreate(typed, index)}
                  onPick={(picked) => {
                    const defaults = routeDefaults(picked.type);
                    set(index, { credential: { id: picked.id, name: picked.name }, header: defaults.header, prefix: defaults.prefix || undefined });
                  }}
                />
              </div>
              <Button size="icon-sm" variant="ghost" aria-label={`Remove route ${index + 1}`} title="Remove this route" disabled={disabled} onClick={() => onChange(routes.filter((_, i) => i !== index))}>
                <X className="size-3.5" />
              </Button>
            </div>
            <HostChips index={index} hosts={route.hosts} onChange={(hosts) => set(index, { hosts })} />
            <div className="grid gap-2 sm:grid-cols-2">
              <Input aria-label={`Header for route ${index + 1}`} value={route.header ?? ''} placeholder="Header (the credential’s own, for Header Auth)" disabled={disabled} onChange={(e) => set(index, { header: e.target.value || undefined })} />
              <Input aria-label={`Prefix for route ${index + 1}`} value={route.prefix ?? ''} placeholder="Prefix, e.g. “Bearer ”" disabled={disabled} onChange={(e) => set(index, { prefix: e.target.value || undefined })} />
            </div>
            {route.credential && route.header && (
              <p className="break-all font-mono text-[11px] text-t3" title="A trailing space in the prefix is shown as ␠">
                Sent as {route.header}: {visibleSpaces(route.prefix ?? '')}&lt;{route.credential.name}&gt;
              </p>
            )}
            {problem && route.credential && (
              <p role="alert" className="text-[12px] text-rd">
                {problem}
              </p>
            )}
            {broken?.[index] && <p className="text-[12px] text-warn">Not sent now: {broken[index]}</p>}
          </div>
        );
      })}
      {listProblem && (
        <p role="alert" className="text-[12px] text-rd">
          {listProblem}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button size="sm" variant="outline" disabled={disabled || routes.length >= ROUTE_LIMITS.routes} onClick={() => onChange([...routes, { hosts: [] }])}>
          <Plus className="size-3.5" />
          Add route
        </Button>
        <span className="text-[11px] text-t3">
          <KeyRound className="mr-1 inline size-3" />
          Up to {ROUTE_LIMITS.routes} routes, {ROUTE_LIMITS.hostsPerRoute} hosts each
        </span>
      </div>
      {preview.length > 0 && (
        <details className="text-[12px]">
          <summary className="cursor-pointer text-t2">What Landflow writes to kagent</summary>
          <pre className={cn('mt-1 overflow-auto whitespace-pre-wrap rounded-md border border-hair bg-wl p-2 font-mono text-[11px] text-t2')}>{preview.join('\n')}</pre>
        </details>
      )}
    </div>
  );
}
