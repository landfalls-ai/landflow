/**
 * NB08: the brain's MCP answers carry Notion links (`notionUrl` on facts and pages), the instance server names
 * `brain_search_knowledge`, and the NB06 knowledge carryover is fixed: a failed probe keeps a model collection, `pending` after an
 * embed failure, a detached item's notes dropped, a relink's old chunks gone, the agents' tool falls back to keywords, a fence
 * closes only on its own marker and a Landflow edit that wins is not recorded as applied from Notion. NB02's real client over the
 * fake Notion; the brain's embeddings are off except in the outage tests, where a small fake Ollama answers (or does not).
 */
import { createServer, type Server } from "node:http";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { defineCredentialType, definePlugin } from "@landflow/sdk";
import { startFakeNotion, type FakeNotion } from "./fake-notion";

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), "landflow-notion-mcp-nb08-"));
const ENV = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: "off",
  LANDFLOW_SCAN_ON_START: "false",
  LANDFLOW_PLUGINS: "",
  LANDFLOW_AUDIT_OUTBOX: "off",
  LANDFLOW_BRAIN_MODEL: "off",
  LANDFLOW_BRAIN_EMBEDDINGS: "off",
};
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import("@/lib/server/plugins/registry");
const { corePlugin } = await import("@/lib/server/nodes");
const { credentials } = await import("@/lib/server/credentials/vault");
const { database } = await import("@/lib/server/db");
const projectsStore = await import("@/lib/server/projects/store");
const { knowledgeTool } = await import("@/lib/server/agents/knowledge");
const { SqliteVectorStore } = await import("@/lib/server/rag/stores");
const { notionClientFor } = await import("@/lib/server/notion/port");
await import("@/lib/server/notion/client");
const { createLink, updateLink, linkById, setCursors } =
  await import("@/lib/server/brain/notion/links");
const { saveItem, itemsOf, forgetLink } =
  await import("@/lib/server/brain/notion/sync");
const knowledge = await import("@/lib/server/brain/notion/knowledge");
const { notionKnowledgeCollection, brainPageTitle } =
  await import("@/lib/shared/notion-brain");
const { instanceServer } = await import("@/lib/server/mcp/instance-tools");
const { upsertFact } = await import("@/lib/server/brain/facts");
const { upsertEntity } = await import("@/lib/server/brain/entities");
const { fitMarkdown } = await import("@/lib/server/notion/text");
const { notionPageUrl } = await import("@/lib/server/brain/notion/urls");
await import("@/lib/server/project-context/provider");

registry.registerBuiltin(corePlugin);
registry.registerBuiltin(
  definePlugin({
    info: {
      id: "productivity",
      name: "Productivity (stand-in)",
      version: "0.0.0",
      language: "typescript",
    },
    credentialTypes: [
      defineCredentialType({
        name: "notionApi",
        displayName: "Notion API",
        properties: [
          {
            name: "apiKey",
            displayName: "API key",
            type: "string",
            required: true,
            typeOptions: { password: true },
          },
          {
            name: "baseUrl",
            displayName: "Base URL",
            type: "string",
            default: "https://api.notion.com",
          },
        ],
      }),
    ],
    nodes: [],
  }),
);

let fake: FakeNotion;
let credentialId = "";
let A = "";
let B = "";
let root = "";
let brain = "";
let refund = "";
let ownRow = "";
let linkId = "";
let factRow = "";
let ollama: Server;
let ollamaUp = true;
let ollamaPort = 0;
const REFUND = "Customers may request a refund within 30 days of purchase.";
const client = () => notionClientFor({ credentialId });
const link = () => linkById(linkId)!;
const pass = (force = true) => knowledge.knowledgeStep(link(), { force });
const cursor = () =>
  (
    JSON.parse(link().cursors ?? "{}") as {
      knowledge?: { embeddings?: string; pending?: number };
    }
  ).knowledge ?? {};
const docs = () =>
  database().all<{ page_id: string; title: string }>(
    "SELECT page_id, title FROM notion_knowledge_docs WHERE link_id = ?",
    linkId,
  );
const chunks = async () =>
  (await new SqliteVectorStore().metadataOf(notionKnowledgeCollection(A))).map(
    (m) => m.metadata,
  );
const chunkPages = async () =>
  [...new Set((await chunks()).map((m) => String(m.pageId)))].sort();

const setState = (key: string, state: "ok" | "detached") =>
  saveItem({ ...itemsOf(linkId).find((i) => i.local_key === key)!, state });

