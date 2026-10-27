/**
 * The SSH private key credential (`core.sshPrivateKey`): a key (and optional passphrase) that Settings → Source control
 * uses to reach a Git remote over SSH. Landflow writes it to a private temporary file for one git call and pins the
 * server's host keys, so the key never reaches a shell, the command line or the repository config.
 */
import { defineCredentialType } from '@landflow/sdk';

export const sshPrivateKeyCredential = defineCredentialType({
  name: 'sshPrivateKey',
  displayName: 'SSH private key',
  description: 'A private key for SSH: a deploy key for the Git repository in Settings → Source control. Use a key with access to that one repository only.',
  icon: 'lucide:key-round',
  documentationUrl: 'https://docs.github.com/authentication/connecting-to-github-with-ssh/managing-deploy-keys',
  properties: [
    { name: 'privateKey', displayName: 'Private key', type: 'string', default: '', required: true, typeOptions: { password: true, rows: 6 }, placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----' },
    { name: 'passphrase', displayName: 'Passphrase', type: 'string', default: '', typeOptions: { password: true }, description: 'Only when the key is encrypted' },
  ],
  async test(data) {
    const key = typeof data.privateKey === 'string' ? data.privateKey : '';
    if (!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]+-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(key.trim())) return { ok: false, message: 'Paste a PEM private key (-----BEGIN … PRIVATE KEY----- … -----END … PRIVATE KEY-----)' };
    return { ok: true, message: 'The key has the shape of a PEM private key. Source control checks the connection when it pushes or pulls.' };
  },
});
