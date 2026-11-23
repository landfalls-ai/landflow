import { z } from 'zod';

/** GET /api/insights/ai/me?period=24h|7d|30d|90d */
export const myAiSpendQuerySchema = z.object({ period: z.enum(['24h', '7d', '30d', '90d']).default('7d') });