const connect = async (
  scopes: Array<"brain:read" | "workflows:read"> = ["brain:read"],
) => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await instanceServer(
    { id: "u_owner", role: "owner" },
    undefined,
    scopes,
  ).connect(serverSide);
  const mcp = new Client({ name: "nb08", version: "1.0.0" });
  await mcp.connect(clientSide);
  return mcp;
};
const call = async (name: string, args: Record<string, unknown>) =>
  JSON.parse(
    (
      (await (await connect()).callTool({ name, arguments: args })) as {
        content: Array<{ text: string }>;
      }
    ).content[0]?.text ?? "null",
  );

/** A model's embeddings through a stand-in Ollama: up, or answering 503. */
function startOllama(): Promise<void> {
  ollama = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (!ollamaUp) {
        res.writeHead(503).end("down");
        return;
      }
      const input =
        (JSON.parse(body || "{}") as { input?: string[] }).input ?? [];
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(
          JSON.stringify({
            model: "nomic-embed-text",
            embeddings: input.map(() => [1, 0, 0]),
          }),
        );
    });
  });
  return new Promise((resolve) =>
    ollama.listen(0, "127.0.0.1", () => {
      ollamaPort = (ollama.address() as { port: number }).port;
      resolve();
    }),
  );
}
const embeddingsOn = () => {
  delete process.env.LANDFLOW_BRAIN_EMBEDDINGS; // unset: the catalog default model
  process.env.OLLAMA_URL = `http://127.0.0.1:${ollamaPort}`;
};
const embeddingsOff = () => {
  process.env.LANDFLOW_BRAIN_EMBEDDINGS = "off";
  delete process.env.OLLAMA_URL;
};

beforeAll(async () => {
  fake = await startFakeNotion({ editTimes: "exact" });
  await startOllama();
  credentialId = credentials.create({
    name: "Notion key",
    type: "productivity.notionApi",
    data: { apiKey: fake.token, baseUrl: fake.url },
  }).id;
  A = projectsStore.createTeamProject({ name: "Payments" }).id;
  B = projectsStore.createTeamProject({ name: "Ops" }).id;
  root = fake.addPage({ title: "Payments wiki", shared: true });
  brain = fake.addPage({
    parentId: root,
    title: brainPageTitle("Payments"),
    markdown: "Home.",
  });
  refund = fake.addPage({
    parentId: brain,
    title: "Refund policy",
    markdown: REFUND,
  });
  const own = await client().createDatabase({
    parent: { page_id: brain },
    title: "Pages",
    properties: { Name: { title: {} } },
  });
  ownRow = (
    await client().createPage({
      parent: { data_source_id: own.dataSourceId },
      properties: { Name: { title: [{ text: { content: "Kestrel Bank" } }] } },
      markdown: "Kestrel pays by wire.",
    })
  ).id;
  factRow = (
    await client().createPage({
      parent: { data_source_id: own.dataSourceId },
      properties: { Name: { title: [{ text: { content: "A fact" } }] } },
      markdown: "x",
    })
  ).id;
  linkId = createLink({
    projectId: A,
    credentialId,
    rootPageId: root,
    brainPageId: brain,
    rootTitle: "Payments wiki",
  }).id;
  updateLink(linkId, { status: "active" });
  upsertEntity({
    type: "customer",
    id: "kestrel",
    name: "Kestrel Bank",
    projectId: A,
  });
  upsertEntity({
    type: "customer",
    id: "plain",
    name: "Plain Co",
    projectId: B,
  });
  upsertFact({
    id: "f-refund",
    subjectType: "entity",
    subjectId: "customer/kestrel",
    kind: "purpose",
    statement: "Kestrel Bank wants refunds in 30 days",
    confidence: 0.9,
    projectId: A,
  });
  upsertFact({
    id: "f-plain",
    subjectType: "entity",
    subjectId: "customer/plain",
    kind: "purpose",
    statement: "Plain Co wants refunds in 30 days",
    confidence: 0.9,
    projectId: B,
  });
  const item = {
    link_id: linkId,
    pushed_hash: null,
    pushed_region: null,
    pushed_at: null,
    seen_edited_at: null,
    pulled_hash: null,
    state: "ok",
  } as const;
  saveItem({
    ...item,
    kind: "fact",
    local_key: "f-refund",
    notion_id: factRow,
  });
  saveItem({
    ...item,
    kind: "entity",
    local_key: "customer/kestrel",
    notion_id: ownRow,
  });
});

