'use client';
import { Segmented } from '@/components/ui/segmented';
import { Fragment, useState } from 'react';
import { Check, Copy, FileCode2, Radio, Server, Workflow } from 'lucide-react';
import { cn } from '@/lib/utils';
import { languageMeta } from '@/lib/client/format';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { TransportBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const SAMPLES = {
  typescript: {
    file: 'plugins/text-toolkit/src/nodes/slugify.ts',
    run: 'pnpm plugin:ts            # HTTP :7101 + gRPC :7201',
    code: `import { definePlugin, NodeOperationError, type IExecuteContext, type INodeType } from '@landflow/sdk';
import { serve } from '@landflow/sdk/serve';

// 1. Implement the interface — description is plain JSON, behaviour is a method.
export class Slugify implements INodeType {
  description = {
    name: 'slugify', displayName: 'Slugify', description: 'Turn text into a URL-safe slug',
    version: 1, kind: 'action', icon: 'lucide:link-2', color: '#60a5fa',
    inputs: [{ type: 'main' }], outputs: [{ type: 'main' }],
    usableAsTool: true, // AI agents can call it
    properties: [{ name: 'field', displayName: 'Field', type: 'string', default: 'text' }],
  } as const;

  execute(ctx: IExecuteContext) {
    return ctx.getInputData().map((item, i) => {
      const value = item.json[ctx.getNodeParameter<string>('field', i)];
      if (typeof value !== 'string') throw new NodeOperationError('Not a string', { itemIndex: i });
      return { json: { ...item.json, slug: slugify(value) } };
    });
  }
}

// 2. Serve it — HTTP and/or gRPC. 3. It announces itself and heartbeats.
await serve(definePlugin({ info: { id: 'text-toolkit', name: 'Text Toolkit', version: '0.1.0' }, nodes: [new Slugify()] }),
  { http: 7101, grpc: 7201 });`,
  },
  python: {
    file: 'plugins/py-insights/insights/sentiment.py',
    run: './setup.sh && .venv/bin/python main.py   # HTTP :7102 + gRPC :7202',
    code: `from landflow_sdk import Node, NodeOperationError, Plugin, serve

# 1. Implement the interface: an abstract base class with \`description\` + \`execute\`.
class Sentiment(Node):
    description = {
        "name": "sentiment", "displayName": "Sentiment", "version": 1, "kind": "action",
        "description": "Score the sentiment of a text field",
        "icon": "lucide:smile", "inputs": [{"type": "main"}], "outputs": [{"type": "main"}],
        "usableAsTool": True,
        "properties": [{"name": "field", "displayName": "Text Field", "type": "string", "default": "text"}],
    }

    def execute(self, ctx):
        out = []
        for i, item in enumerate(ctx.get_input_data()):
            text = item["json"].get(ctx.get_node_parameter("field", i))
            if text is None:
                raise NodeOperationError(f"Item {i} has no text", item_index=i)
            out.append({"json": {**item["json"], "sentiment": score_text(text)}})
        return [out]

# 2. Serve it (stdlib HTTP; gRPC when grpcio is installed). 3. Auto-announce + heartbeat.
serve(Plugin(id="py-insights", name="Insights", version="0.1.0", nodes=[Sentiment()]),
      http_port=7102, grpc_port=7202)`,
  },
  go: {
    file: 'plugins/go-crypto/hash.go',
    run: 'go run .                  # HTTP :7103 + gRPC :7203',
    code: `package main

import landflow "github.com/landflow/landflow/sdks/go"

// 1. Implement the interface: Description() + Execute().
type HashNode struct{}

func (HashNode) Description() landflow.NodeDescriptor {
	return landflow.NodeDescriptor{
		Name: "hash", DisplayName: "Hash", Description: "Hash a field with SHA-256",
		Version: landflow.V(1), Kind: landflow.KindAction, Icon: "lucide:fingerprint",
		Inputs:  []landflow.PortDescriptor{landflow.MainPort()},
		Outputs: []landflow.PortDescriptor{landflow.MainPort()},
		UsableAsTool: true,
		Properties: []landflow.PropertyDescriptor{
			{Name: "field", DisplayName: "Field", Type: landflow.PropString, Default: "value"},
		},
	}
}

func (HashNode) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	var out []landflow.Item
	for i, item := range ctx.InputData(0) {
		field := ctx.ParamString("field", i, "value")
		out = append(out, landflow.Item{JSON: with(item.JSON, "hash", sha256Hex(item.JSON[field]))})
	}
	return [][]landflow.Item{out}, nil
}

// 2. Serve over HTTP + gRPC. 3. Announce to the registry (HTTP or grpc://host:7070).
func main() {
	p := landflow.NewPlugin(landflow.PluginInfo{ID: "go-crypto", Name: "Crypto Toolkit", Version: "0.1.0"}, HashNode{})
	landflow.Serve(context.Background(), p, landflow.ServeOptions{HTTPPort: 7103, GRPCPort: 7203})
}`,
  },
} as const;

/** Credentials, a polling trigger and observability, per SDK. */
const ADVANCED = {
  typescript: `import { defineCredentialType, definePlugin, pollIntervalProperty, type IExecuteContext, type INodeType } from '@landflow/sdk';

// A credential type: the host renders the form, encrypts the values and offers "Test connection".
const feedApi = defineCredentialType<{ apiKey: string; baseUrl: string }>({
  name: 'feedApi', displayName: 'Feed API',
  properties: [
    { name: 'apiKey', displayName: 'API Key', type: 'string', required: true, typeOptions: { password: true } },
    { name: 'baseUrl', displayName: 'Base URL', type: 'string', default: 'https://api.example.com' },
  ],
  async test({ apiKey, baseUrl }, ctx) {
    const res = await ctx.http(\`\${baseUrl}/me\`, { headers: { authorization: \`Bearer \${apiKey}\` } });
    return res.ok ? { ok: true } : { ok: false, message: \`HTTP \${res.status}\` };
  },
});

// A polling trigger: the host calls it every pollInterval seconds with the state it returned last time.
export class NewEntries implements INodeType {
  description = {
    name: 'newEntries', displayName: 'New Entries', description: 'Starts the workflow when entries are added',
    version: 1, kind: 'trigger', triggerSource: 'poll', inputs: [], outputs: [{ type: 'main' }],
    credentials: [{ name: 'feedApi', required: true }],
    properties: [pollIntervalProperty(60)],
  } as const;

  async execute(ctx: IExecuteContext) {
    const { apiKey, baseUrl } = ctx.getCredentials<{ apiKey: string; baseUrl: string }>('feedApi');
    // ctx.http is fetch with a client span; the host's trace continues into the API call.
    const entries: { id: number }[] = await ctx.span('feed.list', { 'feed.page_size': 50 }, async () =>
      (await ctx.http(\`\${baseUrl}/entries?limit=50\`, { headers: { authorization: \`Bearer \${apiKey}\` } })).json());
    const newest = Math.max(0, ...entries.map((e) => e.id));
    if (ctx.mode === 'manual') return entries.slice(0, 5).map((json) => ({ json })); // Execute in the editor
    if (ctx.isFirstPoll()) { ctx.setPollState({ lastId: newest }); return []; } // baseline: no items
    const { lastId } = ctx.getPollState<{ lastId: number }>()!;
    const fresh = entries.filter((e) => e.id > lastId);
    ctx.setPollState({ lastId: Math.max(lastId, newest) });
    ctx.metrics.counter('feed.entries.new').add(fresh.length); // custom metric: landflow.feed.entries.new
    return fresh.map((json) => ({ json }));
  }
}

await serve(definePlugin({ info: { id: 'feed', name: 'Feed', version: '0.1.0' }, nodes: [new NewEntries()], credentialTypes: [feedApi] }), { http: 7150 });`,
  python: `from landflow_sdk import CredentialType, Node, Plugin, poll_interval_property, serve

# A credential type: the host renders the form, encrypts the values and offers "Test connection".
def test_feed(data, ctx):
    r = ctx.http.get(f"{data['baseUrl']}/me", headers={"Authorization": f"Bearer {data['apiKey']}"})
    return (True, "connected") if r.ok else (False, f"HTTP {r.status}")

FEED_API = CredentialType(name="feedApi", display_name="Feed API", test=test_feed, properties=[
    {"name": "apiKey", "displayName": "API Key", "type": "string", "required": True, "typeOptions": {"password": True}},
    {"name": "baseUrl", "displayName": "Base URL", "type": "string", "default": "https://api.example.com"},
])

# A polling trigger: the host calls it every pollInterval seconds with the state it returned last time.
class NewEntries(Node):
    description = {"name": "newEntries", "displayName": "New Entries", "version": 1, "kind": "trigger",
                   "triggerSource": "poll", "inputs": [], "outputs": [{"type": "main"}],
                   "credentials": [{"name": "feedApi", "required": True}],
                   "properties": [poll_interval_property(default_seconds=60)]}

    def execute(self, ctx):
        c = ctx.get_credentials("feedApi")
        # ctx.http opens a client span; the host's trace continues into the API call.
        with ctx.span("feed.list", {"feed.page_size": 50}):
            entries = ctx.http.get(f"{c['baseUrl']}/entries", params={"limit": 50},
                                   headers={"Authorization": f"Bearer {c['apiKey']}"}).json
        newest = max((e["id"] for e in entries), default=0)
        if ctx.mode == "manual":            # Execute in the editor: recent items, no state
            return [{"json": e} for e in entries[:5]]
        if ctx.is_first_poll():             # baseline: no items
            ctx.set_poll_state({"lastId": newest}); return []
        last = ctx.get_poll_state()["lastId"]
        fresh = [e for e in entries if e["id"] > last]
        ctx.set_poll_state({"lastId": max(last, newest)})
        ctx.metrics.counter("feed.entries.new").add(len(fresh))  # landflow.feed.entries.new
        return [{"json": e} for e in fresh]

serve(Plugin("feed", "Feed", "0.1.0", nodes=[NewEntries()], credential_types=[FEED_API]), http_port=7150)`,
  go: `// A credential type: the host renders the form, encrypts the values and offers "Test connection".
var feedAPI = landflow.CredentialType{Name: "feedApi", DisplayName: "Feed API",
	Properties: []landflow.PropertyDescriptor{
		{Name: "apiKey", DisplayName: "API Key", Type: landflow.PropString, Required: true, TypeOptions: &landflow.TypeOptions{Password: true}},
		{Name: "baseUrl", DisplayName: "Base URL", Type: landflow.PropString, Default: "https://api.example.com"},
	},
	Test: func(ctx context.Context, d landflow.CredentialData) (bool, string) {
		resp, err := get(ctx, d.String("baseUrl")+"/me", d.String("apiKey"))
		if err != nil { return false, err.Error() }
		return resp.StatusCode == 200, resp.Status
	},
}

// A polling trigger: TriggerSource poll + a pollInterval property.
func (NewEntries) Execute(ctx *landflow.ExecuteContext) ([][]landflow.Item, error) {
	creds, err := ctx.RequireCredentials("feedApi")
	if err != nil { return nil, err }
	var entries []Entry
	// The context is a context.Context carrying the span: HTTPClient(span) nests under it.
	err = ctx.Span("feed.list", landflow.Attrs{"feed.page_size": 50}, func(span landflow.Span) error {
		entries, err = list(landflow.HTTPClient(span), creds.String("baseUrl"), creds.String("apiKey"))
		return err
	})
	if err != nil { return nil, err }
	if ctx.Mode() == landflow.ModeManual { return items(entries[:min(5, len(entries))]), nil }
	newest := maxID(entries)
	if ctx.IsFirstPoll() { ctx.SetPollState(map[string]any{"lastId": newest}); return nil, nil }
	last := int(ctx.PollState()["lastId"].(float64))
	fresh := newer(entries, last)
	ctx.SetPollState(map[string]any{"lastId": max(last, newest)})
	ctx.Metrics().Counter("feed.entries.new").Add(float64(len(fresh))) // landflow.feed.entries.new
	return items(fresh), nil
}

// Database calls get a db.query client span: ctx.DBSpan(landflow.DBSpanInfo{System: "postgresql", ...}, fn)`,
} as const;

type Lang = keyof typeof SAMPLES;

const KEYWORDS = /\b(import|from|export|class|implements|return|const|let|await|async|new|throw|if|for|of|in|def|self|raise|func|package|type|struct|var|range|nil|True|False|None|as)\b/g;

function highlight(code: string) {
  // Tokenize comments and strings first so keywords inside them stay untouched.
  const parts = code.split(/(\/\/[^\n]*|#[^\n]*|`[^`]*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g);
  return parts.map((part, i) => {
    if (/^(\/\/|#)/.test(part)) return <span key={i} className="text-t3">{part}</span>;
    if (/^["'`]/.test(part)) return <span key={i} className="text-gn">{part}</span>;
    const pieces = part.split(KEYWORDS);
    return (
      <Fragment key={i}>
        {pieces.map((piece, j) => (j % 2 === 1 ? <span key={j} className="font-semibold">{piece}</span> : <span key={j}>{piece}</span>))}
      </Fragment>
    );
  });
}

const LIFECYCLE = [
  { icon: Server, title: 'Start', text: 'Your process serves the protocol over HTTP and/or gRPC' },
  { icon: Radio, title: 'Announce', text: 'POST /api/plugins/announce or RegistryService.Announce, with a 30s lease' },
  { icon: FileCode2, title: 'Describe', text: 'The host pulls GetManifest and validates it against the JSON Schema' },
  { icon: Workflow, title: 'Execute', text: 'Workflows call Execute(node, items). Agents can call it as a tool' },
];

const HTTP_ROUTES = [
  ['GET', '/.well-known/landflow', 'discovery probe'],
  ['GET', '/landflow/v1/manifest', 'PluginManifest'],
  ['POST', '/landflow/v1/execute', 'ExecuteRequest → ExecuteResponse'],
  ['POST', '/landflow/v1/load-options', 'dynamic dropdowns'],
  ['POST', '/landflow/v1/test-credentials', '"Test connection"'],
  ['GET', '/landflow/v1/health', 'liveness'],
  ['GET', '/metrics', 'Prometheus metrics (optional)'],
] as const;

const GRPC_SERVICE = `service PluginService {
  rpc GetManifest(GetManifestRequest) returns (GetManifestResponse);
  rpc Execute(ExecuteRequest)         returns (ExecuteResponse);
  rpc LoadOptions(LoadOptionsRequest) returns (LoadOptionsResponse);
  rpc TestCredentials(TestCredentialsRequest) returns (TestCredentialsResponse);
  rpc Health(HealthRequest)           returns (HealthResponse);
}
service RegistryService {           // hosted by Landflow on :7070
  rpc Announce(AnnounceRequest) returns (AnnounceResponse);
  rpc Withdraw(WithdrawRequest) returns (WithdrawResponse);
}`;

const codeBlock = 'rounded-[10px] border border-hair bg-wl font-mono text-[12px] leading-[1.6] text-t1';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-[15px] font-semibold text-t1">{title}</h2>
      {children}
    </section>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <code className="rounded border border-hair bg-wl px-1 font-mono text-[12px] text-t1">{children}</code>;
}

export default function DevelopersPage() {
  const [lang, setLang] = useState<Lang>('typescript');
  const [copied, setCopied] = useState(false);
  const sample = SAMPLES[lang];

  return (
    <>
      <PageHeader title="Build a plugin" meta={<span>SDKs for TypeScript, Python and Go</span>} />
      <PageBody className="flex max-w-[960px] flex-col gap-8">
        <p className="max-w-[72ch] text-[13px] leading-relaxed text-t2">
          Implement one interface, serve it, and you&apos;re done. Landflow discovers your plugin, renders its parameters, runs it in workflows and lets AI agents use it as a tool.
        </p>

        <Section title="Lifecycle">
          <Card className="grid grid-cols-1 gap-0 p-0 sm:grid-cols-2 lg:grid-cols-4">
            {LIFECYCLE.map((step, i) => (
              <div key={step.title} className={cn('px-4 py-3.5', i > 0 && 'border-t border-hair sm:border-t-0 lg:border-l', i === 2 && 'sm:border-t lg:border-t-0', i % 2 === 1 && 'sm:border-l')}>
                <div className="flex items-center gap-2.5">
                  <span className="grid size-7 shrink-0 place-items-center rounded-lg border border-hair bg-wl">
                    <step.icon className="size-3.5 text-t2" strokeWidth={1.7} />
                  </span>
                  <span className="text-[13px] font-semibold text-t1">{step.title}</span>
                  <span className="ml-auto font-mono text-[11px] text-t3">0{i + 1}</span>
                </div>
                <p className="mt-2 text-[12px] leading-relaxed text-t2">{step.text}</p>
              </div>
            ))}
          </Card>
        </Section>

        <Section title="Implement a node">
          <div className="mb-2.5 flex flex-wrap items-center gap-3">
            <Segmented label="SDK language" value={lang} onChange={setLang} options={(Object.keys(SAMPLES) as Lang[]).map((key) => ({ value: key, label: languageMeta(key).label }))} />
            <span className="truncate font-mono text-[12px] text-t3">{sample.file}</span>
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-auto"
              title="Copy code"
              aria-label="Copy code"
              onClick={() => {
                void navigator.clipboard.writeText(sample.code);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <Check className="size-3.5 text-gn" strokeWidth={1.7} /> : <Copy className="size-3.5" strokeWidth={1.7} />}
            </Button>
          </div>
          <pre className={cn(codeBlock, 'max-h-[560px] overflow-auto p-4 [tab-size:2]')}>{highlight(sample.code)}</pre>
          <div className={cn(codeBlock, 'mt-2 flex items-center gap-2 overflow-x-auto whitespace-pre px-4 py-2.5 text-t2')}>
            <span className="text-t3">$</span>
            {sample.run}
          </div>
        </Section>

        <Section title="Credentials, polling triggers and observability">
          <p className="mb-3 max-w-[80ch] text-[13px] leading-relaxed text-t2 [overflow-wrap:anywhere]">
            Declare credential types and the host stores them encrypted, renders their form and sends the values only to the node that uses them. A trigger with{' '}
            <Mono>triggerSource: &apos;poll&apos;</Mono> is called on schedule with the state it returned last time. Every SDK continues the host&apos;s trace (W3C{' '}
            <Mono>traceparent</Mono> over HTTP headers or gRPC metadata), writes JSON logs with trace ids and serves <Mono>/metrics</Mono>; spans, metrics and a traced HTTP
            client are on the context. Same language tabs as above.
          </p>
          <pre className={cn(codeBlock, 'max-h-[560px] overflow-auto p-4 [tab-size:2]')}>{highlight(ADVANCED[lang])}</pre>
          <p className="mt-2 text-[12px] text-t3">
            Details: <Mono>docs/protocol.md</Mono> §7–9 and <Mono>docs/observability.md</Mono> (span and metric names, log format, environment variables).
          </p>
        </Section>

        <Section title="Protocol">
          <div className="flex flex-col gap-3">
            <Card className="p-0">
              <div className="flex h-11 items-center gap-2 border-b border-hair px-4 text-[13px] font-semibold text-t1">
                <TransportBadge transport="http" /> binding
              </div>
              <div className="divide-y divide-hair">
                {HTTP_ROUTES.map(([method, path, what]) => (
                  <div key={path} className="flex items-center gap-3 px-4 py-2">
                    <span className="w-10 font-mono text-[11px] font-semibold text-t2">{method}</span>
                    <span className="truncate font-mono text-[12px] text-t1">{path}</span>
                    <span className="ml-auto shrink-0 text-[12px] text-t3">{what}</span>
                  </div>
                ))}
              </div>
            </Card>
            <Card className="flex flex-col p-0">
              <div className="flex h-11 items-center gap-2 border-b border-hair px-4 text-[13px] font-semibold text-t1">
                <TransportBadge transport="grpc" /> <span className="font-mono text-[12px] font-normal text-t2">landflow.plugin.v1</span>
              </div>
              <pre className="flex-1 overflow-x-auto px-4 py-3 font-mono text-[12px] leading-[1.6] text-t1">{highlight(GRPC_SERVICE)}</pre>
            </Card>
          </div>
        </Section>

        <Section title="Built-in nodes">
          <p className="max-w-[80ch] text-[13px] leading-relaxed text-t2 [overflow-wrap:anywhere]">
            The host&apos;s own built-in nodes implement the same <Mono>INodeType</Mono> interface; they are simply registered in-process. The full spec lives in <Mono>docs/protocol.md</Mono>, the contract in{' '}
            <Mono>packages/protocol/proto/landflow/plugin/v1/plugin.proto</Mono>, and JSON Schemas in <Mono>packages/protocol/schema/</Mono>.
          </p>
        </Section>
      </PageBody>
    </>
  );
}
