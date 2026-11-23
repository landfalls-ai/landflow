/**
 * Machine checks over a change, with no model (docs/practices.md#machine-checks). The implementation is shared with the
 * Check Practices step and lives in `@landflow/protocol/practice-checks` (a subpath, so the CLI does not pull in the protocol's zod); this file keeps the names the CLI used.
 */
import { practiceCheckLabel, runPracticeCheck, runPracticeChecks, type PracticeCheckResult } from '@landflow/protocol/practice-checks';

export type CheckResult = PracticeCheckResult;
export const checkLabel = practiceCheckLabel;
export const runCheck = runPracticeCheck;
export const runChecks = runPracticeChecks;
