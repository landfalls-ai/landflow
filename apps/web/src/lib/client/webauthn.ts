'use client';
/**
 * The browser's side of passkeys, on `@simplewebauthn/browser`: ask the authenticator to make or use a passkey for the
 * options the server made, and turn the errors a person can cause (cancelling the prompt, a key already added, no
 * support in this browser) into sentences. Nothing here stores a credential; the server does the verifying.
 */
import { useEffect, useState } from 'react';
import { browserSupportsWebAuthn, startAuthentication, startRegistration, WebAuthnError, type AuthenticationResponseJSON, type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON, type RegistrationResponseJSON } from '@simplewebauthn/browser';

export type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON };

/** Whether this browser can do passkeys. True until the browser is known (the server render has no `window`). */
export function usePasskeysSupported(): boolean {
  const [supported, setSupported] = useState(true);
  useEffect(() => setSupported(browserSupportsWebAuthn()), []);
  return supported;
}

/** Make a passkey with the person's authenticator for `options` (from POST /api/me/mfa/passkeys/options). */
export const createPasskey = (options: PublicKeyCredentialCreationOptionsJSON): Promise<RegistrationResponseJSON> => startRegistration({ optionsJSON: options });

/** Use a passkey for `options` (from POST /api/auth/mfa/options or a step-up). */
export const askPasskey = (options: PublicKeyCredentialRequestOptionsJSON): Promise<AuthenticationResponseJSON> => startAuthentication({ optionsJSON: options });

/** What went wrong in the browser, in words; undefined for an error that did not come from the authenticator. */
export function passkeyProblem(caught: unknown): string | undefined {
  if (caught instanceof WebAuthnError) {
    if (caught.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') return 'This passkey is already added to your account.';
    if (caught.code === 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY' && (caught.cause as Error | undefined)?.name === 'NotAllowedError') return 'The passkey prompt was cancelled or timed out. Try again.';
    if (caught.code === 'ERROR_CEREMONY_ABORTED') return 'The passkey prompt was cancelled. Try again.';
    if (caught.code === 'ERROR_INVALID_RP_ID' || caught.code === 'ERROR_INVALID_DOMAIN') return 'This address can’t use passkeys. Open Landflow at its public address (LANDFLOW_PUBLIC_URL) and try again.';
    return caught.message;
  }
  if (caught instanceof DOMException) return caught.name === 'NotAllowedError' ? 'The passkey prompt was cancelled or timed out. Try again.' : caught.message;
  return undefined;
}
