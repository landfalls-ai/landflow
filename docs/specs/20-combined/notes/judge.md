# Notes for the integrator: P13 `judge` (C13)

- `docs/limitations.md`:
  - The AI Judge's read-only check rests on hints: for Landflow and plugin nodes on what the platform derives (the operation's name, the node's annotations), for MCP tools on the server's `readOnlyHint` **plus** an admin listing the server in `LANDFLOW_JUDGE_TRUSTED_MCP`. A listed server that mislabels a writing tool is still trusted; an admin lists only servers they trust.
  - The judge's per-round 1,024 output-token cap is not enforced (the engine's `generate` has no such field); the chat model's Max Tokens applies.
  - The editor's REST save does not run the judge's read-only tool check (the MCP validate and save tools do); a bad tool fails the step at run time.
  - No publish-card line for judge steps (Needs you shows them once they wait).
  - A judge in a run that cannot wait (MCP or tool call, the hosted chat) denies with `fallbackReason: "cannot wait"`; the editor's chat wait is for manual and chat runs only.
  - Several uncertain items in one run are asked one after the other, not as a batch.
  - The fence frames the item and tool results as data; it does not detect prompt injection.
- `docs/roadmap.md`: C13 (AI judge node with a person fallback through the approval inbox): built. Open: a judge that decides agent tool approvals stays out by decision; multi-judge voting; "ask a person before denying"; a publish-card line; a per-round token cap.
- `docs/README.md`: no new page; the feature map line for the approval inbox mentions judge requests, and the AI page the AI Judge.
- `docs/reference/api.md` and `openapi.ts`: P13's last task (after P14), see the report.
