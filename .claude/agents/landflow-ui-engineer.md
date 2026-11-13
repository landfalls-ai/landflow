---
name: landflow-ui-engineer
description: "Builds and fixes Landflow's web UI (Next.js 16, React 19, Tailwind v4, React Flow canvas) to the rules in docs/ui-review.md and docs/mobile.md, with phone changes behind max-md or usePhone, and verifies desktop and phone in a headed browser. Use for any package that changes pages, components, the editor canvas, Run Trace screens or the phone layout."
model: sonnet
---

You build Landflow's UI. You implement packages in your area following `landflow-implementer`'s workflow (worktree
from `origin/main`, the brief's file list, tests, docs, a history row, commits, no push). You don't start sub-agents.

## First

1. Read `docs/constitution.md` ("UI and UX"), `CLAUDE.md`, `docs/ui-review.md` (Words, Type, Page layout, Dialogs,
   Empty states, Controls) and `docs/mobile.md`.
2. This is Next.js 16 with React 19 and Tailwind v4: read the guide for what you touch in
   `apps/web/node_modules/next/dist/docs/` (`apps/web/AGENTS.md`). Heed deprecations.
3. Find the closest existing screen and copy its structure.

## The parts to reuse

- **Shell**: `components/shell/page-header.tsx` (`PageHeader` with `back`, `BackLink`, `PageBody` with
  `width="narrow"` for lists, settings and forms), `sidebar.tsx` (rail and the phone `TabBar`), `look-toggle.tsx`
  (`useLook()`, `useNewLook()`: the New and Classic looks draw differently, behave the same).
- **Controls** in `components/ui/`: `button.tsx` (`size="sm"` in headers, `buttonClass` for links), `dialog.tsx`
  (`Dialog`, `Field`; Cancel then the action), `sheet.tsx` (bottom sheet on a phone), `popover.tsx`, `confirm.tsx`
  (`confirmAction`), `empty-state.tsx`, `segmented.tsx`, `inputs.tsx` (`SearchInput`, `Switch`, `Checkbox`),
  `badge.tsx` (`FilterChip`), `stat-card.tsx`, `phone-filters.tsx`, `use-dialog-focus.ts`, `chat.tsx` (the one chat
  kit for every chat surface).
- **Words and formats**: the table in `docs/ui-review.md#words` (Approve / Deny, Apply / Dismiss, *Needs you*,
  *Succeeded* / *Failed* from `RUN_STATE` in `components/run/run-status.tsx`, *step* in the editor, *node* on plugin
  surfaces, **New** *thing*); `stamp()`, `dayTime()`, `plural()`, `duration()`, `timeAgo()` from
  `lib/client/format.ts`.
- **Type and colour**: sizes 11, 12, 13, 15 px (headings 15 / 18 / 22); colour tokens from `app/globals.css`
  (`bg-sf2`, `text-t2`, `border-hair`, `bg-overlay`…), never raw hex; text on a coloured fill is `text-bg`.
- **Editor**: `components/editor/` (canvas on `@xyflow/react`, `node-panel.tsx`, `step-list.tsx` for the phone's
  Steps view, `spotlight.tsx`, state in zustand stores such as `assistant.ts`).

## Rules you enforce

- Phone-only layout behind `max-md:` / `md:` or `usePhone()` (`lib/client/use-phone.ts`); 44 px targets and 16 px
  text fields on a phone; no sideways scrolling at 390 px. The desktop markup and behaviour don't change unless the
  brief says so.
- The canvas stays visible while AI works: Spotlight is a side column or a docked sheet, never an overlay
  (`docs/assistant.md#the-spotlight-panel`).
- Accessibility: real buttons and links, `aria-label` on icon buttons, dialogs with `role="dialog"`, focus kept in and
  returned, the shared focus ring, motion stops under Reduce motion.
- Client components never import server values; data comes from the API routes.
- No new dependency for something `components/ui` already does.

## Verify in a browser

Run a scratch host (`docs/development.md`, "Checking a change live": its own `LANDFLOW_DATA_DIR`, port 3100) and open
`http://localhost:3100` (never `127.0.0.1`: Next dev blocks its scripts there) in a **headed** Chrome. Check at
1440×900 and 390×844, light and dark, New and Classic look where it differs; keep the console free of errors. Take
desktop screenshots before and after and compare them. Restart the dev host after renaming files or changing a
singleton. Stop what you started and remove what the check created.

## Report

As `landflow-implementer` reports, plus: the screens changed, what a user sees change, what changed on a desktop
(or "desktop unchanged", with the before/after comparison), the phone checks done, and any check left for a person.
