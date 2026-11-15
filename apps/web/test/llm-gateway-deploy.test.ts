/**
 * The LiteLLM deployment files (docs/llm-gateway.md "Run it"): the image pinned by digest to a release after the 21 October
 * 2026 compromise, loopback-only ports, no real keys, the model list, and the Kubernetes example in landflow-dev.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, parseAllDocuments } from 'yaml';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..', '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');
const compose = parse(read('deploy/compose.infra.yml')) as { services: Record<string, any> };
const gateway = compose.services['llm-gateway'];
const IMAGE = /^ghcr\.io\/berriai\/litellm:([^@]+)@sha256:([0-9a-f]{64})$/;
const FORBIDDEN = /^(v1\.107\.0(-.*)?|latest|main-latest|main-stable|.*-nightly.*|.*-dev.*)$/;

function envOf(service: { environment?: Record<string, string> | string[] }): Record<string, string> {
  const e = service.environment ?? {};
  if (!Array.isArray(e)) return Object.fromEntries(Object.entries(e).map(([k, v]) => [k, String(v)]));
  return Object.fromEntries(e.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}

describe('LiteLLM compose service', () => {
  it('pins a release by digest, never a forbidden tag', () => {
    const m = IMAGE.exec(gateway.image);
    expect(m).not.toBeNull();
    expect(m![1]).not.toMatch(FORBIDDEN);
  });

  it('uses the same image in the Kubernetes example', () => {
    const docs = parseAllDocuments(read('deploy/k8s/examples/llm-gateway/litellm.yaml')).map((d) => d.toJSON());
    const dep = docs.find((d) => d.kind === 'Deployment');
    expect(dep.spec.template.spec.containers[0].image).toBe(gateway.image);
  });

  it('publishes only on loopback', () => {
    expect(gateway.ports.length).toBeGreaterThan(0);
    for (const p of gateway.ports) expect(String(p).startsWith('127.0.0.1:')).toBe(true);
  });

  it('is in the llm-gateway profile with its database, telemetry off and no real keys', () => {
    expect(gateway.profiles).toEqual(['llm-gateway']);
    expect(compose.services['llm-gateway-db'].profiles).toEqual(['llm-gateway']);
    const env = envOf(gateway);
    expect(env.DATABASE_URL).toMatch(/\/litellm$/);
    expect(env.LITELLM_TELEMETRY_DISABLED).toBe('true');
    for (const v of Object.values(env)) {
      expect(v).not.toMatch(/sk-ant-|sk-proj-/);
      const sk = /sk-[A-Za-z0-9-]{40,}/.exec(v);
      if (sk) expect(sk[0]).toContain('landflow-dev');
    }
  });
});

describe('LiteLLM config', () => {
  const cfg = parse(read('deploy/llm-gateway/config.yaml')) as any;
  const k8s = parse(read('deploy/k8s/examples/llm-gateway/config.yaml')) as any;

  it('lists Ollama models behind ollama_chat/', () => {
    for (const m of cfg.model_list) {
      expect(m.litellm_params.model.startsWith('ollama_chat/')).toBe(true);
      expect(m.litellm_params.api_base).toBe('http://host.docker.internal:11434');
    }
    const names = cfg.model_list.map((m: any) => m.model_name);
    expect(names).toContain('qwen3-coder:30b');
    expect(names).toContain('qwen3.8');
  });

  it('drops unsupported params and reads secrets from the environment', () => {
    expect(cfg.litellm_settings.drop_params).toBe(true);
    expect(cfg.general_settings.master_key).toMatch(/^os\.environ\//);
    expect(cfg.general_settings.database_url).toMatch(/^os\.environ\//);
  });

  it('reaches the host as host.internal in the cluster', () => {
    for (const m of k8s.model_list) expect(m.litellm_params.api_base).toBe('http://host.internal:11434');
  });
});

describe('Kubernetes example', () => {
  it('stays in landflow-dev and creates no namespace', () => {
    const dir = join(root, 'deploy/k8s/examples/llm-gateway');
    expect(parse(read('deploy/k8s/examples/llm-gateway/kustomization.yaml')).namespace).toBe('landflow-dev');
    expect(existsSync(join(dir, 'llm-gateway.yaml'))).toBe(false);
    for (const f of readdirSync(dir)) expect(readFileSync(join(dir, f), 'utf8')).not.toMatch(/^kind:\s*Namespace\s*$/m);
  });
});

describe('.env.example', () => {
  const env = read('deploy/.env.example');
  it('has the LiteLLM variables and no admin port', () => {
    for (const k of ['PORT', 'MASTER_KEY', 'SALT_KEY', 'UI_USERNAME', 'UI_PASSWORD']) {
      expect(env).toMatch(new RegExp(`^LANDFLOW_LLM_GATEWAY_${k}=`, 'm'));
    }
    expect(env).not.toContain('LANDFLOW_LLM_GATEWAY_ADMIN_PORT');
  });
});
