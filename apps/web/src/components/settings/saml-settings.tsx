'use client';
/**
 * Settings → Security → SAML (owners and admins): the SAML 2.0 sign-in configuration from the environment (README
 * "SAML"): what to give the IdP (entity id, ACS and metadata URLs), what was read from it (SSO and logout URLs,
 * signing certificates and when the first expires), the security settings and the attribute mappings.
 */
import { CheckCircle2, CircleSlash, Fingerprint, TriangleAlert } from 'lucide-react';
import type { SamlSecurityView } from '@/lib/shared/auth';
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

const Env = ({ children }: { children: React.ReactNode }) => <code className="font-mono text-[12px] text-t1">{children}</code>;

function Copyable({ value }: { value?: string }) {
  if (!value) return <span className="text-t3">—</span>;
  return (
    <span className="flex items-center gap-1">
      <Env>{value}</Env>
      <CopyButton text={value} label="Copy" />
    </span>
  );
}

function Mapping({ map, empty }: { map: Record<string, string>; empty: string }) {
  const entries = Object.entries(map);
  if (!entries.length) return <span className="text-t3">{empty}</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {entries.map(([value, target]) => (
        <Badge key={value} tone="muted" className="font-mono font-medium">
          {value} → {target}
        </Badge>
      ))}
    </span>
  );
}

export function SamlSettings({ saml }: { saml?: SamlSecurityView }) {
  if (!saml) return null;
  const expires = saml.idpCertExpires ? new Date(saml.idpCertExpires) : undefined;
  const expiringSoon = expires && expires.getTime() - Date.now() < 30 * 86_400_000;
  return (
    <Card className="px-5 py-4">
      <div className="mb-2 flex items-center gap-2">
        <Fingerprint className="size-4 text-t3" strokeWidth={1.8} />
        <SectionLabel>Single sign-on (SAML 2.0)</SectionLabel>
        <span className="ml-auto">
          {!saml.configured ? (
            <Badge tone="muted">
              <CircleSlash className="size-3" /> Not configured
            </Badge>
          ) : saml.error ? (
            <Badge tone="danger">
              <TriangleAlert className="size-3" /> IdP problem
            </Badge>
          ) : (
            <Badge tone="success">
              <CheckCircle2 className="size-3" /> Configured
            </Badge>
          )}
        </span>
      </div>
      {saml.configured ? (
        <div className="divide-y divide-hair">
          <Row label="Entity ID (ours)">
            <Copyable value={saml.entityId} />
          </Row>
          <Row label="ACS URL">
            <Copyable value={saml.acsUrl} />
          </Row>
          <Row label="SP metadata">
            <Copyable value={saml.metadataUrl} />
          </Row>
          <Row label="IdP entity ID">
            <Env>{saml.idpIssuer ?? '—'}</Env>
          </Row>
          <Row label="IdP sign-in URL">
            <Env>{saml.idpSsoUrl ?? '—'}</Env>
          </Row>
          <Row label="Single logout">{saml.idpSloUrl ? <Env>{saml.idpSloUrl}</Env> : <span className="text-t3">not offered by the IdP: signing out is local</span>}</Row>
          <Row label="Signing certificates">
            {saml.idpCerts} {expires && <span className={expiringSoon ? 'text-warn' : 'text-t3'}>(first expires {expires.toLocaleDateString()})</span>}
          </Row>
          <Row label="Signatures">{saml.wantAssertionsSigned ? 'Assertions must be signed' : 'The response or its assertion must be signed'}</Row>
          <Row label="Clock skew">{saml.clockSkewSeconds} s</Row>
          <Row label="Button">{saml.label}</Row>
          <Row label="Attributes">
            <span className="text-[12px] text-t2">
              email <Env>{saml.emailAttribute}</Env> · name <Env>{saml.nameAttribute}</Env> · role <Env>{saml.roleAttribute}</Env> · projects <Env>{saml.projectAttribute}</Env>
            </span>
          </Row>
          <Row label="Role mapping">
            <Mapping map={saml.roleMap} empty="none (everyone gets the default role)" />
          </Row>
          <Row label="Default role">{saml.defaultRole === 'none' ? 'none: users without a mapped role can’t sign in' : saml.defaultRole}</Row>
          <Row label="Project mapping">
            <Mapping map={saml.projectMap} empty="none" />
          </Row>
          <Row label="New users">{saml.jit ? 'Created on their first sign-in' : 'Must be invited (or provisioned by SCIM) first'}</Row>
          {saml.error && (
            <Row label="IdP">
              <span className="text-rd">{saml.error}</span>
            </Row>
          )}
        </div>
      ) : (
        <p className="text-[13px] text-t2">
          Set <Env>LANDFLOW_SAML_IDP_METADATA_URL</Env> (or <Env>LANDFLOW_SAML_ENTRY_POINT</Env>, <Env>LANDFLOW_SAML_IDP_ISSUER</Env> and <Env>LANDFLOW_SAML_IDP_CERT</Env>) to add a SAML button to the sign-in
          page (Okta, Entra ID, ADFS, Keycloak…), and give the IdP this instance’s metadata at <Env>/api/auth/saml/metadata</Env>. Map IdP attributes to roles and projects with{' '}
          <Env>LANDFLOW_SAML_ROLE_MAP</Env> and <Env>LANDFLOW_SAML_PROJECT_MAP</Env>.
        </p>
      )}
    </Card>
  );
}