afterAll(async () => {
  await fake.close();
  await new Promise((resolve) => ollama.close(resolve));
  forgetLink();
  for (const key of [...Object.keys(ENV), "OLLAMA_URL"]) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

describe("notionUrl over MCP", () => {
  it("brain_search_facts: the mapped fact carries its Notion row, a fact of an unlinked project none", async () => {
    const { facts } = (await call("brain_search_facts", {
      query: "refunds",
    })) as { facts: Array<{ id: string; notionUrl?: string }> };
    expect(facts.find((f) => f.id === "f-refund")?.notionUrl).toBe(
      notionPageUrl(factRow),
    );
    expect(facts.find((f) => f.id === "f-plain")).toBeDefined();
    expect(facts.find((f) => f.id === "f-plain")?.notionUrl).toBeUndefined();
  });

  it("brain_ask: the pages and facts it names carry it", async () => {
    const answer = (await call("brain_ask", {
      question: "What does Kestrel Bank want?",
    })) as {
      pages: Array<{ type: string; id: string; notionUrl?: string }>;
      facts: Array<{ id: string; notionUrl?: string }>;
    };
    expect(answer.pages.find((p) => p.id === "kestrel")?.notionUrl).toBe(
      notionPageUrl(ownRow),
    );
    expect(answer.facts.find((f) => f.id === "f-refund")?.notionUrl).toBe(
      notionPageUrl(factRow),
    );
  });

  it("a detached item has none, and neither has a disconnected link", async () => {
    setState("f-refund", "detached");
    expect(
      (
        (await call("brain_search_facts", { query: "refunds" })) as {
          facts: Array<{ id: string; notionUrl?: string }>;
        }
      ).facts.find((f) => f.id === "f-refund")?.notionUrl,
    ).toBeUndefined();
    setState("f-refund", "ok");
    expect(
      (
        (await call("brain_search_facts", { query: "refunds" })) as {
          facts: Array<{ id: string; notionUrl?: string }>;
        }
      ).facts.find((f) => f.id === "f-refund")?.notionUrl,
    ).toBeDefined();
    updateLink(linkId, { status: "unlinked" });
    expect(
      (
        (await call("brain_search_facts", { query: "refunds" })) as {
          facts: Array<{ id: string; notionUrl?: string }>;
        }
      ).facts.every((f) => f.notionUrl === undefined),
    ).toBe(true);
    updateLink(linkId, { status: "active" });
  });

  it("the instance server’s instructions name brain_search_knowledge, and the docs list it", async () => {
    const mcp = await connect();
    expect(mcp.getInstructions() ?? "").toContain("brain_search_knowledge");
    expect(
      readFileSync(join(__dirname, "../../../docs/features/ai.md"), "utf8"),
    ).toMatch(/`brain:read` \|[^\n]*`brain_search_knowledge`/);
  });
});

describe("the knowledge carryover", () => {
  it("a failed probe keeps a collection that holds a model’s vectors (no second clear), and counts the changed page as waiting", async () => {
    embeddingsOn();
    try {
      await pass();
      expect(cursor().embeddings).toBe("nomic-embed-text");
      expect(await chunkPages()).toContain(refund);
      ollamaUp = false;
      fake.editAsPerson(refund, {
        markdown: "Refunds are possible within 45 days.",
      });
      await pass();
      expect(cursor().embeddings).toBe("nomic-embed-text");
      expect(await chunkPages()).toContain(refund);
      expect(cursor().pending ?? 0).toBeGreaterThan(0);
      // Back up: the next pass indexes the edit with the same model, still without clearing.
      ollamaUp = true;
      await pass();
      expect(cursor().embeddings).toBe("nomic-embed-text");
      expect(cursor().pending ?? 0).toBe(0);
    } finally {
      ollamaUp = true;
      embeddingsOff();
      await pass();
      expect(cursor().embeddings).toBe("bm25");
    }
  });

  it("pending counts what an embed failure left, so the next tick continues", async () => {
    embeddingsOn();
    try {
      await new SqliteVectorStore().clear(notionKnowledgeCollection(A));
      setCursors(linkId, {});
      ollamaUp = true;
      await pass(); // probe answers: model indexing
      ollamaUp = true;
      // The probe answers once, then the embeds fail: stand-in for an outage that starts mid-pass.
      let calls = 0;
      ollama.removeAllListeners("request");
      ollama.on("request", (req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          calls++;
          const input =
            (JSON.parse(body || "{}") as { input?: string[] }).input ?? [];
          if (calls > 1) return void res.writeHead(503).end("down");
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(
              JSON.stringify({
                model: "nomic-embed-text",
                embeddings: input.map(() => [1, 0, 0]),
              }),
            );
        });
      });
      database().upsert("notion_knowledge_docs", {
        link_id: linkId,
        page_id: ownRow,
        title: "Notes",
        url: "u",
        path: "",
        edited_at: "x",
        hash: "h-pending",
        markdown: "wire",
        truncated: 0,
      } as never);
      await pass();
      expect(cursor().pending ?? 0).toBeGreaterThan(0);
      database().delete("notion_knowledge_docs", {
        link_id: linkId,
        page_id: ownRow,
      });
    } finally {
      embeddingsOff();
      await pass();
    }
  });

  it('a detached item’s "Your notes" stop being searchable; a live one’s stay', async () => {
    database().upsert("notion_knowledge_docs", {
      link_id: linkId,
      page_id: ownRow,
      title: "Kestrel · Your notes",
      url: "u",
      path: "",
      edited_at: "x",
      hash: "notes-1",
      markdown: "Kestrel pays by wire.",
      truncated: 0,
    } as never);
    await pass();
    expect(await chunkPages()).toContain(ownRow);
    setState("customer/kestrel", "detached");
    await pass();
    expect(docs().map((d) => d.page_id)).not.toContain(ownRow);
    expect(await chunkPages()).not.toContain(ownRow);
    setState("customer/kestrel", "ok");
  });

  it("a relink’s old chunks go at once (the cursor still holds the model)", async () => {
    await pass();
    const before = await chunks();
    expect(before.length).toBeGreaterThan(0);
    // Chunks of an earlier link of this project stay behind in the collection.
    await new SqliteVectorStore().add(notionKnowledgeCollection(A), [
      {
        id: "old:1",
        pageContent: "old words",
        metadata: {
          linkId: "link_old",
          pageId: "old-page",
          title: "Old",
          url: "",
          path: "",
          hash: "h",
          editedAt: "",
          chunk: 0,
        },
        embedding: [0],
      },
    ] as never);
    expect((await chunks()).some((m) => m.linkId === "link_old")).toBe(true);
    await pass(false);
    await pass(true);
    expect((await chunks()).some((m) => m.linkId === "link_old")).toBe(false);
    expect(await chunkPages()).toContain(refund);
  });

  it("the agent’s project_knowledge tool falls back to keywords when the query cannot be embedded", async () => {
    const config = knowledge.notionBrainKnowledgeConfig(A) as {
      embeddings: unknown;
      searchMode: string;
      collection: string;
    };
    // A collection that holds a model's vectors, with the model down.
    ollamaUp = false;
    const tool = knowledgeTool(
      {
        ...config,
        embeddings: {
          provider: "ollama",
          model: "nomic-embed-text",
          baseUrl: `http://127.0.0.1:${ollamaPort}`,
        },
        searchMode: "hybrid",
      } as never,
      { allowReserved: true },
    ) as {
      invoke: (
        i: { query: string },
        c: object,
      ) => Promise<{ output: { results: Array<{ pageContent: string }> } }>;
    };
    const out = await tool.invoke({ query: "refund days" }, {});
    ollamaUp = true;
    expect(out.output.results.length).toBeGreaterThan(0);
    // Not the Notion path: the failure stays an error.
    const plain = knowledgeTool({
      ...config,
      collection: "my-own",
      store: "sqlite",
      embeddings: {
        provider: "ollama",
        model: "nomic-embed-text",
        baseUrl: `http://127.0.0.1:${ollamaPort}`,
      },
      searchMode: "hybrid",
    } as never) as {
      invoke: (i: { query: string }, c: object) => Promise<unknown>;
    };
    ollamaUp = false;
    await expect(plain.invoke({ query: "refund days" }, {})).rejects.toThrow();
    ollamaUp = true;
  });
});

