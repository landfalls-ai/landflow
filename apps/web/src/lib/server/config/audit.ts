/** Audit settings read from the environment (docs/reference/configuration.md). */
import { flag } from './parse';

/** `LANDFLOW_AUDIT_FAIL_CLOSED`: high-value changes need their audit event (default off; read on every call). */
export function auditFailClosed(env: NodeJS.ProcessEnv = process.env): boolean {
  return flag(env.LANDFLOW_AUDIT_FAIL_CLOSED, false, 'LANDFLOW_AUDIT_FAIL_CLOSED');
}
