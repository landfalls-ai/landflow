// Exports the zod schemas as JSON Schema (draft 2020-12) for non-TS SDKs.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  announceRequestSchema,
  executeRequestSchema,
  executeResponseSchema,
  manifestSchema,
  nodeDescriptorSchema,
  webhookMethodRequestSchema,
  webhookRequestSchema,
} from '../src/schema';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema');
mkdirSync(outDir, { recursive: true });

const schemas = {
  'manifest.schema.json': manifestSchema,
  'node-descriptor.schema.json': nodeDescriptorSchema,
  'execute-request.schema.json': executeRequestSchema,
  'execute-response.schema.json': executeResponseSchema,
  'announce-request.schema.json': announceRequestSchema,
  'webhook-method-request.schema.json': webhookMethodRequestSchema,
  'webhook-request.schema.json': webhookRequestSchema,
};

for (const [file, schema] of Object.entries(schemas)) {
  const json = z.toJSONSchema(schema, { unrepresentable: 'any', cycles: 'ref' });
  writeFileSync(join(outDir, file), JSON.stringify(json, null, 2) + '\n');
  console.log(`wrote schema/${file}`);
}
