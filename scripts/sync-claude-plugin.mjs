#!/usr/bin/env node
// Keeps .claude/skills and .claude/agents in step with claude-plugins/landflow-dev, the source.
//   node scripts/sync-claude-plugin.mjs --check   fail when a copy differs or is missing
//   node scripts/sync-claude-plugin.mjs --write   copy the plugin's skills and agents into .claude/
// Only what the plugin has is touched: the contributor agents and the landflow-feature skill are not part of it.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "claude-plugins/landflow-dev");
const target = join(root, ".claude");
const mode = process.argv[2];
if (mode !== "--check" && mode !== "--write") {
  console.error("usage: sync-claude-plugin.mjs --check | --write");
  process.exit(2);
}

/** Every file under dir, as paths relative to it. */
function files(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...files(full).map((f) => join(name, f)));
    else out.push(name);
  }
  return out;
}

// Each plugin file maps to the same relative path under .claude/.
const folders = ["skills", "agents"];
const problems = [];
let copied = 0;
for (const folder of folders) {
  const srcDir = join(source, folder);
  if (!existsSync(srcDir)) continue;
  for (const rel of files(srcDir)) {
    const src = join(srcDir, rel);
    const dst = join(target, folder, rel);
    const same = existsSync(dst) && readFileSync(src).equals(readFileSync(dst));
    if (same) continue;
    if (mode === "--write") {
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(src, dst);
      copied++;
    } else {
      problems.push(`${existsSync(dst) ? "differs" : "missing"}: ${relative(root, dst)}`);
    }
  }
}

if (mode === "--write") {
  console.log(`sync-claude-plugin: copied ${copied} file(s)`);
} else if (problems.length) {
  console.error(problems.join("\n"));
  console.error("sync-claude-plugin: copies are out of step. Edit claude-plugins/landflow-dev, then run: node scripts/sync-claude-plugin.mjs --write");
  process.exit(1);
} else {
  console.log("sync-claude-plugin: .claude copies match claude-plugins/landflow-dev");
}
