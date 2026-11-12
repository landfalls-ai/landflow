# Landflow on a phone

How Landflow's screens work below 768 px (Tailwind's `md`), where the layout changes. Part of the
[Landflow docs](README.md). The desktop layout doesn't change with any of this: phone-only rules sit behind `max-md:` or
the `usePhone()` hook (`lib/client/use-phone.ts`), and each change is checked against desktop screenshots taken before
it.

The plan came from a Fable review of every page at 390×844 (the fluency plan's wave 3). Its fifteen items are listed
under [What's next](#whats-next), and this page grows as they land.

## The shell

- **Tab bar.** A bar at the bottom with **Home**, **Flows** (Workflows and Templates), **Runs** (Executions and Search
  runs), **Agents** and **More** (`TabBar` in `components/shell/sidebar.tsx`). It replaces the old top bar and its menu
  button. **Runs** carries the number of things waiting for a person (`GET /api/runs/needs-you`, refreshed when a run
  waits or ends). **More** opens the rail as a drawer, grouped as on a desktop (Build, Extend, Settings, live status,
  theme, the look and the user menu). The bar pads for the home indicator (`env(safe-area-inset-bottom)`), and pages get
  the same room at their foot.
- **Full screen.** The editor (and its Executions and Evaluations tabs), an agent's page and a run's trace have no tab bar
  (`fullScreen()`): their own header starts with a back arrow, and the editor uses the whole height for the canvas and
  Spotlight.
- **App bar.** On a phone, each page's header (`PageHeader` in `components/shell/page-header.tsx`) shows the title
  whole, at 17 px, and the page's main action (its last one) on the first row. The other actions go on the next row (a
  search box there takes the row), and the meta line comes last. This is done in CSS only (the actions' box becomes
  `contents`, and its children order themselves), so nothing remounts.
- **Editor header.** Two rows. The first has back, the workflow's name, the saved state (a dot, read out as Saved or
  Unsaved), **Save** and **⋯**. The second has Editor, Executions and Evaluations, then **Publish** and version history.
  Tags are left out on a phone.
- **Touch and type.** Text fields are 16 px on a phone, so iOS doesn't zoom into them on focus. The page runs under the
  notch and home bar (`viewport-fit=cover`), and the tab bar and headers pad for them. A **Skip to content** link is the
  first stop for the keyboard (`#main`). Toasts sit above the tab bar.

## What's next

1. ~~Touch and type baseline~~ (above; the 44 px targets are done for the tab bar, the editor's back arrow and the header
   search, and the rest go with each screen below).
2. ~~Phone app bar~~.
3. ~~Bottom tab bar~~.
4. ~~Editor header that fits~~.
5. The node editor as a full-screen page: Parameters, Input, Output and Settings as segments, a sticky **Run step**,
   ‹ › between steps, and a `{}` picker that inserts fields by tapping.
6. Tap to open a step (tap selects, a second tap opens), no zoom rail, one canvas toolbar.
7. A Steps view as the phone's default: the flow as a list of step cards, with Steps | Canvas to switch.
8. Runs on the step cards, with a sticky Run bar in place of the Logs panel.
9. Spotlight's dock with three heights: bar, peek and half screen.
10. Executions as cards.
11. Sheets and full-screen dialogs, with dialog roles and focus kept inside.
12. No sideways scrolling: wide pages and tables become cards.
13. The agent page and Settings on a phone.
14. Lighter filters: search plus a **Filters** sheet.
15. An accessibility pass.
