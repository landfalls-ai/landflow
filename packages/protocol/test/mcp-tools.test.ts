import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import {
  gatewayToolName,
  MCP_TOOL_META_KEY,
  MCP_TOOL_NAME_PATTERN,
  mcpToolsFromManifest,
  operationSlots,
  sanitizeToolName,
  toolCallToParameters,
  type McpToolDefinition,
  type PluginManifest,
} from '../src';
import { loadConformanceManifests, loadMcpToolsFixture } from '../conformance';

const manifestsDir = join(import.meta.dirname, 'fixtures', 'manifests');
const bundled = readdirSync(manifestsDir)
  .sort()
  .map((file) => JSON.parse(readFileSync(join(manifestsDir, file), 'utf8')) as PluginManifest);
const synthetic = loadConformanceManifests();

/** Validates a schema against the 2020-12 meta-schema; `strict` makes unknown keywords (and `title` typos) fail. */
const ajv = addFormats(new Ajv2020({ strict: true, allErrors: true }));
const isValidSchema = (schema: unknown) => {
  const ok = ajv.validateSchema(schema) as boolean;
  return ok ? true : JSON.stringify(ajv.errors);
};

describe('names', () => {
  it('sanitises to the MCP tool-name rules', () => {
    expect(sanitizeToolName('message_send')).toBe('message_send');
    expect(sanitizeToolName('go-crypto_hash')).toBe('go-crypto_hash');
    expect(sanitizeToolName('aVeryLongNodeNameThatGoesOnAndOnAndOnToTestTheLimitOnToolNamesInMcpClientsEverywhere')).toBe('aVeryLongNodeNameThatGoesOnAndOnAndOnToTestTheLimitOnToolNamesIn');
    expect(sanitizeToolName('run!')).toBe('run');
    expect(sanitizeToolName('__x__')).toBe('x');
    expect(sanitizeToolName('***')).toBe('tool');
    expect(sanitizeToolName('a.b.c')).toBe('a_b_c');
  });

  it('prefixes the plugin id on the gateway', () => {
    expect(gatewayToolName('twilio', 'message_send')).toBe('twilio_message_send');
    expect(gatewayToolName('messaging', 'telegram_message_sendMessage')).toBe('messaging_telegram_message_sendMessage');
  });
});

describe('operation slots', () => {
  it('pairs each resource with the operations of every operation property that applies to it', () => {
    const slots = operationSlots(synthetic.twilio.nodes[0]).map((s) => [s.resource?.value, s.operation?.value]);
    expect(slots).toEqual([['message', 'send'], ['message', 'get'], ['message', 'list'], ['message', 'delete'], ['call', 'make'], ['call', 'hangup']]);
  });

  it('merges operations split over several operation properties (one per auth method)', () => {
    const discord = bundled.find((m) => m.plugin.id === 'messaging')!.nodes.find((n) => n.name === 'discord')!;
    expect(operationSlots(discord).map((s) => s.operation?.value)).toEqual(['send', 'deleteMessage', 'getAll', 'react']);
  });

  it('is one slot for a node without resource or operation', () => {
    expect(operationSlots({ properties: [] })).toEqual([{ fixed: {} }]);
  });
});

