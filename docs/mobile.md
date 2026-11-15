# Landflow on a phone

How Landflow's screens work below 768 px (Tailwind's `md`), where the layout changes. Part of the
[Landflow docs](README.md). The desktop layout doesn't change with any of this: phone-only rules sit behind `max-md:` or
the `usePhone()` hook (`lib/client/use-phone.ts`), and each change is checked against desktop screenshots taken before
it.

The plan came from a Fable review of every page at 390×844 (the fluency plan's wave 3). Its fifteen items are listed
under [What's next](#whats-next), and this page grows as they land.

## The shell

- **Tab bar.** A bar at the bottom with **Home**, **Flows** (Workflows and Templates), **Runs** (Activity, Insights, AI and
  Search), **Agents** and **More** (`TabBar` in `components/shell/sidebar.tsx`). It replaces the old top bar and its menu
  button. **Runs** carries the number of things waiting for a person (`GET /api/runs/needs-you`, refreshed when a run
  waits or ends). **More** opens the rail as a drawer, with the same nine places as on a desktop (Home, Workflows,
  Runs, Agents, Brain, Data tables, Credentials, Plugins, Settings) and the user menu. The section tabs (Templates,
  Runbooks, Insights, Search, Marketplace…) show above a list page as a row that scrolls sideways, so every page stays
  reachable. The bar pads for the home indicator (`env(safe-area-inset-bottom)`), and pages get the same room at their
  foot.
- **Full screen.** The editor (and its Runs and Tests tabs), an agent's page and a run's trace have no tab bar
  (`fullScreen()`): their own header starts with a back arrow, and the editor uses the whole height for the canvas and
  Spotlight.
- **App bar.** On a phone, each page's header (`PageHeader` in `components/shell/page-header.tsx`) shows the title
  whole, at 17 px, and the page's main action (its last one) on the first row. The other actions go on the next row (a
  search box there takes the row), and the meta line comes last. This is done in CSS only (the actions' box becomes
  `contents`, and its children order themselves), so nothing remounts.
  On a project's Overview, **Export** and **New ▾** share one box, so both sit on the title's row (the header moves only its last action there); the other tabs have Export alone, in the same place.
- **Editor header.** Two rows. The first has back, the workflow's name, the saved state (a dot, read out as Saved or
  Unsaved) and **⋯**. The second has Editor, Runs and Tests, then **Publish**. There is no Save (a draft saves itself;
  a failed save's toast has **Retry**) and no "Not published" chip: **Publish** carries the state ("Publish" or
  "Live v3"). Tags and Version history are in **⋯**, as on a desktop.
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
  up and fit view, gets **Undo** and **Redo**, and its buttons are 44 px. (A desktop has the same toolbar plus zoom in
  and out.) The header keeps its two rows; Save, Run and Spotlight are not there: a draft saves itself, the Execute bar
  runs it and the Spotlight sheet is under the canvas.

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

## One Spotlight on a phone

Spotlight outside the editor is a bottom sheet (docs/spotlight.md#one-spotlight): open it from the "Ask or build…" button at
the top of the More drawer. It has three heights (34, 52 and 85 per cent of the screen; the arrows beside the chip step
through them), a chip that says what it does, and closes on a tap outside or Escape. The editor keeps its own sheet under
the canvas, so the canvas stays in view while it builds.

## Spotlight's dock

On a phone Spotlight is a sheet under the steps or the canvas, with three heights:

- **Bar** (the default on a phone): its header, the step it is on, and the box.
- **Peek**: about a third of the screen, the newest of its timeline (a reply, a run, **Needs you**, the outcome).
- **Half**: half the screen, the whole timeline.

Drag its header up or down for the next height (`setDock` in `components/editor/assistant.ts`); the chevron goes between
the bar and half. As on a desktop, only you move it: a reply, a draft or a test session leaves it where it is, and the
folded bar already says what Spotlight is doing. When a change waits, the folded bar also shows the amber needs-you icon with
**Review** (opens the sheet to half) and **Apply**, both 44 px, so a change can be applied without opening the sheet. The sheet's
height eases between its three heights (the bar as measured, peek, half) over 240 ms, follows the header drag and settles on the nearest height; on a first visit a note card explains how Spotlight works; under Reduce motion it switches.

## Lists and filters

- **Executions as cards.** On a phone each run is a card: the workflow and its menu on the first line, the status and how
  long it ran on the second, and when it started (with how long ago) on the third. The run's id, its mode and the column
  headings are left out, and an error shows two lines. The desktop keeps its table (`components/runs/runs-list.tsx`, at `/runs`).
- **Workflow rows.** On a phone a row of the Workflows list keeps only the name and when it changed on its first line;
  Shared, Published and the last run's badge move to the second line, in front of at most three node icons (the strip
  clips when the badges need the room) and without the description (`WorkflowRow` in
  `components/workflows/workflows-list.tsx`). The desktop row is unchanged.
