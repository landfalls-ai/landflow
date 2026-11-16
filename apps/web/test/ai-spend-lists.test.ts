/**
 * The runs and calls behind a number (wave 13, SP09): `GET /api/insights/ai/runs` and `…/calls`, as JSON and CSV.
 * Who may open what follows docs/llm-gateway.md "Who sees what" (rule 3): what a viewer can't open is counted in
 * `hidden` (no names, no ids); no response holds prompt text (rule 4).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Workflow } from "@landflow/engine";
import type { AiSpendCallsPage, AiSpendRunsPage } from "@/lib/shared/ai-spend";

const dataDir = mkdtempSync(join(tmpdir(), "landflow-spend-lists-"));
const previousEnv = { ...process.env };
Object.assign(process.env, {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: "off",
  LANDFLOW_SCAN_ON_START: "false",
  LANDFLOW_PLUGINS: "",
  LANDFLOW_AUDIT_OUTBOX: "off",
});

const { store } = await import("@/lib/server/store");
const { agentStore } = await import("@/lib/server/agents/store");
const { createUser } = await import("@/lib/server/auth/users");
const { enableTestAuth } = await import("@/lib/server/auth/test-bypass");
const projects = await import("@/lib/server/projects");
const { database } = await import("@/lib/server/db");
const { aiUsageMeter } = await import("@/lib/server/ai-usage");
const { routePolicy } = await import("@/lib/server/auth/policy");
const runsRoute = await import("@/app/api/insights/ai/runs/route");
const callsRoute = await import("@/app/api/insights/ai/calls/route");

type User = Awaited<ReturnType<typeof createUser>>;
const BASE = Date.parse("2026-11-16T10:00:00.000Z");
const at = (seconds: number) => new Date(BASE + seconds * 1000).toISOString();
const PROMPT_WORDS = ["zephyrine", "quokkas", "marsupial", "wombats"];
let counter = 0;
let owner: User;
let member: User;
let stranger: User;
let openAgent: { id: string; name: string };
let secretAgent: { id: string; name: string };
const DAY = "2026-11-16";

function usage(fields: Record<string, unknown>) {
  const input = Number(fields.input_tokens ?? 100);
  const output = Number(fields.output_tokens ?? 10);
  const provider = String(fields.provider ?? "anthropic");
  const model = String(fields.model ?? "claude-sonnet-4-6");
  const { cost } = aiUsageMeter().price({
    provider,
    model,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  const id = String(fields.id ?? `au_sl_${++counter}`);
  database().insertNew("ai_usage", {
    id,
    at: at(0),
    day: DAY,
    operation: "chat",
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost,
    provider,
    model,
    ...fields,
  });
  return id;
}

function execution(executionId: string, workflowId: string) {
  store.saveExecution({
    executionId,
    workflowId,
    workflowName: workflowId,
    mode: "manual",
    status: "success",
    startedAt: at(0),
    finishedAt: at(60),
    durationMs: 60_000,
    runData: {},
    executionOrder: [],
  } as never);
}

const query = (params: Record<string, string>) =>
  `http://x.test/api/insights/ai?${new URLSearchParams({ period: "7d", ...params })}`;
async function call(
  route: { GET: unknown },
  params: Record<string, string>,
  user?: User,
) {
  enableTestAuth(user);
  try {
    const response = await (route.GET as (r: Request) => Promise<Response>)(
      new Request(query(params)),
    );
    const text = await response.text();
    return {
      status: response.status,
      type: response.headers.get("content-type") ?? "",
      text,
      body: response.headers.get("content-type")?.includes("json")
        ? JSON.parse(text)
        : undefined,
    };
  } finally {
    enableTestAuth();
  }
}
const runs = async (params: Record<string, string>, user?: User) =>
  call(runsRoute, params, user);
const calls = async (params: Record<string, string>, user?: User) =>
  call(callsRoute, params, user);

beforeAll(async () => {
  // The routes read the clock: hold it just after the fixtures' day, whatever the date (only Date, so awaits still run).
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(BASE + 3_600_000);
  owner = await createUser({
    email: "olga@lists.test",
    name: "Olga Owner",
    role: "owner",
    password: "olga-password-1",
  });
  member = await createUser({
    email: "mia@lists.test",
    name: "Mia Member",
    role: "member",
    password: "mia-password-1",
  });
  stranger = await createUser({
    email: "sam@lists.test",
    name: "Sam Stranger",
    role: "member",
    password: "sam-password-1",
  });
  const open = projects.createTeamProject({ name: "Open desk" }).id;
  const closed = projects.createTeamProject({ name: "Closed desk" }).id;
  projects.setMember(open, member.id, "editor");
  store.saveWorkflow({
    id: "wf_sl_open",
    name: 'Support, "tier 1"\nnight',
    nodes: [],
    connections: [],
  } as unknown as Workflow);
  store.saveWorkflow({
    id: "wf_sl_closed",
    name: "Closed flow",
    nodes: [],
    connections: [],
  } as unknown as Workflow);
  projects.setHomeProject("workflow", "wf_sl_open", open);
  projects.setHomeProject("workflow", "wf_sl_closed", closed);
  openAgent = agentStore.create({
    name: "Open agent",
    instructions:
      "Consult the zephyrine quokkas. Where do marsupial wombats sleep?",
  });
  secretAgent = agentStore.create({ name: "Hidden Quokka Desk" });
  projects.setHomeProject("agent", openAgent.id, open);
  projects.setHomeProject("agent", secretAgent.id, closed);
  // A split row with recognisable words: sizes and hashes only are ever stored, and nothing may carry these words out.
  database().insertNew("ai_call_parts", {
    id: "acp_words",
    usage_id: "au_words",
    gateway_request_id: null,
    at: at(0),
    source: "landflow",
    method: "estimate",
    input_tokens: 10,
    parts: JSON.stringify({ instructions: 10 }),
    prefix_hash: "zephyrine",
    prompt_hash: null,
    part_hashes: null,
    tool_names: JSON.stringify(["wombats"]),
  });
});

afterAll(() => {
  vi.useRealTimers();
  for (const key of Object.keys(process.env))
    if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

describe("GET /api/insights/ai/runs", () => {
  it("counts an agent loop of five calls as one run, with its totals", async () => {
    execution("ex_loop", "wf_sl_open");
    for (let i = 0; i < 5; i++)
      usage({
        id: `au_loop_${i}`,
        at: at(i),
        execution_id: "ex_loop",
        workflow_id: "wf_sl_open",
        agent_id: openAgent.id,
        session_id: "as_loop",
        input_tokens: 1000,
        output_tokens: 100,
      });
    const { status, body } = await runs(
      { group: "agent", key: openAgent.id },
      owner,
    );
    expect(status).toBe(200);
    const page = body as AiSpendRunsPage;
    expect(page.runs).toHaveLength(1);
    expect(page.runs[0]).toMatchObject({
      executionId: "ex_loop",
      workflowId: "wf_sl_open",
      agentId: openAgent.id,
      runs: 1,
      calls: 5,
      inputTokens: 5000,
      outputTokens: 500,
      href: "/runs/ex_loop?tab=spend",
      label: 'Support, "tier 1"\nnight',
    });
    expect(page.hidden).toEqual({ runs: 0, calls: 0, cost: 0 });
  });

  it("lists an agent session with no execution by its agent, linking to the sessions tab", async () => {
    usage({
      id: "au_chat_1",
      at: at(0),
      agent_id: openAgent.id,
      session_id: "as_chat",
      user_id: member.id,
      input_tokens: 200,
      output_tokens: 20,
    });
    usage({
      id: "au_chat_2",
      at: at(1),
      agent_id: openAgent.id,
      session_id: "as_chat",
      user_id: member.id,
      input_tokens: 300,
      output_tokens: 30,
    });
    const page = (await runs({ group: "person", key: member.id }, member))
      .body as AiSpendRunsPage;
    expect(page.runs).toHaveLength(1);
    expect(page.runs[0]).toMatchObject({
      sessionId: "as_chat",
      label: "Open agent",
      calls: 2,
      runs: 1,
      href: `/agents/${openAgent.id}?tab=sessions&session=as_chat`,
    });
  });

  it("lists a person’s runs for another member by what they may open, the rest in hidden without names or ids", async () => {
    execution("ex_p_open", "wf_sl_open");
    execution("ex_p_closed", "wf_sl_closed");
    usage({
      id: "au_p_open",
      at: at(0),
      execution_id: "ex_p_open",
      workflow_id: "wf_sl_open",
      user_id: owner.id,
      input_tokens: 700,
      output_tokens: 70,
    });
    usage({
      id: "au_p_closed1",
      at: at(1),
      execution_id: "ex_p_closed",
      workflow_id: "wf_sl_closed",
      user_id: owner.id,
      input_tokens: 5000,
      output_tokens: 500,
    });
    usage({
      id: "au_p_closed2",
      at: at(2),
      execution_id: "ex_p_closed",
      workflow_id: "wf_sl_closed",
      user_id: owner.id,
      input_tokens: 5000,
      output_tokens: 500,
    });
    usage({
      id: "au_p_secret",
      at: at(3),
      agent_id: secretAgent.id,
      session_id: "as_p_secret",
      user_id: owner.id,
      input_tokens: 4000,
      output_tokens: 400,
    });
    const asMember = await runs({ group: "person", key: owner.id }, member);
    const page = asMember.body as AiSpendRunsPage;
    expect(page.runs.map((r) => r.executionId)).toEqual(["ex_p_open"]);
    expect(page.hidden.runs).toBe(2);
    expect(page.hidden.calls).toBe(3);
    expect(page.hidden.cost).toBeGreaterThan(0);
    for (const word of [
      "Closed flow",
      "wf_sl_closed",
      "ex_p_closed",
      "Hidden Quokka Desk",
      secretAgent.id,
      "as_p_secret",
    ])
      expect(asMember.text).not.toContain(word);
    const asOwner = (await runs({ group: "person", key: owner.id }, owner))
      .body as AiSpendRunsPage;
    expect(
      asOwner.runs.map((r) => r.executionId ?? r.sessionId).sort(),
    ).toEqual(["as_p_secret", "ex_p_closed", "ex_p_open"]);
    expect(asOwner.hidden).toEqual({ runs: 0, calls: 0, cost: 0 });
    expect(asOwner.runs.find((r) => r.sessionId === "as_p_secret")?.label).toBe(
      "Hidden Quokka Desk",
    );
  });

  it("answers 404 for a filter or key the member cannot read, and 400 for “Other”", async () => {
    expect(
      (
        await runs(
          { group: "agent", key: "none", agentId: secretAgent.id },
          member,
        )
      ).status,
    ).toBe(404);
    expect(
      (await runs({ group: "workflow", key: "wf_sl_closed" }, member)).status,
    ).toBe(404);
    expect(
      (
        await runs(
          { group: "person", key: owner.id, workflowId: "wf_sl_closed" },
          member,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await runs(
          { group: "person", key: owner.id, projectId: "no-such" },
          member,
        )
      ).status,
    ).toBe(404);
    expect((await runs({ group: "agent", key: "other" }, owner)).status).toBe(
      400,
    );
    expect((await runs({ group: "agent" }, owner)).status).toBe(400);
    expect(
      (await runs({ group: "person", key: owner.id, period: "custom" }, owner))
        .status,
    ).toBe(400);
    expect(
      (
        await runs(
          {
            group: "person",
            key: owner.id,
            period: "custom",
            from: "2024-01-01",
            to: "2026-01-01",
          },
          owner,
        )
      ).status,
    ).toBe(400);
  });

  it("lists nothing under “shared” and counts what it holds as hidden", async () => {
    execution("ex_sh", "wf_sl_open");
    usage({
      id: "au_sh_1",
      at: at(0),
      execution_id: "ex_sh",
      workflow_id: "wf_sl_open",
      agent_id: secretAgent.id,
      session_id: "as_sh",
      caller_agent_id: openAgent.id,
      user_id: member.id,
      input_tokens: 800,
      output_tokens: 80,
    });
    const page = (await runs({ group: "agent", key: "shared" }, member))
      .body as AiSpendRunsPage;
    expect(page.runs).toEqual([]);
    expect(page.hidden.runs).toBe(1);
    expect(page.hidden.calls).toBe(1);
  });

  it("keeps a child session of an agent the member cannot read hidden even when its run is readable", async () => {
    execution("ex_child", "wf_sl_open");
    usage({
      id: "au_ch_1",
      at: at(0),
      execution_id: "ex_child",
      workflow_id: "wf_sl_open",
      agent_id: openAgent.id,
      session_id: "as_ch_a",
      input_tokens: 100,
      output_tokens: 10,
    });
    usage({
      id: "au_ch_2",
      at: at(1),
      execution_id: "ex_child",
      workflow_id: "wf_sl_open",
      agent_id: secretAgent.id,
      session_id: "as_ch_b",
      caller_agent_id: openAgent.id,
      input_tokens: 9000,
      output_tokens: 900,
    });
    const asMember = await calls(
      { group: "workflow", key: "wf_sl_open", order: "recent" },
      member,
    );
    const page = asMember.body as AiSpendCallsPage;
    expect(page.calls.map((c) => c.usageId)).toContain("au_ch_1");
    expect(page.calls.map((c) => c.usageId)).not.toContain("au_ch_2");
    expect(page.hidden.calls).toBeGreaterThanOrEqual(1);
    expect(asMember.text).not.toContain(secretAgent.id);
    // The run is listed with only what the member can open; its other call is in hidden.cost, not hidden.runs.
    const run = (
      (await runs({ group: "workflow", key: "wf_sl_open" }, member))
        .body as AiSpendRunsPage
    ).runs.find((r) => r.executionId === "ex_child");
    expect(run).toMatchObject({ calls: 1, inputTokens: 100 });
    const asOwner = (
      await calls({ group: "workflow", key: "wf_sl_open" }, owner)
    ).body as AiSpendCallsPage;
    expect(asOwner.calls.map((c) => c.usageId)).toContain("au_ch_2");
  });

  it("pages by cost and by time with a cursor and no run twice", async () => {
    for (let i = 0; i < 60; i++) {
      execution(`ex_pg_${i}`, "wf_sl_open");
      usage({
        id: `au_pg_${i}`,
        at: at(1000 + i),
        execution_id: `ex_pg_${i}`,
        workflow_id: "wf_sl_open",
        agent_id: openAgent.id,
        user_id: stranger.id,
        input_tokens: 100 + (i % 7) * 10,
        output_tokens: 10,
      });
    }
    for (const order of ["cost", "recent"] as const) {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const { body } = await runs(
          {
            group: "person",
            key: stranger.id,
            order,
            ...(cursor && { cursor }),
          },
          member,
        );
        const page = body as AiSpendRunsPage;
        expect(page.runs.length).toBeLessThanOrEqual(50);
        seen.push(...page.runs.map((r) => r.executionId as string));
        cursor = page.next;
        pages += 1;
      } while (cursor && pages < 5);
      expect(pages).toBe(2);
      expect(new Set(seen).size).toBe(60);
      expect(seen).toHaveLength(60);
      if (order === "recent") expect(seen[0]).toBe("ex_pg_59");
    }
    expect(
      (
        await runs(
          {
            group: "person",
            key: stranger.id,
            order: "recent",
            cursor: "garbage",
          },
          member,
        )
      ).status,
    ).toBe(400);
    const costPage = (
      await runs({ group: "person", key: stranger.id, order: "cost" }, member)
    ).body as AiSpendRunsPage;
    const costs = costPage.runs.map((r) => r.cost);
    expect(costs).toEqual([...costs].sort((a, b) => b - a));
  });

  it("answers a CSV with the JSON columns, RFC 4180 quoting and the hidden total last", async () => {
    const res = await runs(
      { group: "person", key: owner.id, format: "csv" },
      member,
    );
    expect(res.status).toBe(200);
    expect(res.type).toBe("text/csv; charset=utf-8");
    const lines = res.text.split("\r\n");
    expect(lines[0]).toBe(
      "execution_id,session_id,agent_id,workflow_id,label,first_call_at,runs,calls,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost,unpriced_calls,href",
    );
    // The open workflow's name holds a comma, quotes and a new line.
    expect(res.text).toContain('"Support, ""tier 1""\nnight"');
    expect(lines.at(-2)).toMatch(
      /^"Not listed .*2 runs, 3 calls, cost [\d.]+"$/,
    );
    for (const word of [
      "Closed flow",
      "wf_sl_closed",
      "Hidden Quokka Desk",
      secretAgent.id,
    ])
      expect(res.text).not.toContain(word);
  });

  it("is an executions:read route", () => {
    expect(routePolicy("GET", "/api/insights/ai/runs").scope).toBe(
      "executions:read",
    );
    expect(routePolicy("GET", "/api/insights/ai/calls").scope).toBe(
      "executions:read",
    );
  });
});

describe("GET /api/insights/ai/calls", () => {
  it("lists a call with no run only for its person and admins", async () => {
    usage({
      id: "au_norun",
      at: at(0),
      user_id: member.id,
      input_tokens: 123,
      output_tokens: 12,
      surface: "spotlight",
    });
    const own = (await calls({ group: "surface", key: "spotlight" }, member))
      .body as AiSpendCallsPage;
    expect(own.calls.map((c) => c.usageId)).toEqual(["au_norun"]);
    expect(own.calls[0].runHref).toBeUndefined();
    const other = (await calls({ group: "person", key: member.id }, stranger))
      .body as AiSpendCallsPage;
    expect(other.calls.map((c) => c.usageId)).not.toContain("au_norun");
    expect(other.hidden.calls).toBeGreaterThanOrEqual(1);
    const admin = (await calls({ group: "surface", key: "spotlight" }, owner))
      .body as AiSpendCallsPage;
    expect(admin.calls.map((c) => c.usageId)).toEqual(["au_norun"]);
  });

  it("links a call to its run when the viewer may open it and says whether it has a split", async () => {
    execution("ex_words", "wf_sl_open");
    usage({
      id: "au_words",
      at: at(0),
      execution_id: "ex_words",
      workflow_id: "wf_sl_open",
      agent_id: openAgent.id,
      session_id: "as_words",
      purpose: "answer",
      iteration: 1,
      input_tokens: 10,
      output_tokens: 1,
    });
    const every: AiSpendCallsPage["calls"] = [];
    let cursor: string | undefined;
    do {
      const page = (
        await calls(
          { group: "agent", key: openAgent.id, ...(cursor && { cursor }) },
          member,
        )
      ).body as AiSpendCallsPage;
      every.push(...page.calls);
      cursor = page.next;
    } while (cursor);
    const found = every.find((c) => c.usageId === "au_words");
    expect(found).toMatchObject({
      executionId: "ex_words",
      runHref: "/runs/ex_words",
      hasParts: true,
      purpose: "answer",
      iteration: 1,
      agentId: openAgent.id,
    });
  });

  it("pages newest first with a cursor and no call twice", async () => {
    execution("ex_cp", "wf_sl_open");
    for (let i = 0; i < 120; i++)
      usage({
        id: `au_cp_${String(i).padStart(3, "0")}`,
        at: at(5000 + Math.floor(i / 2)),
        execution_id: "ex_cp",
        workflow_id: "wf_sl_open",
        user_id: stranger.id,
        purpose: "answer",
        input_tokens: 10,
        output_tokens: 1,
      });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = (
        await calls(
          {
            group: "purpose",
            key: "answer",
            workflowId: "wf_sl_open",
            userId: stranger.id,
            ...(cursor && { cursor }),
          },
          member,
        )
      ).body as AiSpendCallsPage;
      seen.push(...page.calls.map((c) => c.usageId));
      cursor = page.next;
    } while (cursor);
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
    // Two calls share each time: the newest time first, its calls by id.
    expect(seen[0]).toBe("au_cp_118");
  });

  it("writes a CSV of calls and cuts it at 10,000 rows with a note", async () => {
    execution("ex_huge", "wf_sl_open");
    database().transaction(() => {
      for (let i = 0; i < 10_003; i++) {
        database().insertNew("ai_usage", {
          id: `au_huge_${i}`,
          at: at(9000 + (i % 3000)),
          day: DAY,
          execution_id: "ex_huge",
          workflow_id: "wf_sl_open",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          operation: "chat",
          input_tokens: 1,
          output_tokens: 1,
          cost: 0.000001,
          user_id: stranger.id,
          purpose: "summary",
        });
      }
    });
    const res = await calls(
      { group: "purpose", key: "summary", format: "csv" },
      owner,
    );
    expect(res.type).toBe("text/csv; charset=utf-8");
    const lines = res.text.split("\r\n");
    expect(lines[0].startsWith("usage_id,at,execution_id")).toBe(true);
    // header + 10,000 rows + the cut note + the hidden note + the closing break
    expect(lines).toHaveLength(1 + 10_000 + 2 + 1);
    expect(lines.at(-3)).toContain("Cut at 10000 rows");
    expect(lines.at(-2)).toContain("Not listed");
  });

  it("holds no prompt text: not in the JSON, not in the CSV", async () => {
    for (const user of [owner, member]) {
      const all = [
        await calls({ group: "agent", key: openAgent.id }, user),
        await calls({ group: "agent", key: openAgent.id, format: "csv" }, user),
        await runs({ group: "agent", key: openAgent.id }, user),
        await runs({ group: "agent", key: openAgent.id, format: "csv" }, user),
      ];
      for (const res of all)
        for (const word of PROMPT_WORDS)
          expect(res.text.toLowerCase()).not.toContain(word);
    }
  });

  it("lists a 24h window and a custom range the same way, whatever the time zone", async () => {
    const custom = (
      await calls(
        {
          group: "agent",
          key: openAgent.id,
          period: "custom",
          from: DAY,
          to: DAY,
        },
        owner,
      )
    ).body as AiSpendCallsPage;
    expect(custom.calls.length).toBeGreaterThan(0);
    const outside = (
      await calls(
        {
          group: "agent",
          key: openAgent.id,
          period: "custom",
          from: "2026-01-01",
          to: "2026-01-02",
        },
        owner,
      )
    ).body as AiSpendCallsPage;
    expect(outside.calls).toEqual([]);
  });
});
