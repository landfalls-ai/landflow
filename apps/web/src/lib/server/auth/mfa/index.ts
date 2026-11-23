/** The second factor (C16): TOTP and recovery codes, the sign-in challenge and the enrolment policy. See docs/features/authentication.md#second-factor. */
export { CHALLENGE_MINUTES, claimAttempt, consumeWebauthnChallenge, MAX_WRONG, openChallenge, peekChallenge, setWebauthnChallenge, useChallenge, type ChallengeRow, type FirstMethod } from './challenges';
export { answerSecondFactor, confirmTotp, stepUpCheck, type StepUpInput, hasConfirmedFactor, listFactors, methodsFor, MfaError, removeFactor, resetFactors, startTotp, STEP_UP_MINUTES, verifyTotp } from './factors';
export { enrolmentRequired, enrolOnlyAllowed, mfaCovers, mfaMode, type MfaMethod, type MfaMode } from './policy';
export { newRecoveryCodes, RECOVERY_CODES, recoveryCodesLeft, useRecoveryCode } from './recovery';
export { otpauthUrl, qrSvgDataUrl } from './totp';
export { assertionSchema, attestationSchema, authenticationOptions, finishRegistration, hasUsablePasskey, MAX_PASSKEYS, registrationOptions, relyingParty, stepUpOptions, stepUpPasskey, verifyPasskey } from './webauthn';
export { checkEnrolPassword } from './enrol-password';
