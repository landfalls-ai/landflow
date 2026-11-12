# Company Brain: the P1 and P2 sources (follow-up note, 2026-11-12)

Part of the [Landflow docs](../README.md). Phases A to C built activity integrations for Slack, Google Drive, Calendar
and Directory, Notion, Linear, Attio and Fathom, and the [work ingest templates](../features/integrations.md#work-ingest-templates)
that record them. This note lists what each later source would need to fit the same contract: a trigger (an app webhook,
else a poll with a cursor), **Get Many Changed Since**, **Get**, users with email, [activity items](../protocol.md#16-activity-items),
and an ingest template. Nothing here is built, and no vendor API below has been checked yet. Each one starts by verifying the
vendor's current API, webhook signatures and OAuth endpoints against its official docs, as the Phase B plugins did.

| Source | What it would report | What it needs first | Likely shape |
|---|---|---|---|
| **Report Scheduler (Base44)** | reports scheduled, sent or changed (`work.self_update`, `work.release`) | Whether the Base44 app exposes an API or webhooks for its entities; if not, the app itself posts to a Landflow webhook (a Webhook trigger, no plugin) | Webhook trigger + a Set node to make the activity item; a plugin only if the app has a stable API |
| **The Brandlight platform** | product changes, releases, customer usage (`work.release`, `work.feature_request`) | Which internal events or tables exist, and who owns the API; an internal service account | An internal plugin, or the platform posting signed events to an app webhook trigger |
| **Shapes** | to be scoped: which Shapes product is meant, and what work it holds | Confirm the vendor and its API with the team that uses it | Unknown until scoped |
| **Clay** | enrichment runs and tables about accounts (`customer` hints, `work.deal_moved` context) | Clay's API and webhook options for table rows; enrichment data is about third parties, so a privacy review of what may be kept | Poll or webhook into Customer entities (attributes), not events per row |
| **Mesh** | to be scoped: which Mesh product is meant (several share the name) | Confirm the vendor and its API | Unknown until scoped |
| **Scytale** | compliance controls, tasks and evidence by owner (`work.action_item`, `work.self_update`) | Whether Scytale offers a public API or exports; read-only scopes | Poll over tasks and controls, owners by email |
| **Microsoft 365** | Outlook calendar, OneDrive / SharePoint edits, Teams messages, directory users (the Google set again) | An Entra app registration (Graph API), delta queries, change notifications that must be renewed, admin consent; mail and private chats off by default as in Phase A | A Go or TypeScript plugin mirroring the Google one: Graph delta polls, Directory users with manager, and the same templates |

**Shared work before any of them:** joining a customer named by a domain (Calendar, Fathom) with the same customer named
by a channel or folder ([limitations](../limitations.md#integrations-that-report-activity-built-2026-11-12)); and app
webhooks that renew themselves, which Microsoft Graph change notifications need as much as Drive and Calendar push
channels do.
