/** Request schema of the compliance route (server-only: the shared contract has no zod). */
import { z } from 'zod';
import { COMPLIANCE_DAYS } from '../../shared/practice-compliance';

export const complianceQuery = z.object({ days: z.coerce.number().int().min(COMPLIANCE_DAYS.min).max(COMPLIANCE_DAYS.max).default(COMPLIANCE_DAYS.default) });
