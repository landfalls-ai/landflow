"use client";
/**
 * C27: MCP tools held for review (docs/agents.md#changed-mcp-tools-are-held). A banner on the agent page says how many tools a server
 * changed since the agent was published; Review opens a sheet with the old and the new content per tool (the kit's FieldDiff:
 * description, input schema, annotations), and Approve or Keep held per server. Tool text is shown as plain text, never as Markdown.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { refreshNeedsYou } from "@/lib/client/run-trace";
import type { FieldChange } from "@/lib/shared/field-change";
import {
  type AgentTrustView,
  type HeldToolsView,
  type ToolContent,
} from "@/lib/shared/trust";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { FieldDiff } from "../ui/field-diff";
import { Sheet } from "../ui/sheet";

type HeldChange = HeldToolsView["changes"][number];

const pretty = (value: unknown): string => JSON.stringify(value, null, 2) ?? "";
/** A flip towards "can change things" is the one to look at twice: read-only turned off, or destructive turned on. */
const riskier = (before: unknown, after: unknown): boolean => {
  const a = (before ?? {}) as {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
  const b = (after ?? {}) as {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
  return (
    (a.readOnlyHint === true && b.readOnlyHint !== true) ||
    (a.destructiveHint !== true && b.destructiveHint === true)
  );
};

/** The fields of one held tool as the kit's field diff takes them: old and new per changed field (an added tool: only the new). */
export function heldChangeFields(change: HeldChange): FieldChange[] {
  const kind =
    change.change === "added" ? ("added" as const) : ("changed" as const);
  const out: FieldChange[] = [];
  for (const field of change.fields) {
    const label =
      field === "inputSchema"
        ? "Input schema"
        : field === "annotations"
          ? "Annotations"
          : field === "title"
            ? "Title"
            : "Description";
    const text = (tool: ToolContent | undefined) => {
      const value = tool?.[field];
      return value === undefined
        ? undefined
        : typeof value === "string"
          ? value
          : pretty(value);
    };
    const before = text(change.before);
    const after = text(change.after);
    out.push({
      field,
      label,
      kind,
      ...(before !== undefined && { before }),
      ...(after !== undefined && { after }),
      ...((field === "inputSchema" || field === "annotations") && {
        long: true,
      }),
      ...(field === "annotations" &&
        riskier(change.before?.annotations, change.after.annotations) && {
          tone: "bad" as const,
        }),
    });
  }
  return out;
}

export const heldTotal = (held: HeldToolsView[]): number =>
  held.reduce((sum, h) => sum + h.changes.length, 0);
export const heldLine = (n: number): string =>
  `${n} MCP tool${n === 1 ? "" : "s"} changed since this agent was published`;

/** The banner: how many tools are held, and a Review button. Renders nothing when none are. */
export function HeldToolsBannerView({
  held,
  onReview,
}: {
  held: HeldToolsView[];
  onReview: () => void;
}) {
  const n = heldTotal(held);
  if (!n) return null;
  return (
    <div
      role="status"
      data-testid="held-tools-banner"
      className="mx-auto mt-4 flex w-[calc(100%-2rem)] max-w-[680px] flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-warn px-3 py-2 text-[12.5px] leading-snug text-warn sm:w-[calc(100%-3rem)]"
    >
      <ShieldAlert className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <span className="font-semibold">{heldLine(n)}.</span>{" "}
        <span className="text-t2">
          Runs go on without {n === 1 ? "it" : "them"} until you review.
        </span>
      </span>
      <button
        type="button"
        onClick={onReview}
        className="min-h-7 font-semibold text-ac hover:underline max-md:min-h-11"
      >
        Review
      </button>
    </div>
  );
}

/** The review sheet: per server, each tool with its fields old → new, then Approve and Keep held. */
export function HeldToolsSheet({
  held,
  open,
  busy,
  canDecide = true,
  onClose,
  onDecide,
}: {
  held: HeldToolsView[];
  open: boolean;
  /** Approve and Keep held are shown only to someone who may change the agent. */
  canDecide?: boolean;
  busy?: string;
  onClose: () => void;
  onDecide: (view: HeldToolsView, decision: "approve" | "reject") => void;
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Review changed MCP tools"
      className="md:max-w-[640px]"
    >
      <p className="mb-3 text-[12.5px] leading-snug text-t2">
        A server changed these tools after this agent was published, so runs go
        on without them. The text below is what the server says now; read it
        before you approve. Approving lets the next run offer them.
      </p>
      <div className="space-y-5">
        {held.map((view) => (
          <section key={view.subjectId} aria-label={view.toolConfigName}>
            <h3 className="text-[13px] font-semibold text-t1">
              {view.toolConfigName}
            </h3>
            <div className="mt-2 space-y-3">
              {view.changes.map((change) => (
                <div
                  key={change.name}
                  className="rounded-xl border border-hair px-3 py-2.5"
                >
                  <div className="mb-1.5 flex items-center gap-2">
                    <span className="min-w-0 truncate font-mono text-[12px] font-semibold text-t1">
                      {change.name}
                    </span>
                    <Badge
                      tone={change.change === "added" ? "accent" : "warning"}
                    >
                      {change.change === "added"
                        ? "New on the server"
                        : "Changed"}
                    </Badge>
                  </div>
                  <FieldDiff changes={heldChangeFields(change)} unchanged={0} />
                </div>
              ))}
            </div>
            {canDecide ? (
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={Boolean(busy)}
                  loading={busy === `${view.subjectId}:reject`}
                  onClick={() => onDecide(view, "reject")}
                >
                  Keep held
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={Boolean(busy)}
                  loading={busy === `${view.subjectId}:approve`}
                  onClick={() => onDecide(view, "approve")}
                >
                  Approve
                </Button>
              </div>
            ) : (
              <p className="mt-3 text-[12px] text-t3">
                Only someone who can change this agent can approve or keep these
                held.
              </p>
            )}
          </section>
        ))}
      </div>
    </Sheet>
  );
}

/**
 * The agent page's part: reads the agent's holds, shows the banner and the sheet. `refreshKey` changes when a test chat closes, so a
 * hold a test run just found shows without a reload; the list is read again on focus too.
 */
export function HeldToolsBanner({
  agentId,
  refreshKey,
}: {
  agentId: string;
  refreshKey?: unknown;
}) {
  const [held, setHeld] = useState<HeldToolsView[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [canDecide, setCanDecide] = useState(true);
  const asked = useRef(false);
  const load = useCallback(() => {
    api<AgentTrustView>(`/api/agents/${encodeURIComponent(agentId)}/trust`)
      .then((view) => {
        setHeld(view.held);
        setCanDecide(view.canDecide !== false);
        // Needs you's Review link arrives with ?review=tools: open the sheet once.
        if (
          view.held.length &&
          typeof window !== "undefined" &&
          new URLSearchParams(window.location.search).get("review") ===
            "tools" &&
          !asked.current
        ) {
          asked.current = true;
          setOpen(true);
        }
      })
      .catch(() => undefined);
  }, [agentId]);
  useEffect(load, [load, refreshKey]);
  useEffect(() => {
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  const decide = async (
    view: HeldToolsView,
    decision: "approve" | "reject",
  ) => {
    setBusy(`${view.subjectId}:${decision}`);
    try {
      await api(`/api/agents/${encodeURIComponent(agentId)}/trust`, {
        method: "POST",
        json: { subjectId: view.subjectId, hash: view.hash, decision },
      });
      toast.success(
        decision === "approve"
          ? `Approved. The next run offers the ${view.toolConfigName} tools again.`
          : `Kept held. The ${view.toolConfigName} tools stay out of runs.`,
      );
      const rest = held.filter((h) => h.subjectId !== view.subjectId);
      setHeld(rest);
      if (!rest.length) setOpen(false);
      refreshNeedsYou();
      load();
    } catch (e) {
      toast.error((e as Error).message);
      load(); // the server may have changed again: show what is pending now
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <>
      <HeldToolsBannerView held={held} onReview={() => setOpen(true)} />
      <HeldToolsSheet
        held={held}
        open={open}
        busy={busy}
        canDecide={canDecide}
        onClose={() => setOpen(false)}
        onDecide={(view, decision) => void decide(view, decision)}
      />
    </>
  );
}
