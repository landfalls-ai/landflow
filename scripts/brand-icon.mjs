#!/usr/bin/env node
/**
 * Brand marks for apps (docs/plugins.md#branding-and-real-marks).
 *
 *   node scripts/brand-icon.mjs entry <simple-icons-dir> <slug> [key]
 *       Prints a ready `BRANDS` line for apps/web/src/lib/shared/brand-icons.ts from an unpacked Simple Icons package
 *       (`npm pack simple-icons@16.36.0` into an empty directory, then extract it): the mark's path and its brand colour.
 *       A black mark prints without a colour (it takes the text colour).
 *   node scripts/brand-icon.mjs tile <key> <out.svg> [--trigger]
 *       Writes a plugin icon from a `BRANDS` mark: the mark in its brand colour on a white rounded tile, 48x48, the shape
 *       of the plugins' other icons. --trigger adds the amber bolt a trigger node wears.
 *
 * Simple Icons is CC0; record where each mark came from in the comment above its `BRANDS` line.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , mode, ...args] = process.argv;
const BOLT = '<circle cx="38" cy="38" r="9" fill="#fbbf24" stroke="#fff" stroke-width="2"/>\n  <path d="M39.5 31.5 34 39h4l-1.5 5.5L42 37h-4Z" fill="#1f2937"/>';

function entry([dir, slug, key = slug]) {
  const svg = readFileSync(join(dir, 'icons', `${slug}.svg`), 'utf8');
  const title = /<title>([^<]*)<\/title>/.exec(svg)?.[1]?.replace(/&amp;/g, '&') ?? slug;
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1] ?? '0 0 24 24';
  const paths = [...svg.matchAll(/<path[^>]* d="([^"]+)"/g)].map((m) => m[1]);
  const data = JSON.parse(readFileSync(join(dir, 'data', 'simple-icons.json'), 'utf8'));
  const hex = data.find((x) => x.slug === slug)?.hex ?? svg.match(/fill="#([0-9a-fA-F]{6})"/)?.[1];
  const dark = hex && /^[0-9a-f]{6}$/i.test(hex) && [0, 2, 4].every((i) => parseInt(hex.slice(i, i + 2), 16) < 0x30);
  const color = hex && !dark ? `, color: '#${hex.toUpperCase()}'` : '';
  console.log(`  ${key}: { title: ${JSON.stringify(title)}, viewBox: '${viewBox}', paths: ${JSON.stringify(paths)}${color} },`);
}

async function tile([key, out, flag]) {
  const { BRANDS } = await import(new URL('../apps/web/src/lib/shared/brand-icons.ts', import.meta.url).href);
  const mark = BRANDS[key];
  if (!mark) throw new Error(`no brand "${key}" in brand-icons.ts`);
  const [x, y, w, h] = mark.viewBox.split(/\s+/).map(Number);
  const trigger = flag === '--trigger';
  const box = trigger ? 26 : 30;
  const at = trigger ? 8 : 9;
  const scale = box / Math.max(w, h);
  const dx = at + (box - w * scale) / 2 - x * scale;
  const dy = at + (box - h * scale) / 2 - y * scale;
  const fill = mark.color ?? '#111111';
  const paths = mark.paths.map((d) => `<path d="${d}"${mark.evenOdd ? ' fill-rule="evenodd"' : ''}/>`).join('');
  writeFileSync(
    out,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  <!-- ${mark.title} mark, source in brand-icons.ts -->
  <rect x="0.75" y="0.75" width="46.5" height="46.5" rx="11.25" fill="#fff" stroke="#e4e4e7" stroke-width="1.5"/>
  <g transform="translate(${dx.toFixed(3)} ${dy.toFixed(3)}) scale(${scale.toFixed(5)})" fill="${fill}">${paths}</g>
  ${trigger ? BOLT : ''}
</svg>
`,
  );
}

if (mode === 'entry') entry(args);
else if (mode === 'tile') await tile(args);
else {
  console.error('usage: brand-icon.mjs entry <simple-icons-dir> <slug> [key] | tile <key> <out.svg> [--trigger]');
  process.exit(1);
}