describe('mapping synthetic manifests', () => {
  const twilio = mcpToolsFromManifest(synthetic.twilio);
  const crm = mcpToolsFromManifest(synthetic['crm-suite']);
  const utilities = mcpToolsFromManifest(synthetic.utilities);
  const byName = (tools: McpToolDefinition[], name: string) => tools.find((t) => t.name === name)!;

  it('names tools <resource>_<operation> for a node named after its plugin, and excludes triggers and mcp:false operations', () => {
    expect(twilio.map((t) => t.name)).toEqual(['message_send', 'message_get', 'message_list', 'message_delete', 'call_make']);
    expect(twilio.map((t) => gatewayToolName('twilio', t.name))).toContain('twilio_message_send');
  });

  it('prefixes the node name when the plugin has several apps, honours mcp:false on nodes, resources and usableAsTool', () => {
    expect(crm.map((t) => t.name)).toEqual(['contacts_contact_upsert', 'contacts_contact_get', 'contacts_contact_search', 'contacts_contact_remove', 'contacts_company_get', 'notes_add', 'notes_list']);
    expect(utilities.map((t) => t.name)).toEqual(['hash', 'colour', 'aVeryLongNodeNameThatGoesOnAndOnAndOnToTestTheLimitOnToolNamesIn', 'dupA_run', 'dupA_run_2']);
  });

  it('builds inputSchema from the properties shown for the operation, discriminators and credential selectors excluded', () => {
    const send = byName(twilio, 'message_send');
    expect(Object.keys(send.inputSchema.properties as object)).toEqual(['from', 'to', 'channel', 'body', 'mediaUrl']);
    expect(send.inputSchema.required).toEqual(['from', 'to', 'body']);
    expect((send.inputSchema.properties as Record<string, Record<string, unknown>>).channel).toMatchObject({ type: 'string', enum: ['sms', 'whatsapp'], default: 'sms' });
    expect((send.inputSchema.properties as Record<string, Record<string, unknown>>).channel.description).toContain('`whatsapp` (WhatsApp: Numbers are prefixed');
    expect((send.inputSchema.properties as Record<string, Record<string, unknown>>).mediaUrl.description).toContain('Only used when `channel` is `sms`');
    // hidden and notice properties never show; the hidden `secret` is not an argument
    expect(Object.keys(send.inputSchema.properties as object)).not.toContain('secret');

    const get = byName(crm, 'contacts_contact_get');
    expect(Object.keys(get.inputSchema.properties as object)).toEqual(['contactId', 'simplify']);
    expect(get._meta[MCP_TOOL_META_KEY].credentialSelectors).toEqual([{ parameter: 'authentication', byCredential: { crmOAuth2Api: 'oAuth2', crmTokenApi: 'token' } }]);
    expect(get._meta[MCP_TOOL_META_KEY].credentials).toEqual(['crmOAuth2Api', 'crmTokenApi']);
  });

  it('maps collections, fixed collections, json, code, dynamic options and typed enums', () => {
    const list = byName(twilio, 'message_list');
    const properties = list.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(properties.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 1000, default: 50 });
    expect(properties.filters).toMatchObject({ type: 'object', properties: { dateSentAfter: { type: 'string', format: 'date-time' }, status: { type: 'array', items: { type: 'string', enum: ['delivered', 'failed'] } } } });

    const upsert = byName(crm, 'contacts_contact_upsert');
    const up = upsert.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(up.fields).toMatchObject({ type: 'object', properties: { field: { type: 'array', items: { type: 'object', properties: { name: { enum: ['firstName', 'lastName', 'phone'] }, value: { type: 'string' } } } } } });
    expect(up.properties).toMatchObject({ type: ['object', 'array', 'string'] });

    const get = byName(crm, 'contacts_contact_get');
    expect((get.inputSchema.properties as Record<string, Record<string, unknown>>).contactId).toMatchObject({ type: 'string' });
    expect((get.inputSchema.properties as Record<string, Record<string, unknown>>).contactId.description).toContain('dynamic list');
    expect(get._meta[MCP_TOOL_META_KEY].dynamicOptions).toEqual([{ parameter: 'contactId', method: 'getContacts' }]);
    expect(byName(crm, 'contacts_company_get')._meta[MCP_TOOL_META_KEY].dynamicOptions).toEqual([{ parameter: 'companyId', method: 'getCompanies', dependsOn: ['authentication'] }]);

    const add = byName(crm, 'notes_add');
    expect((add.inputSchema.properties as Record<string, Record<string, unknown>>).code.description).toContain('javascript code');

    const colour = byName(utilities, 'colour').inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(colour.level).toMatchObject({ type: 'number', enum: [1, 2] });
    expect(colour.enabled).toMatchObject({ type: 'boolean', enum: [true, false] });
    expect(colour.when).toMatchObject({ type: 'string', format: 'date-time' });
  });

  it('derives annotations from the operation and idempotent, with overrides', () => {
    const a = (tools: McpToolDefinition[], name: string) => byName(tools, name).annotations;
    expect(a(twilio, 'message_send')).toEqual({ title: 'Twilio · Message · Send', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    expect(a(twilio, 'message_get')).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    expect(a(twilio, 'message_delete')).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true }); // override on the option
    expect(a(crm, 'contacts_contact_upsert')).toMatchObject({ idempotentHint: true }); // node idempotent
    expect(a(crm, 'contacts_contact_remove')).toMatchObject({ destructiveHint: true, idempotentHint: false }); // option idempotent: false wins
    expect(a(crm, 'notes_list')).toMatchObject({ readOnlyHint: true, openWorldHint: false }); // node toolAnnotations override
    expect(a(utilities, 'hash')).toMatchObject({ readOnlyHint: false, idempotentHint: true });
  });

  it('declares outputSchema as structuredContent { items } when a node or operation has one', () => {
    expect(byName(twilio, 'message_get').outputSchema).toEqual({ type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { sid: { type: 'string' }, status: { type: 'string' } } } } }, required: ['items'] });
    expect(byName(twilio, 'message_send').outputSchema).toBeUndefined();
  });

  it('describes tools from the operation action and the node description', () => {
    expect(byName(twilio, 'message_send').description).toBe('Send an SMS, MMS or WhatsApp message. Send SMS, MMS and WhatsApp messages, place calls, list and get messages.');
    expect(byName(crm, 'contacts_contact_upsert').description).toBe('Create or update by email. Contacts and companies in the CRM.');
    expect(byName(utilities, 'hash').description).toBe('Hash a field with SHA-256, SHA-1 or MD5.');
  });

  it('binds each tool to its node and version', () => {
    expect(byName(crm, 'contacts_contact_get')._meta[MCP_TOOL_META_KEY]).toMatchObject({ pluginId: 'crm-suite', nodeType: 'crm-suite.contacts', typeVersion: 2, resource: 'contact', operation: 'get', fixedParameters: { resource: 'contact', operation: 'get' } });
  });

  it('maps a tool call back to node parameters', () => {
    const send = byName(twilio, 'message_send');
    expect(toolCallToParameters(send, { from: '+1', to: '+2', body: 'hi', bogus: 1 })).toEqual({
      nodeType: 'twilio.twilio',
      typeVersion: 1,
      parameters: { resource: 'message', operation: 'send', from: '+1', to: '+2', body: 'hi' },
      ignored: ['bogus'],
    });
    expect(toolCallToParameters(byName(utilities, 'hash'), undefined)).toEqual({ nodeType: 'utilities.hash', typeVersion: 1, parameters: {}, ignored: [] });
  });

  it('matches the generated conformance fixture exactly (regenerate with `pnpm gen:conformance` after changing the mapping)', () => {
    const fixture = loadMcpToolsFixture();
    for (const c of fixture.cases) expect(mcpToolsFromManifest(c.manifest), c.id).toEqual(c.tools);
  });
});

