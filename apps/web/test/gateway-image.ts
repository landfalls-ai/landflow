/**
 * Runs Python inside the pinned LiteLLM image (the gateway's own runtime) for the wave 12 join tests: the gateway's
 * callback (`deploy/llm-gateway/custom_callbacks.py`) is mounted read-only, the input is a JSON file, the answer is the
 * last line the script prints. Always offline (`--network none`), always by digest (the tag alone would pull), always on
 * the OrbStack engine. Skipped unless `LANDFLOW_INTEGRATION` names `gateway-image` (docs/development.md).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const GATEWAY_IMAGE = 'ghcr.io/berriai/litellm:v1.108.2-lts@sha256:d8b4ac356743d647a13bb93f45b941fcd5f5354122cfd205948a1b192790389d';
export const gatewayImageEnabled = (process.env.LANDFLOW_INTEGRATION ?? '').split(',').includes('gateway-image');
export const REPO_ROOT = join(process.cwd(), '..', '..');

/** Runs `script` with `/in/input.json` holding `input`; returns the JSON of the script's last printed line. */
export function runInGatewayImage<T>(script: string, input: unknown): T {
  const dir = mkdtempSync(join(tmpdir(), 'landflow-gateway-image-'));
  try {
    writeFileSync(join(dir, 'input.json'), JSON.stringify(input));
    writeFileSync(join(dir, 'script.py'), script);
    const out = execFileSync(
      'docker',
      ['--context', 'orbstack', 'run', '--rm', '--network', 'none', '-e', 'LITELLM_LOCAL_MODEL_COST_MAP=True', '-e', 'PYTHONDONTWRITEBYTECODE=1', '-v', `${join(REPO_ROOT, 'deploy', 'llm-gateway')}:/w:ro`, '-v', `${dir}:/in:ro`, '-w', '/w', '--entrypoint', 'python', GATEWAY_IMAGE, '/in/script.py'],
      { encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const lines = out.trim().split('\n');
    return JSON.parse(lines[lines.length - 1]!) as T;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The script header every join script starts with: the callback module from /w, the input from /in. */
export const PY_HEADER = `import json, sys
sys.path.insert(0, "/w")
import custom_callbacks as cc
with open("/in/input.json", encoding="utf-8") as f:
    INPUT = json.load(f)
`;
