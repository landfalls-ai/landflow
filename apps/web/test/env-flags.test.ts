/** The flag values the migrated parsers accept (they moved onto envFlag, which changed a few values). */
import { afterEach, describe, expect, it } from 'vitest';
import { smtpConfig } from '../src/lib/server/auth/mail';
import { samlConfig } from '../src/lib/server/auth/saml';
import { s3OptionsFromEnv } from '../src/lib/server/binary/s3';
import { localAllowed } from '../src/lib/server/marketplace/sources';

const NAMES = ['LANDFLOW_SMTP_HOST', 'LANDFLOW_SMTP_PORT', 'LANDFLOW_SMTP_SECURE', 'LANDFLOW_MARKETPLACE_ALLOW_LOCAL', 'LANDFLOW_SAML_ENTRY_POINT', 'LANDFLOW_SAML_IDP_CERT', 'LANDFLOW_SAML_IDP_METADATA_URL', 'LANDFLOW_SAML_JIT', 'LANDFLOW_SAML_CREATE_PROJECTS', 'LANDFLOW_SAML_WANT_ASSERTIONS_SIGNED'];
afterEach(() => {
  for (const n of NAMES) delete process.env[n];
});

describe('S3 path style', () => {
  const base = { LANDFLOW_S3_BUCKET: 'b' };
  it('is on by default and for true, off for 0 / no / off / FALSE, default for garbage', () => {
    expect(s3OptionsFromEnv(base).forcePathStyle).toBe(true);
    for (const v of ['0', 'no', 'off', 'FALSE', 'false']) expect(s3OptionsFromEnv({ ...base, LANDFLOW_S3_FORCE_PATH_STYLE: v }).forcePathStyle, v).toBe(false);
    for (const v of ['1', 'true', 'yes']) expect(s3OptionsFromEnv({ ...base, LANDFLOW_S3_FORCE_PATH_STYLE: v }).forcePathStyle, v).toBe(true);
    expect(s3OptionsFromEnv({ ...base, LANDFLOW_S3_FORCE_PATH_STYLE: 'garbage' }).forcePathStyle).toBe(true);
  });
});

describe('SMTP secure', () => {
  it('takes 1 / yes / on, and follows the port (465) when unset', () => {
    process.env.LANDFLOW_SMTP_HOST = 'mail.test';
    for (const v of ['1', 'yes', 'on', 'true']) {
      process.env.LANDFLOW_SMTP_SECURE = v;
      expect(smtpConfig()?.secure, v).toBe(true);
    }
    delete process.env.LANDFLOW_SMTP_SECURE;
    process.env.LANDFLOW_SMTP_PORT = '465';
    expect(smtpConfig()?.secure).toBe(true);
    process.env.LANDFLOW_SMTP_PORT = '587';
    expect(smtpConfig()?.secure).toBe(false);
    delete process.env.LANDFLOW_SMTP_PORT;
    expect(smtpConfig()?.secure).toBe(false);
  });
});

describe('marketplace local directories', () => {
  it('are allowed by 1 / true / yes / on, and not by default, 0 or garbage', () => {
    expect(localAllowed()).toBe(false);
    for (const v of ['1', 'true', 'yes', 'on']) {
      process.env.LANDFLOW_MARKETPLACE_ALLOW_LOCAL = v;
      expect(localAllowed(), v).toBe(true);
    }
    for (const v of ['0', 'false', 'garbage']) {
      process.env.LANDFLOW_MARKETPLACE_ALLOW_LOCAL = v;
      expect(localAllowed(), v).toBe(false);
    }
  });
});

describe('SAML flags', () => {
  it('take their default for an unparseable value', () => {
    process.env.LANDFLOW_SAML_IDP_METADATA_URL = 'https://idp.test/metadata';
    process.env.LANDFLOW_SAML_JIT = 'garbage';
    process.env.LANDFLOW_SAML_CREATE_PROJECTS = 'garbage';
    process.env.LANDFLOW_SAML_WANT_ASSERTIONS_SIGNED = 'garbage';
    expect(samlConfig()).toMatchObject({ jit: true, createProjects: false, wantAssertionsSigned: true });
    process.env.LANDFLOW_SAML_JIT = 'off';
    process.env.LANDFLOW_SAML_CREATE_PROJECTS = 'on';
    expect(samlConfig()).toMatchObject({ jit: false, createProjects: true });
  });
});
