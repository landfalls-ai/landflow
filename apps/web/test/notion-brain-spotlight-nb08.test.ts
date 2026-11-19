// @vitest-environment happy-dom
/**
 * NB08: the shell Spotlight moves a project's brain to Notion from a typed ask and says whether it is in sync
 * (docs/spotlight.md#moving-a-brain-to-notion). The real AskPanel and card in happy-dom, the routes a stubbed fetch with the
 * contract's shapes and made-up data. The classifier's cases are plain functions. A key-shaped text is built at run time.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let pathname = "/projects/p1";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: () => undefined }),
}));
// The credential dialog is the one place a secret is typed: a stand-in that records what the card hands it and "saves" a key
// whose detail carries a marker secret, to show nothing of it reaches the panel.
const MARKER = ["marker", "secret", "value"].join("-");
vi.mock("@/components/credentials/credential-dialog", () => ({
  CredentialDialog: (props: {
    allowedTypes?: string[];
    projectId?: string;
    onClose: () => void;
    onSaved?: (c: unknown) => void;
  }) =>
    createElement(
      "div",
      {
        "data-testid": "credential-dialog",
        "data-types": (props.allowedTypes ?? []).join(","),
        "data-project": props.projectId ?? "",
      },
      createElement(
        "button",
        {
          type: "button",
          onClick: () => {
            keys.push({
              id: "c_new",
              name: "Fresh key",
              type: "productivity.notionApi",
            });
            props.onSaved?.({
              id: "c_new",
              name: "Fresh key",
              type: "productivity.notionApi",
              data: { apiKey: MARKER },
            });
            props.onClose();
          },
        },
        "stub save",
      ),
    ),
}));

const { AskPanel } = await import("@/components/brain/wiki/ask-panel");
const { notionBrainAsk, hideNotionKeys } =
  await import("@/lib/shared/notion-brain-ask");
const { notionBrainReply, KEY_WARNING } =
  await import("@/components/spotlight/notion-brain-turn");
const { statusAnswer, notionKeysOf, preselectedKey } =
  await import("@/lib/client/notion-brain");
const { useProjectStore } = await import("@/components/projects/use-projects");

const HEX = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const PAGE = `https://www.notion.so/Acme-${HEX}`;
const aKey = () => ["ntn", "Zq".repeat(22)].join("_");

interface Call {
  url: string;
  method: string;
  body: string;
}
let calls: Call[] = [];
let keys: Array<{ id: string; name: string; type: string }> = [];
let link: Record<string, unknown> = { linked: false, canManage: true };
let problems: Array<{ detail: string }> = [];
let projects = [{ id: "p1", name: "Payments", type: "team", role: "admin" }];
let container: HTMLDivElement;
let root: Root;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const linkView = (over: Record<string, unknown> = {}) => ({
  linked: true,
  id: "l1",
  projectId: "p1",
  status: "active",
  credential: { id: "c1", name: "Payments key" },
  rootPageId: HEX,
  rootTitle: "Acme",
  rootUrl: PAGE,
  lastPushAt: new Date(Date.now() - 150_000).toISOString(),
  waiting: 0,
  problems: 1,
  createdAt: "x",
  updatedAt: "x",
  canManage: true,
  ...over,
});

beforeEach(() => {
  calls = [];
  keys = [
    { id: "c1", name: "Payments key", type: "productivity.notionApi" },
    { id: "c9", name: "Slack", type: "slack.slackApi" },
  ];
  link = { linked: false, canManage: true };
  problems = [];
  projects = [{ id: "p1", name: "Payments", type: "team", role: "admin" }];
  pathname = "/projects/p1";
  useProjectStore.setState({ projects: undefined } as never);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const u = String(url);
      calls.push({
        url: u,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : "",
      });
      if (u === "/api/projects") return json({ projects });
      if (/^\/api\/credentials/.test(u)) return json({ credentials: keys });
      if (/brain\/notion\/problems/.test(u)) return json(problems);
      if (/brain\/notion\/check/.test(u))
        return json({
          title: "Acme wiki",
          url: PAGE,
          existingBrain: { found: false },
          counts: { pages: 4, facts: 7, practices: 1, notes: 0 },
          estimateMinutes: 2,
        });
      if (/brain\/notion$/.test(u) && init?.method === "POST")
        return json(
          linkView({
            status: "copying",
            copy: { phase: "rows", done: 3, total: 12 },
            problems: 0,
          }),
        );
      if (/brain\/notion$/.test(u)) return json(link);
      if (/\/api\/conversations/.test(u) && (init?.method ?? "GET") === "GET")
        return json({ conversations: [] });
      return json({});
    }),
  );
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });
const button = (re: RegExp) =>
  [...container.querySelectorAll("button")].find((b) =>
    re.test(b.textContent ?? ""),
  );
const ask = async (question: string, n = 1) => {
  await act(async () =>
    root.render(
      createElement(AskPanel, {
        onClose: () => undefined,
        request: { question, key: n },
      }),
    ),
  );
  await settle();
};
const writes = () => calls.filter((c) => c.method !== "GET");
const writesToNotion = () =>
  writes().filter((c) => /brain\/notion/.test(c.url));

describe("the classifier", () => {
  it.each([
    ["Keep this project’s brain in Notion", { kind: "link" }],
    [
      `Keep this project's brain in Notion under ${PAGE}`,
      { kind: "link", page: PAGE },
    ],
    ["Move the brain to Notion", { kind: "link" }],
    [
      "Please put our brain in Notion, page " + HEX,
      { kind: "link", page: HEX },
    ],
    ["Can you sync this project’s brain with Notion?", { kind: "link" }],
    ["connect the brain to notion", { kind: "link" }],
    ["Is the brain in sync with Notion?", { kind: "status" }],
    ["is this project’s brain synced to notion", { kind: "status" }],
    ["When did the brain last sync to Notion?", { kind: "status" }],
    ["What is wrong with the Notion sync?", { kind: "status" }],
  ])("%s", (text, expected) => expect(notionBrainAsk(text)).toEqual(expected));

  it("a key-shaped text wins over everything and is hidden", () => {
    const key = aKey();
    expect(notionBrainAsk(`Keep the brain in Notion, key ${key}`)).toEqual({
      kind: "key",
    });
    expect(notionBrainAsk(["secret", "k".repeat(45)].join("_"))).toEqual({
      kind: "key",
    });
    expect(hideNotionKeys(`use ${key} now`)).toBe(
      "use [a Notion key, hidden] now",
    );
    expect(hideNotionKeys(`${key} and ${key}`)).toBe(
      "[a Notion key, hidden] and [a Notion key, hidden]",
    );
  });

  it.each([
    "What does our Notion say about refunds?",
    "Search Notion for the refund policy",
    "Is the build in sync?",
    "Move the invoice step to the end",
    "How do I move the brain to Notion?",
    "Keep the brain short",
    `Summarise ${PAGE}`,
    "ntn_short",
    "secret_santa is on Friday",
  ])("look-alike, not an ask: %s", (text) =>
    expect(notionBrainAsk(text)).toBeUndefined(),
  );
});

describe("a link ask on a project page", () => {
  it("shows the card with the page filled and the one key preselected and named, and writes nothing", async () => {
    await ask(`Keep this project's brain in Notion under ${PAGE}`);
    expect(
      container.querySelector('[data-testid="notion-brain-card"]'),
    ).toBeTruthy();
    expect(container.textContent).toContain("Brain in Notion · Payments");
    expect(
      (
        container.querySelector(
          'input[aria-label="Notion page"]',
        ) as HTMLInputElement
      ).value,
    ).toBe(PAGE);
    const radios = [
      ...container.querySelectorAll('input[type="radio"]'),
    ] as HTMLInputElement[];
    expect(radios.map((r) => r.parentElement!.textContent)).toEqual([
      "Payments key",
    ]);
    expect(radios[0]!.checked).toBe(true);
    expect(calls.some((c) => /\/api\/brain\/ask/.test(c.url))).toBe(false);
    expect(writes()).toEqual([]);
    expect(button(/Connect and copy/)!.hasAttribute("disabled")).toBe(true);
  });

  it("with two keys none is preselected", async () => {
    keys.push({ id: "c2", name: "Second key", type: "productivity.notionApi" });
    await ask("Move the brain to Notion");
    const radios = [
      ...container.querySelectorAll('input[type="radio"]'),
    ] as HTMLInputElement[];
    expect(radios).toHaveLength(2);
    expect(radios.some((r) => r.checked)).toBe(false);
    expect(preselectedKey(notionKeysOf(keys))).toBeUndefined();
  });

  it("Check then Connect and copy: only the person’s click writes, and the card folds to a progress line", async () => {
    await ask(`Keep this project's brain in Notion under ${PAGE}`);
    await act(async () => button(/^Check$/)!.click());
    await settle();
    expect(writes().map((c) => c.url)).toEqual([
      expect.stringMatching(/brain\/notion\/check$/),
    ]);
    expect(container.textContent).toContain("Acme wiki");
    expect(container.textContent).toContain("Never copied to Notion");
    await act(async () => button(/Connect and copy/)!.click());
    await settle();
    const connect = writesToNotion().find(
      (c) => c.method === "POST" && /brain\/notion$/.test(c.url),
    )!;
    expect(JSON.parse(connect.body)).toEqual({
      credentialId: "c1",
      page: PAGE,
    });
    expect(container.textContent).toContain("Copying the pages · 3 of 12");
    expect(button(/Connect and copy/)).toBeUndefined();
  });

  it("Pick / New Notion key opens the dialog for the Notion key type; a key saved there never reaches the panel", async () => {
    await ask("Move the brain to Notion");
    await act(async () => button(/New Notion key/)!.click());
    const dialog = container.querySelector(
      '[data-testid="credential-dialog"]',
    )!;
    expect(dialog.getAttribute("data-types")).toBe("productivity.notionApi");
    expect(dialog.getAttribute("data-project")).toBe("p1");
    await act(async () => button(/stub save/)!.click());
    await settle();
    expect(
      container.querySelector('[data-testid="credential-dialog"]'),
    ).toBeNull();
    expect(
      [...container.querySelectorAll('input[type="radio"]')].map(
        (r) => r.parentElement!.textContent,
      ),
    ).toEqual(["Fresh key", "Payments key"]);
    expect(container.innerHTML).not.toContain(MARKER);
    expect(JSON.stringify(calls)).not.toContain(MARKER);
  });

  it("a member who is not the project’s admin gets no Connect", async () => {
    link = { linked: false, canManage: false };
    await ask("Keep the brain in Notion");
    expect(container.textContent).toContain(
      "An admin of Payments can move its brain to Notion",
    );
    expect(button(/Connect and copy/)).toBeUndefined();
    expect(button(/^Check$/)).toBeUndefined();
  });

  it("an already linked project shows its status and Open in Notion, not a second Connect", async () => {
    link = linkView();
    await ask("Keep the brain in Notion");
    expect(container.textContent).toContain("In sync");
    expect(
      container.querySelector('a[href="' + PAGE + '"]')?.textContent,
    ).toContain("Open in Notion");
    expect(button(/Connect and copy/)).toBeUndefined();
  });

  it("the card fits a phone sheet: shrinkable, 44 px targets, no fixed width", async () => {
    await ask("Move the brain to Notion");
    const card = container.querySelector('[data-testid="notion-brain-card"]')!;
    expect(card.className).toContain("min-w-0");
    for (const b of card.querySelectorAll("button"))
      expect(b.className).toMatch(/max-md:h-11/);
    expect(card.innerHTML).not.toMatch(
      /\bw-\[\d+px\]|style="[^"]*width:\s*\d+px/,
    );
  });
});

describe("a key-shaped text", () => {
  it("gets the warning and the New Notion key button, shows the text hidden, and nothing is sent anywhere", async () => {
    const key = aKey();
    await ask(`here is my Notion key ${key}`);
    expect(container.textContent).toContain(KEY_WARNING);
    expect(container.textContent).toContain("[a Notion key, hidden]");
    expect(container.innerHTML).not.toContain(key);
    expect(button(/New Notion key/)).toBeTruthy();
    expect(JSON.stringify(calls)).not.toContain(key);
    expect(calls.some((c) => /\/api\/brain\/ask/.test(c.url))).toBe(false);
    expect(writes()).toEqual([]);
  });
});

describe("the status question", () => {
  it("on a linked project answers the status sentence of the real view and problems", async () => {
    link = linkView();
    problems = [{ detail: "The page “Refunds” was trashed in Notion" }];
    await ask("Is the brain in sync with Notion?");
    const expected = statusAnswer(link as never, problems);
    expect(expected).toMatch(
      /Synced 2 minutes ago, 0 waiting, 1 problem: The page/,
    );
    expect(container.textContent).toContain(expected);
    expect(writes()).toEqual([]);
    expect(calls.some((c) => /\/api\/brain\/ask/.test(c.url))).toBe(false);
  });

  it("on an unlinked project says it lives in Landflow", async () => {
    await ask("Is the brain in sync with Notion?");
    expect(container.textContent).toContain("not linked to Notion");
  });
});

describe("everything else", () => {
  it("an ordinary question still goes to Ask", async () => {
    await ask("What does our Notion say about refunds?");
    expect(calls.some((c) => /\/api\/brain\/ask/.test(c.url))).toBe(true);
    expect(container.querySelector('[data-testid="notion-turn"]')).toBeNull();
  });

  it("off a project page the card offers the projects the viewer administers (preselected reply when there is one)", async () => {
    pathname = "/brain";
    projects = [
      { id: "p1", name: "Payments", type: "team", role: "admin" },
      { id: "p2", name: "Ops", type: "team", role: "editor" },
    ];
    const reply = await notionBrainReply({ kind: "link" }, { projects });
    expect(reply).toMatchObject({ kind: "card", projectId: "p1" });
    const none = await notionBrainReply(
      { kind: "link" },
      { projects: projects.map((p) => ({ ...p, role: "editor" })) },
    );
    expect(none).toMatchObject({ kind: "card", projects: [] });
  });
});

describe("the contracts", () => {
  it("the copies equal the contracts (LANDFLOW_BACKBONE_CONTRACTS)", () => {
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
