/** Real marks for the apps: every listed brand has one in brand-icons.ts and in its plugin's icon file; every plugin icon resolves. */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRANDS, brandOf, brandOfApp, type Brand } from '../src/lib/shared/brand-icons';

const root = join(__dirname, '..', '..', '..');

/** Each brand and the plugin icon files that stand for it (relative to the repository root). */
const PLUGIN_ICONS: Record<string, string[]> = {
  linear: ['plugins/linear/icons/linear.svg'],
  slack: ['plugins/messaging/icons/slack.svg', 'plugins/messaging/icons/slack-trigger.svg'],
  discord: ['plugins/messaging/icons/discord.svg'],
  telegram: ['plugins/messaging/icons/telegram.svg', 'plugins/messaging/icons/telegram-trigger.svg'],
  whatsapp: ['plugins/messaging/icons/whatsapp.svg'],
  twilio: ['plugins/messaging/icons/twilio.svg'],
  gmail: ['plugins/google-workspace/icons/gmail.svg'],
  googlecalendar: ['plugins/google-workspace/icons/calendar.svg'],
  googledocs: ['plugins/google-workspace/icons/docs.svg'],
  googledrive: ['plugins/google-workspace/icons/drive.svg'],
  googlesheets: ['plugins/google-workspace/icons/sheets.svg'],
  google: ['plugins/google-workspace/icons/google-workspace.svg'],
  github: ['plugins/github/icons/github.svg', 'plugins/productivity/productivity/icons/github.svg'],
  grafana: ['plugins/grafana/icons/grafana.svg', 'plugins/grafana/icons/get-alerts.svg', 'plugins/grafana/icons/get-alert-details.svg', 'plugins/grafana/icons/acknowledge-alert.svg'],
  attio: ['plugins/attio/icons/attio.svg', 'plugins/attio/icons/attio-trigger.svg'],
  fathom: ['plugins/fathom/icons/fathom.svg'],
  notion: ['plugins/productivity/productivity/icons/notion.svg'],
  jira: ['plugins/productivity/productivity/icons/jira.svg'],
  airtable: ['plugins/productivity/productivity/icons/airtable.svg'],
  hubspot: ['plugins/productivity/productivity/icons/hubspot.svg'],
  stripe: ['plugins/productivity/productivity/icons/stripe.svg'],
  rss: ['plugins/productivity/productivity/icons/rss.svg'],
  mysql: ['plugins/databases/icons/mysql.svg'],
  postgresql: ['plugins/databases/icons/postgres.svg', 'plugins/databases/icons/postgres-trigger.svg'],
  redis: ['plugins/databases/icons/redis.svg'],
  sqlite: ['plugins/databases/icons/sqlite.svg', 'plugins/databases/icons/sqlite-trigger.svg'],
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.venv' || name === 'dist' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

describe('brand marks', () => {
  it('has a real mark for every listed app', () => {
    for (const brand of Object.keys(PLUGIN_ICONS)) {
      const mark = BRANDS[brand as Brand];
      expect(mark, brand).toBeDefined();
      expect(mark.paths.length, brand).toBeGreaterThan(0);
      expect(mark.viewBox, brand).toMatch(/^-?\d+ -?\d+ \d+ \d+$/);
      // A black mark has no colour (it takes the text colour); any other has its brand colour.
      if (mark.color) expect(mark.color, brand).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it('resolves `brand:<slug>` icons and the app a name stands for', () => {
    expect(brandOf('brand:linear')).toBe('linear');
    expect(brandOf('brand:nope')).toBeUndefined();
    expect(brandOfApp('Linear')).toBe('linear');
    expect(brandOfApp('slack-trigger')).toBe('slack');
    expect(brandOfApp('Google Calendar')).toBe('googlecalendar');
    expect(brandOfApp('google-sheets')).toBe('googlesheets');
    expect(brandOfApp('Google Workspace')).toBe('google');
    expect(brandOfApp('Postgres')).toBe('postgresql');
    expect(brandOfApp('Slackline')).toBeUndefined();
    expect(brandOfApp(undefined)).toBeUndefined();
  });

  it('gives every plugin icon file of a listed app a real mark, not an original glyph', () => {
    for (const [brand, files] of Object.entries(PLUGIN_ICONS)) {
      for (const file of files) {
        const path = join(root, file);
        expect(existsSync(path), file).toBe(true);
        const svg = readFileSync(path, 'utf8');
        expect(svg, file).not.toMatch(/original (landflow )?glyph|not [a-z ]+'s logo/i);
        // Marks made by scripts/brand-icon.mjs carry the brand's own path.
        if (/mark, source in brand-icons\.ts/.test(svg)) expect(svg, `${file} (${brand})`).toContain(BRANDS[brand as Brand].paths[0]);
      }
    }
  });

  it('points every plugin node and plugin at an icon file that exists', () => {
    const missing: string[] = [];
    for (const plugin of readdirSync(join(root, 'plugins'))) {
      const dir = join(root, 'plugins', plugin);
      if (!statSync(dir).isDirectory()) continue;
      const files = walk(dir);
      const have = new Set(files.filter((f) => f.endsWith('.svg') && f.includes('/icons/')).map((f) => basename(f)));
      for (const file of files.filter((f) => /\.(ts|py|go)$/.test(f) && !/\/(test|tests)\//.test(f) && !/_test\.go$/.test(f))) {
        for (const m of readFileSync(file, 'utf8').matchAll(/['"]file:(?:icons\/)?([a-z0-9-]+\.svg)['"]/g)) if (!have.has(m[1])) missing.push(`${plugin}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
