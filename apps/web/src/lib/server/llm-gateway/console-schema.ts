import { z } from 'zod';

/** GET /api/insights/ai?period=24h|7d|30d */
export const aiConsoleQuerySchema = z.object({ period: z.enum(['24h', '7d', '30d']).default('7d') });