- **Credential rows.** On a phone a row of the Credentials list keeps the icon, the name and the type on its first line;
  its badges, "Used by …" and "Updated …" move to a second line under the name, and its ⋯ menu shows without hovering
  (`app/credentials/page.tsx`: the second line is a wrapper that is `display: contents` on a desktop). The desktop row
  is unchanged.
- **No sideways scrolling.** No page scrolls sideways at 390 px: a plugin card's chips wrap, the Developers page breaks
  long inline code, and pages pad 16 px instead of 24. Strips that are meant to scroll (a segment control, the Settings
  tabs) scroll inside themselves.

### Filters

`PhoneFilters` (`components/ui/phone-filters.tsx`) leaves its children where they are on a desktop. On a phone it shows a
**Filters** button instead, with how many filters are on, and opens them in a sheet with **Clear** and **Show results**,
so the page's content starts on the first screen. Marketplace (source, marketplace and categories), Templates
(categories), Agents (which agents, and how they're grouped) use it. The Runs list has its own row: the search box and the Status and Workflow chips wrap on one block, and **More filters** opens as a sheet.

The sheet is `Sheet` (`components/ui/sheet.tsx`): a bottom sheet on a phone and a centred dialog on a desktop, with
`role="dialog"`, focus kept inside (Tab wraps, Escape closes), the page's scroll locked and focus returned to the button
that opened it.

## Sheets and dialogs

On a phone, what floats on a desktop rises from the bottom or takes the screen:

- **Menus and confirmations** (`Popover` in `components/ui/popover.tsx`: the workflow's ⋯, Publish, row menus, the
  project switcher, delete confirmations) open as a bottom sheet (`Sheet`) with 44 px rows, closed by Close, Escape or a
  tap on the backdrop.
- **Dialogs** (the shell in `components/agents/dialog.tsx` that Share, Move, Import, Save as template, folders and the
  agent dialogs use; credentials; data tables) are bottom sheets, full width, up to 92% of the screen, with a 44 px Close.
- **Full screen:** the node picker (**What happens next?**), version history (the list above the preview), the node
  editor and a marketplace plugin's drawer. **Add marketplace** is a bottom sheet.
- **Where an agent is available.** **Make available…** and **What it will be given** (in the test chat) are the shared
  dialog, so on a phone they are bottom sheets with 44 px checkboxes; the project picker above the test chat is a 40 px
  select, and the preview's text scrolls inside its sheet. The Agents list's "Available in" line is one truncated line
  on a card. A desktop is unchanged.
- **"Are you sure?"** Before a step that can't be taken back (deleting a transport connection or a secrets provider,
  replacing the MCP access token, letting node parameters read `$secrets`, a suggestion's action that asks first),
  `confirmAction` (`components/ui/confirm.tsx`) asks in a sheet with the question, **Cancel** and the action, both 44 px;
  on a desktop it is the browser's own confirm, as before.
- **Focus.** Each of these is a dialog to a screen reader (`role="dialog"`, `aria-modal`), and `useDialogFocus`
  (`components/ui/use-dialog-focus.ts`) moves the focus in, keeps Tab inside, and gives it back to what opened it; only
  the topmost dialog takes the keys, so a credential opened from an agent's dialog closes first. The More drawer is one
  too, and Escape closes it. The Run Trace's sheets (a step, an artifact, a check, a person) and its **Debug access**
  dialog keep Tab inside them on every screen. On a desktop the other menus and dialogs keep their place and their focus
  behaviour.

## Accessibility

- 44 px targets on a phone: the tab bar, the More drawer's links and user menu, Spotlight's header buttons, Send, Stop,
  Dictate and Autonomous, the node editor's panes, the Steps | Canvas switch, an Executions card's menu and its
  confirmation, the canvas menu's rows.
- The Runs tab reads its badge as *3 waiting for you*; an Executions card's link reads the workflow and how the run
  ended; on a phone the Executions table keeps its column headings for a screen reader (hidden on screen).
- The Steps view says, in one line read out as a run moves, which step runs, which failed and why, or how many ran. An
  Off step has a dashed border instead of being faded, so its text keeps its contrast.
- Motion: everything that animates stops under *Reduce motion* (`app/globals.css`).

### Home

Home starts with the **Your morning** card ([work-and-briefings.md](work-and-briefings.md#on-the-web)): one column, lists folded to three items, and **Change**, **Show more** and **Set up tomorrow sync** are 44 px tall.

### Project settings

The cards **Agents in this project** and **AI budget** in a project's Settings tab are one column at 390 px; their checkboxes, **Ask for more…** and the buttons are 44 px tall. In **Needs you**, an AI budget row has its title as the link and its buttons (**Resume this month**, **Raise budget…**, **Dismiss**, **Open project**) on a line below, each 44 px tall. Desktop is as it was apart from the two cards and the rows.

The **Workspace** card after them is one column too: the default branch and branch template fields, the add field and its button,
and **Save** are 44 px tall on a phone, and each repository's **Remove** is a 44 px target. Desktop is as it was apart from the card.

### Project tasks

The **Tasks** tab of a project is one column at 390 px. The five tabs scroll sideways inside their switch rather than
overflowing the page. The status filter scrolls the same way, and **Mine**, **New task** and **Load more** are 44 px tall.
Each task is a card (title with its priority, assignee, next wake-up, last run) instead of a row, the whole card a 44 px
target. The task dialog rises as a bottom sheet with 44 px fields, wake-up choice, **Check out**, **Ask to run now**,
**Approve**, **Deny**, **Open session** and **Delete**. A task row in **Needs you** has its title as the link and **Approve**,
**Deny** and **Open task** below it, 44 px each. Desktop is as it was apart from the tab and the rows.

## Settings and agents

- **Settings** is five group cards on a phone (Workspace, People & access, Governance, AI, Infrastructure), each
  section a row in its card with its hint (Time zone and execution retention, $vars for expressions…). A tap opens it alone, with **‹ Settings** to go back; the address keeps its `#section`, so a link to
  `/settings#users` opens Users. A desktop keeps the sections beside the page. The audit log's dates take a row of
  their own, and its table drops the Who column: the actor is a line under each event's summary.
- **An agent's page** keeps its header on screen as you scroll, and every change saves itself (its ✓ is read out as
  *Saved* on a phone), so there is no Save to reach for.

## Goals and project briefs

- **Goals** (`/goals`, the second tab under Projects) is one column of cards on a phone. A card shows the title, the
  status and level chips, **Under: <parent>** and **3 sub-goals ›**; the row is 44 px and opens the goal in a sheet.
  **Sub-goals ›** drills into them, with a back row on top, so a tree is never drawn sideways. A desktop shows the tree
  with the goal's sheet on the right. The goal dialog is a full-height sheet. Under each title sits one quiet line of
  progress (`12 runs · 1 failed · 3 updates · $0.42 this week`); it wraps under the title and is never a table. The
  goal's sheet has a **7 days | 30 days** switch above its sections.
- **The brief card** on a project's Overview shows its four texts (Brief, Constraints, Done when, Words we use) folded
  to three lines with **More**; a desktop shows up to six lines. The goals it serves have 44 px up, down and unlink
  buttons for admins. Each goal row shows the same progress line under its title.
- **Goal pickers.** The workflow settings' **Goal** and the team page's **Project goal** are full-width selects, 44 px
  tall on a phone; a desktop keeps its height.

## What it saw

- **In the Run Trace** the sheet is the same bottom sheet as any span's. **What it saw** is one column of labelled parts
  (goal chain, brief, status, practices, persona) in a card; **Show the exact text** is a 44 px row that folds out the
  raw block, which scrolls inside the sheet. The **Project** and **Goal** chips on the run wrap and cut long names.
- **In an agent's sessions** the **What it saw** fold sits under the session's header and is closed until tapped.
  A desktop shows the same card.

## Practices on the Brain page

- **Practices** on `/brain` (the Practices view in the Files drawer) is one column of practice cards on a phone, with
  44 px controls in the review dialog and the form; a desktop is unchanged. See
  [practices.md](practices.md#the-brain-page).

## The waive page

- `/practices/waive` is one column on a phone: the practice card, what failed, the reason box and a full-width **Waive for
  this run** (then **Retry the run**); a desktop keeps a narrow centred column. See
  [practices.md](practices.md#waiving-from-a-flow).

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
11. ~~Sheets and full-screen dialogs~~.
12. ~~No sideways scrolling~~.
13. ~~The agent page and Settings on a phone~~.
14. ~~Lighter filters~~.
15. ~~An accessibility pass~~ (above).
