'use client';
/**
 * Settings → Security (owners and admins): how sign-in is configured. Single sign-on (OIDC) with a live discovery
 * check and the redirect URL to register, email for invites and resets, session length, the plugin registry secret and
 * metrics access. Read-only: all of it comes from environment variables (README "Authentication").
 */
import { useEffect, useState } from 'react';
import { CheckCircle2, CircleSlash, KeyRound, Mail, ShieldCheck, TriangleAlert } from 'lucide-react';
import { api } from '@/lib/client/api';
import type { SecurityView } from '@/lib/shared/auth';
import { Card } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from '@/components/ui/copy-button';
import { SectionLabel } from '@/components/ui/inputs';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[160px_minmax(0,1fr)] items-start gap-3 py-1.5 text-[13px]">
      <span className="text-t3">{label}</span>
      <span className="min-w-0 break-words text-t1">{children}</span>
    </div>
  );
}

function Env({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-[12px] text-t1">{children}</code>;
}

function Status({ on, labels = ['On', 'Off'] }: { on: boolean; labels?: [string, string] }) {
  return (
    <Badge tone={on ? 'success' : 'muted'}>
      {on ? <CheckCircle2 className="size-3" /> : <CircleSlash className="size-3" />}
      {on ? labels[0] : labels[1]}
    </Badge>
  );
}

export function SecuritySettings() {
  const [view, setView] = useState<SecurityView>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    api<SecurityView>('/api/settings/security')
      .then(setView)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>;
  if (!view) return <div className="h-56 rounded-2xl border border-hair bg-sf animate-pulse-soft" />;
  const { oidc, smtp } = view;
  const roleMap = Object.entries(oidc.roleMap);

  return (
    <div className="space-y-4">
      <Card className="px-5 py-4">
        <div className="mb-2 flex items-center gap-2">
          <ShieldCheck className="size-4 text-t3" strokeWidth={1.8} />
          <SectionLabel>Single sign-on (OIDC)</SectionLabel>
          <span className="ml-auto">
            {!oidc.configured ? (
              <Status on={false} labels={['Configured', 'Not configured']} />
            ) : oidc.reachable ? (
              <Status on labels={['Connected', '']} />
            ) : (
              <Badge tone="danger">
                <TriangleAlert className="size-3" /> Unreachable
              </Badge>
            )}
          </span>
        </div>
        {oidc.configured ? (
          <div className="divide-y divide-hair">
            <Row label="Issuer">
              <Env>{oidc.issuer}</Env>
            </Row>
            <Row label="Client ID">
              <Env>{oidc.clientId}</Env>
            </Row>
            <Row label="Redirect URL">
              <span className="flex items-center gap-1">
                <Env>{oidc.redirectUrl}</Env>
                {oidc.redirectUrl && <CopyButton text={oidc.redirectUrl} label="Copy redirect URL" />}
              </span>
            </Row>
            <Row label="Button">{oidc.label}</Row>
            <Row label="Role claim">
              <Env>{oidc.roleClaim}</Env>
            </Row>
            <Row label="Role mapping">
              {roleMap.length ? (
                <span className="flex flex-wrap gap-1">
                  {roleMap.map(([claim, role]) => (
                    <Badge key={claim} tone="muted" className="font-mono font-medium">
                      {claim} → {role}
                    </Badge>
                  ))}
                </span>
              ) : (
                <span className="text-t3">none (everyone gets the default role)</span>
              )}
            </Row>
            <Row label="Default role">{oidc.defaultRole === 'none' ? 'none: users without a mapped role can’t sign in' : oidc.defaultRole}</Row>
            {oidc.error && (
              <Row label="Discovery">
                <span className="text-rd">{oidc.error}</span>
              </Row>
            )}
          </div>
        ) : (
          <p className="text-[13px] text-t2">
            Set <Env>LANDFLOW_OIDC_ISSUER</Env>, <Env>LANDFLOW_OIDC_CLIENT_ID</Env> and <Env>LANDFLOW_OIDC_CLIENT_SECRET</Env> to add a single sign-on button to the sign-in page (Keycloak, Okta, Entra ID,
            Google, Auth0…). People who sign in through it for the first time get an account; map identity provider roles with <Env>LANDFLOW_OIDC_ROLE_MAP</Env>.
          </p>
        )}
      </Card>

      <Card className="px-5 py-4">
        <div className="mb-2 flex items-center gap-2">
          <Mail className="size-4 text-t3" strokeWidth={1.8} />
          <SectionLabel>Email</SectionLabel>
          <span className="ml-auto">
            <Status on={smtp.configured} labels={['Configured', 'Not configured']} />
          </span>
        </div>
        {smtp.configured ? (
          <div className="divide-y divide-hair">
            <Row label="SMTP server">
              <Env>
                {smtp.host}:{smtp.port}
              </Env>
            </Row>
            <Row label="From">{smtp.from}</Row>
          </div>
        ) : (
          <p className="text-[13px] text-t2">
            Invites and password resets show a link to copy. Set <Env>LANDFLOW_SMTP_HOST</Env> (and <Env>LANDFLOW_SMTP_PORT</Env>, <Env>LANDFLOW_SMTP_USER</Env>, <Env>LANDFLOW_SMTP_PASS</Env>,{' '}
            <Env>LANDFLOW_SMTP_FROM</Env>) to email them, and to let people reset their own password.
          </p>
        )}
      </Card>

      <Card className="px-5 py-4">
        <div className="mb-2 flex items-center gap-2">
          <KeyRound className="size-4 text-t3" strokeWidth={1.8} />
          <SectionLabel>Sessions and access</SectionLabel>
        </div>
        <div className="divide-y divide-hair">
          <Row label="Session length">
            {view.sessionHours % 24 === 0 ? `${view.sessionHours / 24} days` : `${view.sessionHours} hours`} <span className="text-t3">(<Env>LANDFLOW_SESSION_TTL_HOURS</Env>)</span>
          </Row>
          <Row label="Plugin registry secret">
            <span className="flex flex-wrap items-center gap-2">
              <Status on={view.registrySecret} labels={['Required', 'Not set']} />
              <span className="text-[12px] text-t3">
                {view.registrySecret ? 'Plugins must send LANDFLOW_REGISTRY_SECRET to register.' : 'Any process that can reach Landflow can register a plugin. Set LANDFLOW_REGISTRY_SECRET to require one.'}
              </span>
            </span>
          </Row>
          <Row label="Metrics">
            <span className="flex flex-wrap items-center gap-2">
              <Status on={view.metricsPublic} labels={['Public', 'Signed in']} />
              <span className="text-[12px] text-t3">
                {view.metricsPublic ? '/api/metrics is open to scrapers (LANDFLOW_METRICS_PUBLIC).' : '/api/metrics needs a session or an API key with executions:read.'}
              </span>
            </span>
          </Row>
        </div>
      </Card>
    </div>
  );
}
