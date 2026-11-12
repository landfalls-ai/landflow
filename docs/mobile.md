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

## The Steps view

On a phone the editor opens on **Steps**: the flow as a list of cards in the order it runs (`StepList` in
`components/editor/step-list.tsx`, ordered by `stepOrder()` in `step-order.ts`). **Steps | Canvas** at the top left
switches to the flow chart and back; the canvas stays loaded underneath. A desktop always shows the canvas.

- **The order.** From the triggers (top first), along the main connections, like a program's blocks. A step with more
  than one way on (an If, a Switch) opens one indented group per output, labelled with the output's name (*true*,
  *false*). A step that several lead into (a Merge, or one step that two triggers share) comes once all of them are
  listed, back where the split was, so after a branch the main line goes on. A connection back to an earlier step (a
  loop) shows as *then “Loop”* on the step it comes from. Steps that nothing reaches are listed at the end.
- **The cards.** Each shows the step's number, name and kind, and how its last run went: a tick with its items and
  time, a red mark with the error, or a spinner while it runs. Off, pinned output and a breakpoint show as marks.
  Sub-nodes (a chat model, a tool, a memory, and theirs) are chips on the step they serve, and a tap opens them.
- **Opening and adding.** A tap opens the step full screen ([the node editor](#the-node-editor)). **Add a step** at the
  end opens the node picker, connected from the last step that doesn't go on yet.
- **Runs.** **Execute workflow** stays at the foot. In the Steps view the Logs panel is hidden on a phone, because the
  cards say how each step went; the Canvas view still has it.

## The canvas and the node editor

- **Tap to open.** On a phone the first tap on a step selects it (its toolbar shows above it), and a second tap opens it.
  A double tap still opens it too. Tapping the canvas starts again.
- **One toolbar.** The zoom rail is gone (pinch to zoom). The toolbar at the top right keeps add a step, add a note, tidy
  up and fit view, gets **Undo** and **Redo**, and its buttons are 44 px.

### The node editor

On a phone a step opens full screen (`NodePanel` in `components/editor/node-panel.tsx`), with a back arrow and the step's
name at the top. Under it, **Input**, **Parameters**, **Output** and **Settings** show one pane at a time (a trigger has
no Input). At the foot, **‹** and **›** move to the step before and after, and **Run step** runs just this step and then
shows its output. The pane stays as you move between steps, so outputs can be compared one step at a time (a trigger,
which has no Input, shows Parameters); opening a step from the canvas starts at Parameters, or at Input when a debug run is
paused before it. **Breakpoint** and **Run from here** lead the Settings pane. A phone can't drag a field from Input into a parameter, so each field that takes one
has a **{}** beside it: it lists the input's fields, with a sample of each, and a tap puts `{{ $json.field }}` in (an
empty field is replaced, otherwise it goes after a space, as a drop does). Rows of a collection (Name, Type, Value) stack
on a phone, and their remove button shows without hovering. Focus moves to the back arrow when the
editor opens, and toasts sit just above the foot bar.

## Spotlight's dock

On a phone Spotlight is a sheet under the steps or the canvas, with three heights:

- **Bar** (the default on a phone): its header, the step it is on, and the box.
- **Peek**: about a third of the screen, the newest of its timeline (a reply, a run, **Needs you**, the outcome).
- **Half**: half the screen, the whole timeline.

Drag its header up or down for the next height (`setDock` in `components/editor/assistant.ts`); the chevron goes between
the bar and half. As on a desktop, only you move it: a reply, a draft or a test session leaves it where it is, and the
folded bar already says what Spotlight is doing.

## Lists and filters

- **Executions as cards.** On a phone each run is a card: the workflow and its menu on the first line, the status and how
  long it ran on the second, and when it started (with how long ago) on the third. The run's id, its mode and the column
  headings are left out, and an error shows two lines. The desktop keeps its table (`app/executions/page.tsx`).
- **No sideways scrolling.** No page scrolls sideways at 390 px: a plugin card's chips wrap, the Developers page breaks
  long inline code, and pages pad 16 px instead of 24. Strips that are meant to scroll (a segment control, the Settings
  tabs) scroll inside themselves.

### Filters

`PhoneFilters` (`components/ui/phone-filters.tsx`) leaves its children where they are on a desktop. On a phone it shows a
**Filters** button instead, with how many filters are on, and opens them in a sheet with **Clear** and **Show results**,
so the page's content starts on the first screen. Marketplace (source, marketplace and categories), Templates
(categories), Agents (which agents, and how they're grouped) and Search runs (everything but the words) use it. On
Search runs, **Show results** also runs the search.

The sheet is `Sheet` (`components/ui/sheet.tsx`): a bottom sheet on a phone and a centred dialog on a desktop, with
`role="dialog"`, focus kept inside (Tab wraps, Escape closes), the page's scroll locked and focus returned to the button
that opened it.

## Settings and agents

- **Settings** is a list on a phone: each section as a row with its hint (Time zone and execution retention, $vars for
  expressions…). A tap opens it alone, with **‹ Settings** to go back; the address keeps its `#section`, so a link to
  `/settings#users` opens Users. A desktop keeps the sections beside the page.
- **An agent's page** keeps its header on screen as you scroll, and every change saves itself (its ✓ is read out as
  *Saved* on a phone), so there is no Save to reach for.

## What's next

1. ~~Touch and type baseline~~ (above; the 44 px targets are done for the tab bar, the editor's back arrow and the header
   search, and the rest go with each screen below).
2. ~~Phone app bar~~.
3. ~~Bottom tab bar~~.
4. ~~Editor header that fits~~.
5. ~~The node editor as a full-screen page~~, with a **{}** picker for input fields.
6. ~~Tap to open a step, no zoom rail, one canvas toolbar~~.
7. ~~A Steps view as the phone's default~~.
8. ~~Runs on the step cards~~ (the Execute bar stays at the foot in place of the Logs panel).
9. ~~Spotlight's dock with three heights~~.
10. ~~Executions as cards~~.
11. Sheets and full-screen dialogs, with dialog roles and focus kept inside (`Sheet` is in, used by Filters; the other
    dialogs are still the desktop's).
12. ~~No sideways scrolling~~.
13. ~~The agent page and Settings on a phone~~.
14. ~~Lighter filters~~.
15. An accessibility pass.
