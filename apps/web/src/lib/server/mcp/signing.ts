/**
 * HMACs for the signed things MCP hands out (file URLs, approval state): under the binary store's secret
 * (LANDFLOW_BINARY_SECRET, else a random key per process: the same `singleton` lib/server/binary/access.ts uses for its
 * tokens), separated by a domain so a signature made for one use can't serve another.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { singleton, singletonKeys } from '../singleton';

const secret = () => singleton(singletonKeys.binaryTokenSecret, () => (process.env.LANDFLOW_BINARY_SECRET ? Buffer.from(process.env.LANDFLOW_BINARY_SECRET) : randomBytes(32)));

export const signPayload = (domain: string, payload: string) => createHmac('sha256', secret()).update(`${domain}\n${payload}`).digest('base64url');
