/**
 * A tiny node plugin for the one-node local override (docs/specs/19-debug-token.md), served over HTTP on a port you choose.
 * `debugdemo.shout` turns `text` into a shout. Two builds of the same plugin:
 *
 * - `buggy`: the build "in production": it throws for a text with a digit in it (the failure to debug).
 * - `fixed`: the build on the developer's laptop: it handles it.
 *
 * Both record what they were sent, so a test can check what the host handed to the local plugin (and that it held no credentials).
 *
 *   tsx apps/web/test/fixtures/debug-demo-main.ts <port> <buggy|fixed>
 */
import type { Server } from 'node:http';
import { defineNode, definePlugin } from '@landflow/sdk';
import { serveHttp } from '@landflow/sdk/http';

export type DemoVariant = 'buggy' | 'fixed';

export function demoPlugin(variant: DemoVariant, seen: unknown[] = []) {
  return definePlugin({
    info: { id: 'debugdemo', name: `Debug demo (${variant})`, version: variant === 'fixed' ? '1.0.1-local' : '1.0.0', language: 'typescript' },
    nodes: [
      defineNode({
        description: {
          name: 'shout',
          displayName: 'Shout',
          description: 'Turn text into a shout',
          version: 1,
          kind: 'action',
          inputs: [{ type: 'main' }],
          outputs: [{ type: 'main' }],
          properties: [{ name: 'suffix', displayName: 'Suffix', type: 'string', default: '!' }],
        },
        async execute(ctx) {
          const items = ctx.getInputData();
          seen.push({ parameters: ctx.getNodeParameter('suffix', 0), items: items.map((i) => i.json), credentials: (ctx as unknown as { credentials?: unknown }).credentials });
          return [
            items.map((item) => {
              const text = String(item.json.text ?? '');
              if (variant === 'buggy' && /\d/.test(text)) throw new Error(`shout cannot handle digits (got “${text}”)`);
              return { json: { shouted: `${text.toUpperCase()}${ctx.getNodeParameter('suffix', 0)}`, build: variant } };
            }),
          ];
        },
      }),
    ],
  });
}

export async function startDemoPlugin(options: { port?: number; variant: DemoVariant; host?: string }): Promise<{ url: string; port: number; seen: unknown[]; close: () => Promise<void> }> {
  const seen: unknown[] = [];
  const server: Server = await serveHttp(demoPlugin(options.variant, seen), { port: options.port ?? 0, host: options.host ?? '127.0.0.1' });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 0);
  return { url: `http://127.0.0.1:${port}`, port, seen, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