describe('mapping every bundled plugin manifest', () => {
  for (const manifest of bundled) {
    const tools = mcpToolsFromManifest(manifest);
    describe(manifest.plugin.id, () => {
      it('produces tools only for usableAsTool action nodes', () => {
        const expected = manifest.nodes.filter((n) => n.kind === 'action' && n.usableAsTool).map((n) => n.name).sort();
        expect([...new Set(tools.map((t) => t._meta[MCP_TOOL_META_KEY].nodeName))].sort()).toEqual(expected);
        expect(tools.length).toBeGreaterThan(0);
      });

      it('has unique, legal tool names, also on the gateway', () => {
        const names = tools.map((t) => t.name);
        expect(new Set(names).size).toBe(names.length);
        for (const name of names) expect(name, name).toMatch(MCP_TOOL_NAME_PATTERN);
        const gateway = names.map((n) => gatewayToolName(manifest.plugin.id, n));
        expect(new Set(gateway).size).toBe(gateway.length);
        for (const name of gateway) expect(name, name).toMatch(MCP_TOOL_NAME_PATTERN);
      });

      it('generates valid JSON Schema 2020-12 for every inputSchema and outputSchema', () => {
        for (const tool of tools) {
          expect(isValidSchema(tool.inputSchema), tool.name).toBe(true);
          expect(tool.inputSchema).toMatchObject({ type: 'object' });
          if (tool.outputSchema) expect(isValidSchema(tool.outputSchema), tool.name).toBe(true);
        }
      });

      it('never exposes credentials or credential selectors as arguments', () => {
        for (const tool of tools) {
          const binding = tool._meta[MCP_TOOL_META_KEY];
          for (const selector of binding.credentialSelectors) expect(binding.arguments, tool.name).not.toContain(selector.parameter);
          expect(binding.arguments, tool.name).not.toContain('resource');
          if (binding.operation) expect(binding.arguments, tool.name).not.toContain('operation');
        }
      });

      it('matches the snapshot of its tool list', () => {
        expect(tools.map((t) => `${t.name} ro=${+t.annotations.readOnlyHint} d=${+t.annotations.destructiveHint} i=${+t.annotations.idempotentHint} [${t._meta[MCP_TOOL_META_KEY].arguments.join(',')}]`)).toMatchSnapshot();
      });
    });
  }
});
