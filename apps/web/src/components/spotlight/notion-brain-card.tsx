"use client";
/**
 * "Brain in Notion · <project>" on Spotlight's reply (docs/spotlight.md#moving-a-brain-to-notion). It offers the project's
 * Notion keys by name (the one fitting key preselected; with two or more, none), opens the credential dialog for "New Notion
 * key" (the person types the secret there: this card never sees one), checks the page, shows what a copy would do, and
 * connects on the person's click only. While the copy runs it folds to one progress line, and the project page's Brain card
 * keeps showing it when the panel closes. A viewer who is not the project's admin is told who can.
 */
import { useEffect, useId, useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "../ui/button";
import { CredentialDialog } from "../credentials/credential-dialog";
import { useCredentialStore } from "../credentials/use-credentials";
import {
  NEVER_PUSHED,
  type CheckResult,
  type LinkView,
} from "@/lib/shared/notion-brain";
import {
  NOTION_KEY_TYPE,
  checkNotionPage,
  connectNotion,
  copyLine,
  notionLink,
  preselectedKey,
  projectNotionKeys,
  statusSentence,
  type NotionKey,
} from "@/lib/client/notion-brain";
import {
  notionBrainCardData,
  type NotionBrainCardData,
  type NotionBrainReply,
  type TurnProject,
} from "./notion-brain-turn";

type CardReply = Extract<NotionBrainReply, { kind: "card" | "key" }>;

/** "New Notion key": the credential dialog for the one type, in the project when it is known. The secret is typed there. */
function NewKeyButton({
  projectId,
  onSaved,
  variant = "ghost",
}: {
  projectId?: string;
  onSaved?: () => void;
  variant?: "ghost" | "outline";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant={variant}
        className="max-md:h-11"
        onClick={() => {
          // The dialog reads the credential types the store holds: load them before it opens.
          void useCredentialStore.getState().refresh();
          setOpen(true);
        }}
      >
        New Notion key
      </Button>
      {open && (
        <CredentialDialog
          overSheet
          allowedTypes={[NOTION_KEY_TYPE]}
          {...(projectId && { projectId })}
          onClose={() => setOpen(false)}
          onSaved={() => {
            void useCredentialStore.getState().refresh();
            onSaved?.();
          }}
        />
      )}
    </>
  );
}

const countsLine = (c: CheckResult["counts"]) =>
  `${c.pages} pages · ${c.facts} facts · ${c.practices} practices · ${c.notes} notes`;

export function NotionBrainCard({ reply }: { reply: CardReply }) {
  const group = useId();
  const projects: TurnProject[] = reply.kind === "card" ? reply.projects : [];
  const [projectId, setProjectId] = useState(reply.projectId ?? "");
  const [data, setData] = useState<NotionBrainCardData | undefined>(
    reply.kind === "card" ? reply.data : undefined,
  );
  const [failed, setFailed] = useState<string>();
  const [chosen, setChosen] = useState(
    reply.kind === "card" ? (reply.data?.preselected?.id ?? "") : "",
  );
  const [page, setPage] = useState(
    reply.kind === "card" ? (reply.page ?? "") : "",
  );
  const [check, setCheck] = useState<CheckResult>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<LinkView | undefined>(
    reply.kind === "card" && reply.data?.link.linked
      ? reply.data.link
      : undefined,
  );
  const name = projects.find((p) => p.id === projectId)?.name ?? "this project";

  // The person named another project: read its link and keys.
  const choose = (id: string) => {
    setProjectId(id);
    setData(undefined);
    setLink(undefined);
    setCheck(undefined);
    setProblem(undefined);
    setChosen("");
    setFailed(undefined);
    if (!id) return;
    notionBrainCardData(id).then(
      (d) => {
        setData(d);
        setChosen(d.preselected?.id ?? "");
        if (d.link.linked) setLink(d.link);
      },
      (e: Error) => setFailed(e.message),
    );
  };

  // While the copy runs, read its progress (a background read) until it is done.
  const copying =
    link && (link.status === "copying" || link.status === "setting_up");
  useEffect(() => {
    if (!projectId || !copying) return;
    const timer = setInterval(() => {
      notionLink(projectId, true).then(
        (view) => view.linked && setLink(view),
        () => undefined,
      );
    }, 3000);
    return () => clearInterval(timer);
  }, [projectId, copying]);

  if (reply.kind === "key")
    return (
      <div className="flex flex-wrap gap-1.5" data-testid="notion-brain-card">
        <NewKeyButton
          {...(reply.projectId && { projectId: reply.projectId })}
          variant="outline"
        />
      </div>
    );

  const keys = data?.keys ?? [];
  const refreshKeys = () =>
    void projectNotionKeys(projectId).then(
      (list: NotionKey[]) => {
        setData((d) => (d ? { ...d, keys: list } : d));
        setChosen((cur) =>
          list.some((k) => k.id === cur)
            ? cur
            : (preselectedKey(list)?.id ?? ""),
        );
      },
      () => undefined,
    );

  const run = async (step: () => Promise<void>) => {
    setBusy(true);
    setProblem(undefined);
    try {
      await step();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const heading = (
    <p className="text-[12.5px] font-semibold text-t1">
      Brain in Notion · {name}
    </p>
  );
  const shell = (children: ReactNode) => (
    <div
      className="min-w-0 space-y-2 rounded-xl border border-hair bg-bg p-2.5 text-[12.5px] text-t2"
      data-testid="notion-brain-card"
    >
      {heading}
      {children}
    </div>
  );

  if (!projectId)
    return shell(
      <label className="block space-y-1">
        <span className="text-t3">Which project’s brain?</span>
        <select
          className="block min-h-9 w-full rounded-lg border border-hair bg-sf px-2 text-t1 max-md:min-h-11"
          value=""
          onChange={(e) => choose(e.target.value)}
          aria-label="Project"
        >
          <option value="">
            {projects.length
              ? "Pick a project you administer"
              : "You administer no project"}
          </option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>,
    );
  if (failed)
    return shell(
      <p role="status">I couldn’t read the Notion link: {failed}</p>,
    );
  if (!data) return shell(<p className="text-t3">Looking…</p>);

  if (link) {
    const progress = copyLine(link.copy);
    const open = link.rootUrl ?? link.brainUrl;
    return shell(
      <>
        <p>{statusSentence(link)}</p>
        {progress && (
          <div className="space-y-1" role="status">
            <div className="h-1.5 overflow-hidden rounded-full bg-hair">
              <div
                className="h-full rounded-full bg-ac transition-[width]"
                style={{ width: `${Math.round(progress.fraction * 100)}%` }}
              />
            </div>
            <p className="text-t3">{progress.words}</p>
          </div>
        )}
        {open && (
          <a
            href={open}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-7 items-center gap-1 text-ac hover:underline max-md:min-h-11"
          >
            Open in Notion <ExternalLink className="size-3" aria-hidden />
          </a>
        )}
      </>,
    );
  }

  if (!data.canManage)
    return shell(<p>An admin of {name} can move its brain to Notion.</p>);

  const fits = keys.find((k) => k.id === chosen);
  return shell(
    <>
      <div className="space-y-1">
        <p className="text-t3">Notion key</p>
        {keys.length ? (
          <div role="radiogroup" aria-label="Notion keys" className="space-y-1">
            {keys.map((k) => (
              <label
                key={k.id}
                className="flex cursor-pointer items-center gap-2 rounded-lg border border-hair bg-sf px-2 py-1.5 text-t1 max-md:min-h-11 has-[:checked]:border-ac has-[:checked]:bg-acbg"
              >
                <input
                  type="radio"
                  name={group}
                  value={k.id}
                  checked={chosen === k.id}
                  onChange={() => {
                    setChosen(k.id);
                    setCheck(undefined);
                  }}
                  className="size-3.5 shrink-0 accent-[var(--ac)]"
                />
                <span className="min-w-0 truncate">{k.name}</span>
              </label>
            ))}
          </div>
        ) : (
          <p className="text-t3">
            None yet. A key is your Notion connection’s secret.
          </p>
        )}
        <div className="flex flex-wrap gap-1.5">
          {keys.length > 1 && !fits && (
            <span className="self-center text-t3">Pick one.</span>
          )}
          <NewKeyButton projectId={projectId} onSaved={refreshKeys} />
        </div>
      </div>
      <label className="block space-y-1">
        <span className="text-t3">Notion page to keep the brain under</span>
        <input
          className="block min-h-9 w-full rounded-lg border border-hair bg-sf px-2 text-t1 max-md:min-h-11"
          value={page}
          onChange={(e) => {
            setPage(e.target.value);
            setCheck(undefined);
          }}
          placeholder="https://www.notion.so/…"
          aria-label="Notion page"
        />
      </label>
      {check && (
        <div className="space-y-1" role="status">
          <p className="text-t1">
            {check.title}
            {check.existingBrain.found
              ? " · a Landflow brain is already there and is reused"
              : ""}
          </p>
          <p>
            A copy puts {countsLine(check.counts)} there, about{" "}
            {check.estimateMinutes} min.
          </p>
          <p className="text-t3">{NEVER_PUSHED}</p>
        </div>
      )}
      {problem && (
        <p role="alert" className="text-rd">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant="outline"
          className="max-md:h-11"
          disabled={busy || !fits || !page.trim()}
          onClick={() =>
            run(async () =>
              setCheck(
                await checkNotionPage(projectId, {
                  credentialId: fits!.id,
                  page: page.trim(),
                }),
              ),
            )
          }
        >
          Check
        </Button>
        <Button
          size="sm"
          variant="primary"
          className="max-md:h-11"
          disabled={busy || !fits || !check}
          onClick={() =>
            run(async () => {
              const view = await connectNotion(projectId, {
                credentialId: fits!.id,
                page: page.trim(),
              });
              setLink(view);
            })
          }
        >
          Connect and copy
        </Button>
      </div>
    </>,
  );
}
