/**
 * For join tests: a `fetch` that sends a client helper's request (lib/client/*, which calls `fetch('/api/…')`) to the real
 * route handler, so a screen's helper and the server's route are tested together without a running host.
 * Install with `vi.stubGlobal('fetch', routeFetch([...]))`.
 */
type Handler = (request: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
type RouteModule = Partial<Record<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', unknown>>;

/** `routes`: pairs of a path pattern (`/api/projects/:id/budget`) and the route module. */
export function routeFetch(routes: Array<[string, RouteModule]>, base = 'http://landflow.test') {
  const compiled = routes.map(([pattern, module]) => {
    const names: string[] = [];
    const source = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, (_, name: string) => {
      names.push(name);
      return '([^/]+)';
    });
    return { regex: new RegExp(`^${source}$`), names, module };
  });
  return async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, base);
    const method = (init.method ?? 'GET').toUpperCase() as keyof RouteModule;
    for (const route of compiled) {
      const match = route.regex.exec(url.pathname);
      if (!match) continue;
      const handler = route.module[method] as Handler | undefined;
      if (!handler) return new Response(JSON.stringify({ error: `No ${method} on ${url.pathname}` }), { status: 405 });
      const params = Object.fromEntries(route.names.map((name, i) => [name, decodeURIComponent(match[i + 1])]));
      const { cache: _cache, ...rest } = init;
      return handler(new Request(url.href, rest), { params: Promise.resolve(params) });
    }
    throw new Error(`join-fetch: no route for ${method} ${url.pathname}`);
  };
}
