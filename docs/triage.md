# Alert triage and Landfall war rooms

Part of the [Landflow docs](README.md); the [feature map](README.md#feature-map) lists every feature page.

Three bundled plugins and seven flows decide whether an alert is a real incident, and only then open a war room in
[Landfall](https://landfalls.ai). Everything else is recorded, asked about, or attached to the room that is already
open. They install from the repo's own marketplace ([below](#install)), and each flow has a read-only
[share page](marketplace.md#share-pages).

| Plugin | Language, ports | Nodes | Credentials |
|---|---|---|---|
| [`triage`](../plugins/triage) | TypeScript, 7109/7209 | Normalize Alert, Extract IOCs, Parse Email, Triage Rules, Triage Decision | none |
| [`landfall`](../plugins/landfall) | TypeScript, 7108/7208 | Landfall (Incident: Open from Alert, Recover, Open Manually, Declare, Get, Get Many; Timeline: Get Events, Add Event, Add Note; Remediation: Record Applied Externally; Heartbeat: Ping), **Landfall Trigger** (room opened, room ended, new timeline events) | Landfall API (`lf_key_…` key, ingest token, connection ID), Landfall Heartbeat |
| [`threat-intel`](../plugins/threat-intel) | Go, 7110/7210 | VirusTotal, AbuseIPDB, GreyNoise, urlscan.io, Shodan, AlienVault OTX, MISP, **IOC Enrich** (all of them at once, cached, one verdict) | one per service, each optional in IOC Enrich |

Each plugin's README has the parameters and the output shapes: the canonical alert and the verdict schema in
[triage](../plugins/triage/README.md), the Landfall API mapping and the fake in [landfall](../plugins/landfall/README.md),
and the score rules in [threat-intel](../plugins/threat-intel/README.md).

## The pipeline

**Alert triage → Landfall war room** (`plugins/triage/flows/alert-triage-to-landfall.json`) is the main flow:

1. **Intake.** A webhook (header secret) takes Alertmanager, Grafana, Datadog, CloudWatch (SNS), Sentry, Wazuh or any
   JSON. **Normalize Alert** detects the format (anything it doesn't recognise is read as Generic: `title`,
   `severity`, `service`…) and writes one canonical `alert` per alert, with a `dedupKey` (the source's fingerprint, or a
   hash of source, title and service). A resolved alert goes straight to **Recover** in
   Landfall, which closes the matching trigger.
2. **Rules.** **Triage Rules** sends each alert to one of four outputs: *Bypass* (sev1 always, plus rules that say
   *open*), *Noise* (rules a person approved), *Ask*, or *Evaluate* (no rule matched). The flow ships one example rule:
   staging alerts ask.
3. **AI triage.** **Extract IOCs** pulls IPs, domains, URLs, emails, hashes and CVEs (refanged, private ones dropped).
   **IOC Enrich** looks them up (an alert without IOCs passes through as *unknown*). Claude returns a verdict
   (`real`, `duplicate`, `unsure` or `noise`), a confidence, reasons, a suggested severity and a two-sentence summary.
   **Triage Decision** turns that into **Open**, **Attach** or **Ask**. These steps sit in an **AI triage** composite
   frame (`triage.aiTriage`, [composite nodes](composites.md)): the editor checks that the decision is there (it is
   locked), that the model feeds the reasoner, that enrichment and the reasoner fail open and that every path reaches the
   decision, and a version that breaks this can't be published. The phishing flow uses the same type, and **AI
   triage** in the node creator's Composites section starts a new frame with these nodes.
4. **Record.** Every alert becomes a row in the **Triage decisions** data table: who decided (severity, a rule, the AI,
   or fail-open), the verdict and confidence, the outcome, and in shadow mode what Enforce would have done.
5. **Act.** *Open* and *Attach* call **Open from Alert** with the dedup key, so a repeat attaches to the open room
   instead of opening a second one. *Ask* posts to Slack with a form link and waits: **Open a war room** or **Not an
   incident**, with a reason. After 15 minutes with no answer it opens the room. What Landfall did (`opened`, `attached`,
   `suppressed`…) and the room URL go back on the row.
6. **Runbook.** After a room opens, **Find the runbook** looks for a [runbook](runbooks.md) made from an earlier room of the
   same kind of alert and **Link the runbook in the room** posts its link in the room (Landfall has no link field on an
   alert, so it is a note on the timeline).

### Safety rules

These are enforced in the nodes, not left to the flow:

- **Fail open.** A verdict that is missing, not JSON, unknown or has a confidence outside 0–1 opens a room
  (`triage.failedOpen`). In the flows, **Enrich IOCs** and **AI verdict** continue on error (the AI step tries twice),
  so a threat intel service or the model being down means no verdict, and a room. An alert in a format Normalize Alert
  doesn't know is read as Generic. **Open war room** tries 3 times; set an error workflow (the setup steps say how) so a
  run that still fails reaches someone.
- **sev1 is never held**, even with the bypass list cleared.
- **The AI can't drop an alert.** Triage Decision has no noise output: a *noise* or *unsure* verdict, or confidence
  under the minimum (0.7), asks on-call.
- **Only people make noise rules.** A noise rule without `approvedBy` fails the node, and so does one approved by
  something that isn't a person ("AI", "Claude", "bot", "auto", "workflow"…). Rules past `expiresAt` are skipped and listed in `triage.expiredRules`.
- **Shadow first.** Triage Decision starts in **Shadow**: it always opens and records what Enforce would have done
  (`would_have` in the table). Switch to **Enforce** once a week of the digest agrees with on-call.
- The prompts treat alert text, threat intel and timelines as data and say not to follow instructions in them; the
  rules above hold even if a model does.

### The other flows

| Flow | Plugin | What it does |
|---|---|---|
| **Phishing report triage → Landfall** | triage | A reported email (raw `.eml` text) is parsed: headers, SPF, DKIM and DMARC, reply-to and return-path mismatches, links and attachment hashes. Its IOCs are enriched, Claude judges it, and the same decide, record, ask and open path follows (minimum confidence 0.8). Nothing is deleted or blocked |
| **Triage digest** | triage | Every morning, a Slack summary of the last day: alerts by outcome and by who decided, on-call answers, and every alert shadow mode would have held |
| **Landflow failures → Landfall** | landfall | An error workflow: a failed workflow opens or attaches to a Landfall incident (dedup key: workflow and node) with the error and the execution link |
| **Landflow heartbeat → Landfall** | landfall | Pings a Landfall heartbeat every 5 minutes, so Landfall pages someone when the automation goes quiet |
| **Learn from closed Landfall rooms** | landfall | When a room ends, reads its timeline and records in **Room outcomes**: real or not, cause, fix, lessons and runbook steps. The rows feed better triage rules and [runbooks](runbooks.md) |
| **IOC lookup API** | threat-intel | POST an IOC (or a list) to a webhook and get the combined verdict back |

## Landfall setup

- **API key.** An `lf_key_…` key with member rights: the node reads and writes incidents and timelines under
  `/o/<org slug>/…`.
- **Remote source.** *Open from Alert* and *Recover* post to Landfall's `POST /triggers` with the connection's ingest
  token. Landfall answers 422 unless that remote-source connection exists and is healthy. It checks health by probing
  the source's `/v1/health` and `/v1/capabilities`. Set `LANDFALL_SOURCE_PORT` (and optionally
  `LANDFALL_SOURCE_TOKEN`, `LANDFALL_SOURCE_HOST`) on the landfall plugin and it answers those probes, so the
  connection can point at it.
- **Heartbeat.** The heartbeat credential holds that heartbeat's own token; a ping is `POST
  /o/<org>/heartbeats/<name>/ping`.
- **Rate limit.** Landfall allows 300 requests a minute. The node waits out one 429 (`Retry-After`, up to 10 s). The
  trigger makes one list call per poll and reads at most 20 timelines.

## Install

The repo's root holds a marketplace, `.claude-plugin/marketplace.json` (`landflow-soc`), that lists the three plugins
and their flows. To add it:

- **From GitHub**: add `jhonny-landfalls/landflow`. The repository is private, so the host needs a `GITHUB_TOKEN` that
  can read it.
- **From this checkout**: start the host with `LANDFLOW_MARKETPLACE_ALLOW_LOCAL=1` and add the repository's absolute
  path.

Installing a plugin runs its node plugin (after the usual confirmation) and adds its flows to **Templates** for the
whole instance. Each flow's share page (**View** in the plugin drawer) shows it read-only before anything is installed.
The flows that use another plugin's nodes say so ("Also needs nodes from …"): alert triage needs all three.

To run them by hand instead: `pnpm plugin:triage`, `pnpm plugin:landfall`, `pnpm plugin:threat-intel` (not in
`dev:all`). Each announces itself to the host like the other bundled plugins.

## Trying it locally

`pnpm fake-landfall` starts a fake Landfall on `FAKE_LANDFALL_PORT` (default 7398). It has the routes the node uses, the
409 and 422 cases, the rate limit, and seeded dev credentials that it prints at start. `GET /_fake/state` shows what it
received; `POST /_fake/incidents/:id/status` ends a room (for the trigger and the lessons flow) and
`POST /_fake/connections/:id` makes a connection unhealthy. The plugins' tests run against it and against
`httptest` fakes of the threat intel services; none of them reach the network.
