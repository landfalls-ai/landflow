/**
 * Who must have a second factor, and what a session without one may do: `LANDFLOW_MFA_REQUIRED` (`off`, `admins`, `all`).
 * The code is in ../policy.ts beside the route policy (the guard reads it on every request); this module is the
 * second-factor code's name for it. See docs/features/authentication.md#second-factor.
 */
export { enrolmentRequired, enrolOnlyAllowed, mfaCovers, mfaMode, type MfaMode } from '../policy';
export type { MfaMethod } from '../../../shared/auth';
