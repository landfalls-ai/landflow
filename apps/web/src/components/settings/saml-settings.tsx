'use client';
/**
 * Settings → Security → SAML (owners and admins): the SAML 2.0 sign-in configuration from the environment (docs/features/authentication.md,
 * "SAML"): what to give the IdP (entity id, ACS and metadata URLs), what was read from it (SSO and logout URLs,
 * signing certificates and when the first expires), the security settings and the attribute mappings. Assertion
 * encryption is set here: generate or upload the decryption key, copy its certificate for the IdP, and require
 * encrypted assertions (/api/settings/security/saml/encryption). Key rotation with two certificates: stage a next
 * decryption key (published in our metadata beside the current one), switch over to it, discard the retired one; the
 * signing certificate and its next one (LANDFLOW_SAML_CERT / _NEXT_CERT) are shown too.
 */
import { useState } from 'react';
import { CheckCircle2, CircleSlash, Fingerprint, KeyRound, TriangleAlert, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import type { SamlEncryptionView, SamlKeyInfo, SamlSecurityView } from '@/lib/shared/auth';
import { Card } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { FieldLabel, Input, SectionLabel, Switch, Textarea } from '@/components/ui/inputs';

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

const ENCRYPTION_API = '/api/settings/security/saml/encryption';

/** A certificate kept for rotation: subject, expiry, fingerprint and a copy button for the IdP. */
function KeyLine({ info, hint }: { info: SamlKeyInfo; hint: string }) {
  const expires = info.validTo ? new Date(info.validTo) : undefined;
  return (
    <div className="space-y-0.5">
      <div className="flex flex-wrap items-center gap-2 text-t1">
        <KeyRound className="size-3.5 text-t3" />
        <span className="break-all">{info.subject ?? 'Certificate'}</span>
        <Badge tone="muted">{info.source === 'env' ? 'from the environment' : info.source === 'generated' ? 'generated here' : 'uploaded'}</Badge>
      </div>
      <div className="text-[12px] text-t3">
        {expires && <span className={expires.getTime() - Date.now() < 30 * 86_400_000 ? 'text-warn' : undefined}>valid until {expires.toLocaleDateString()} · </span>}
        <span className="break-all font-mono text-[11px]">{info.fingerprint}</span>
        {info.retiredAt && <span> · retired {new Date(info.retiredAt).toLocaleDateString()}</span>}
      </div>
      {info.error && <div className="text-[12px] text-rd">{info.error}</div>}
      {info.certificate && (
        <div className="flex items-center gap-1 text-[12px] text-t2">
          {hint} <CopyButton text={info.certificate} label="Copy certificate" />
        </div>
      )}
    </div>
  );
}

/** Encrypted assertions: the decryption key's certificate, generate / upload / remove, and "require encrypted". */
function AssertionEncryption({ initial }: { initial: SamlEncryptionView }) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState<string>();
  const [uploading, setUploading] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [form, setForm] = useState({ cert: '', key: '', passphrase: '' });
  const expires = view.validTo ? new Date(view.validTo) : undefined;

  const call = async (what: string, init: Parameters<typeof api>[1], done: string) => {
    setBusy(what);
    try {
      setView(await api<SamlEncryptionView>(ENCRYPTION_API, init));
      toast.success(done);
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="space-y-2 py-1.5">
      <div className="grid grid-cols-[160px_minmax(0,1fr)] items-start gap-3 text-[13px]">
        <span className="text-t3">Assertion encryption</span>
        <div className="min-w-0 space-y-2">
          {view.configured ? (
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2 text-t1">
                <KeyRound className="size-3.5 text-t3" />
                <span className="break-all">{view.subject ?? 'Certificate'}</span>
                <Badge tone="muted">{view.source === 'env' ? 'from the environment' : view.source === 'generated' ? 'generated here' : 'uploaded'}</Badge>
              </div>
              <div className="text-[12px] text-t3">
                {expires && <span className={expires.getTime() - Date.now() < 30 * 86_400_000 ? 'text-warn' : undefined}>valid until {expires.toLocaleDateString()} · </span>}
                <span className="break-all font-mono text-[11px]">{view.fingerprint}</span>
              </div>
              {view.certificate && (
                <div className="flex items-center gap-1 text-[12px] text-t2">
                  Give the IdP this certificate to encrypt to (it is in our metadata too) <CopyButton text={view.certificate} label="Copy certificate" />
                </div>
              )}
            </div>
          ) : (
            <p className="text-[12px] text-t2">Assertions arrive signed but readable by the browser. Add a decryption key, give the IdP its certificate, and it can encrypt them to this instance.</p>
          )}
          {view.error && <div className="text-[12px] text-rd">{view.error}</div>}
          {view.configured && (
            <label className="flex items-center gap-2 text-[12px] text-t1">
              <Switch
                checked={view.required}
                disabled={busy === 'required'}
                onChange={(value) => void call('required', { method: 'PATCH', json: { required: value } }, value ? 'Unencrypted assertions are refused now' : 'Unencrypted assertions are accepted again')}
                label="Require encrypted assertions"
              />
              Require encrypted assertions <span className="text-t3">(refuse responses whose assertion isn’t encrypted)</span>
            </label>
          )}
          {view.configured && (view.next || view.previous || !view.fromEnv) && (
            <div className="space-y-2 rounded-[10px] border border-hair bg-sf2 p-3">
              <div className="text-[12px] font-medium text-t1">Key rotation</div>
              {view.next ? (
                <div className="space-y-1.5">
                  <div className="text-[12px] text-t3">Next key: published in our metadata beside the current one, and responses decrypt with either.</div>
                  <KeyLine info={view.next} hint="Give the IdP this certificate too, then switch over" />
                  {view.next.source !== 'env' && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Button size="sm" variant="primary" loading={busy === 'switch'} onClick={() => void call('switch', { method: 'POST', json: { action: 'switch' } }, 'Switched over: the next key is the current one now')}>
                        Switch over
                      </Button>
                      <Button size="sm" variant="ghost" loading={busy === 'discard-next'} onClick={() => void call('discard-next', { method: 'POST', json: { action: 'discard', slot: 'next' } }, 'Next key discarded')}>
                        Discard
                      </Button>
                    </div>
                  )}
                  {view.next.source === 'env' && (
                    <p className="text-[11px] text-t3">
                      Set by <Env>LANDFLOW_SAML_DECRYPTION_NEXT_KEY</Env> and <Env>LANDFLOW_SAML_DECRYPTION_NEXT_CERT</Env>; swap them into the current pair there when the IdP has moved.
                    </p>
                  )}
                </div>
              ) : (
                !view.fromEnv && (
                  <div className="space-y-1.5">
                    <p className="text-[12px] text-t3">Stage a second key before the current certificate expires: give the IdP its certificate, then switch over without a gap.</p>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Button size="sm" loading={busy === 'generate-next'} onClick={() => void call('generate-next', { method: 'POST', json: { action: 'generate', slot: 'next' } }, 'Next key generated — give the IdP its certificate')}>
                        <KeyRound className="size-3.5" /> Generate next key
                      </Button>
                    </div>
                  </div>
                )
              )}
              {view.previous && (
                <div className="space-y-1.5 border-t border-hair pt-2">
                  <div className="text-[12px] text-t3">Retired key: no longer in our metadata, but it still decrypts what the IdP encrypted to it.</div>
                  <KeyLine info={view.previous} hint="Retired certificate" />
                  <Button size="sm" variant="ghost" loading={busy === 'discard-previous'} onClick={() => void call('discard-previous', { method: 'POST', json: { action: 'discard', slot: 'previous' } }, 'Retired key discarded')}>
                    Discard the retired key
                  </Button>
                </div>
              )}
            </div>
          )}
          {view.fromEnv ? (
            <p className="text-[11px] text-t3">
              Set by <Env>LANDFLOW_SAML_DECRYPTION_KEY</Env> and <Env>LANDFLOW_SAML_DECRYPTION_CERT</Env>; change it there.
            </p>
          ) : uploading ? (
            <form
              className="space-y-2 rounded-[10px] border border-hair bg-sf2 p-3"
              onSubmit={(e) => {
                e.preventDefault();
                void call('upload', { method: 'POST', json: { action: 'upload', cert: form.cert, key: form.key, ...(form.passphrase && { passphrase: form.passphrase }) } }, 'Decryption key saved — give the IdP its certificate').then((ok) => {
                  if (!ok) return;
                  setUploading(false);
                  setForm({ cert: '', key: '', passphrase: '' });
                });
              }}
            >
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div>
                  <FieldLabel>Certificate (PEM)</FieldLabel>
                  <Textarea rows={4} value={form.cert} onChange={(e) => setForm((f) => ({ ...f, cert: e.target.value }))} placeholder="-----BEGIN CERTIFICATE-----" className="font-mono text-[11px]" spellCheck={false} />
                </div>
                <div>
                  <FieldLabel>RSA private key (PEM)</FieldLabel>
                  <Textarea
                    rows={4}
                    value={form.key}
                    onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))}
                    placeholder="-----BEGIN PRIVATE KEY-----"
                    className="font-mono text-[11px] [-webkit-text-security:disc]"
                    spellCheck={false}
                    autoComplete="off"
                  />
                </div>
              </div>
              <div className="max-w-[320px]">
                <FieldLabel>Key passphrase (optional)</FieldLabel>
                <Input type="password" autoComplete="off" value={form.passphrase} onChange={(e) => setForm((f) => ({ ...f, passphrase: e.target.value }))} placeholder="Only for an encrypted key" />
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="primary" type="submit" loading={busy === 'upload'} disabled={!form.cert.trim() || !form.key.trim()}>
                  Save key
                </Button>
                <Button size="sm" variant="ghost" type="button" onClick={() => setUploading(false)}>
                  Cancel
                </Button>
              </div>
              <p className="text-[11px] text-t3">The key is encrypted at rest and never shown again.</p>
            </form>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                size="sm"
                onClick={() => void call('generate', { method: 'POST', json: { action: 'generate' } }, view.configured ? 'New decryption key — give the IdP the new certificate' : 'Decryption key generated — give the IdP its certificate')}
                loading={busy === 'generate'}
                title={view.configured ? 'Replaces the current key: the IdP must get the new certificate' : undefined}
              >
                <KeyRound className="size-3.5" /> {view.configured ? 'Generate a new key' : 'Generate key'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setUploading(true)}>
                <Upload className="size-3.5" /> Upload key
              </Button>
              {view.configured &&
                (confirmRemove ? (
                  <span className="flex items-center gap-1.5 text-[12px] text-t2">
                    Remove? Encrypted assertions will fail.
                    <Button
                      size="sm"
                      variant="danger"
                      loading={busy === 'remove'}
                      onClick={() => void call('remove', { method: 'DELETE' }, 'Decryption key removed').then(() => setConfirmRemove(false))}
                    >
                      Remove
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
                      Keep
                    </Button>
                  </span>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(true)}>
                    Remove
                  </Button>
                ))}
            </div>
          )}
        </div>
      </div>
    </div>
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
          {saml.signing && (
            <Row label="Our signing key">
              <div className="space-y-2">
                <KeyLine info={saml.signing.current} hint="In our metadata; the IdP verifies our requests with it" />
                {saml.signing.next ? (
                  <>
                    <div className="text-[12px] text-t3">
                      Next certificate, published beside it (<Env>LANDFLOW_SAML_NEXT_CERT</Env>). When the IdP has it, move the next key and certificate into <Env>LANDFLOW_SAML_PRIVATE_KEY</Env> and <Env>LANDFLOW_SAML_CERT</Env>.
                    </div>
                    <KeyLine info={saml.signing.next} hint="Give the IdP this certificate too" />
                  </>
                ) : (
                  <div className="text-[11px] text-t3">
                    To rotate it, set <Env>LANDFLOW_SAML_NEXT_CERT</Env> to the next certificate: our metadata publishes both.
                  </div>
                )}
              </div>
            </Row>
          )}
          {saml.encryption && <AssertionEncryption initial={saml.encryption} />}
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
