/** The provider kinds: OpenBao/Vault, 1Password Connect, AWS Secrets Manager, Google Secret Manager, Azure Key Vault. */
import type { SecretProviderKind, SecretProviderKindInfo } from '../../../shared/secrets';
import { awsProvider } from './aws';
import { azureProvider } from './azure';
import { gcpProvider } from './gcp';
import { onePasswordProvider } from './onepassword';
import type { ProviderDefinition } from './types';
import { vaultProvider } from './vault';

export * from './types';
export { registerVaultAuthMethod, vaultAuthMethods, type VaultAuthMethod, type VaultLogin } from './vault';
export { signV4 } from './aws';
export { serviceAccountAssertion } from './gcp';

export const PROVIDERS: Record<SecretProviderKind, ProviderDefinition> = {
  vault: vaultProvider,
  onePassword: onePasswordProvider,
  awsSecretsManager: awsProvider,
  gcpSecretManager: gcpProvider,
  azureKeyVault: azureProvider,
};

/** The kinds for the Settings form (field lists computed now: Vault's auth methods are pluggable). */
export const providerKinds = (): SecretProviderKindInfo[] =>
  Object.values(PROVIDERS).map(({ kind, label, description, defaultName, fields }) => ({ kind, label, description, defaultName, fields }));