describe("the other carryover", () => {
  it("fitMarkdown: a ``` line inside a ~~~ fence does not close it", () => {
    const body = [
      "# Top",
      "intro",
      "~~~",
      ...Array.from({ length: 4_600 }, (_, i) =>
        i === 3 ? "```" : `code ${i}`,
      ),
      "~~~",
    ].join("\n");
    const cut = fitMarkdown(body);
    // The cut falls inside the ~~~ fence: it is closed with its own marker, or cut before it, never left open or closed by the ``` line.
    const fences = cut
      .split("\n")
      .filter((line) => /^\s*~~~/.test(line)).length;
    expect(fences % 2).toBe(0);
    expect(cut).toMatch(/Cut here/);
  });

  it("the contract copies are byte-identical (LANDFLOW_BACKBONE_CONTRACTS)", () => {
    const dir = process.env.LANDFLOW_BACKBONE_CONTRACTS;
    if (!dir) return;
    const src = join(__dirname, "../src/lib");
    for (const [contract, copy] of [
      ["notion-urls.ts", "server/brain/notion/urls.ts"],
      ["notion-brain-client.ts", "client/notion-brain.ts"],
      ["notion-brain.ts", "shared/notion-brain.ts"],
    ] as const)
      expect(readFileSync(join(src, copy), "utf8")).toBe(
        readFileSync(join(dir, "nb", contract), "utf8"),
      );
  });
});
