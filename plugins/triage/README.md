# Alert Triage

TypeScript plugin with the deterministic nodes and the safety policy for deciding whether an alert deserves a Landfall war room
before one opens. Landflow's built-in AI nodes supply the verdict; this plugin normalises the alert, extracts indicators, applies
person-approved rules and gates the AI's answer. Every node is a pure transform, so each is `idempotent: true`.

```sh
pnpm --filter @landflow/plugin-triage start   # HTTP :7109 (MCP at /mcp), gRPC :7209
pnpm --filter @landflow/plugin-triage test
```

Typical workflow: Webhook → **Normalize Alert** → **Triage Rules** → (Data Table dedup/grouping, enrichment with **Extract IOCs**,
an AI verdict) → **Triage Decision** → open a room / attach to an open room / ask on-call / record as noise.

## Safety policy

- **The AI can never drop an alert.** Triage Decision has three outputs (Open, Attach, Ask) and no Noise output. An AI "noise"
  verdict goes to Ask. Only a rule a person approved (Triage Rules, Noise output) can mark an alert as noise.
- **Anything invalid, missing or unsure fails open:** a room opens. A missing, unparsable or out-of-range verdict, an unknown
  verdict word and an unexpected error inside the gate all open a room with the reason `fail open: …`. An expired rule is skipped,
  so its alerts are evaluated again.
- **sev1 is never held.** Triage Rules bypasses sev1 before any rule is read (even if you clear the bypass list), and Triage
  Decision opens a room for sev1 whatever the verdict says.
- A Noise rule without `approvedBy` (or approved by "AI", "bot", "auto"…) stops the node with an error: a person must approve noise
  rules, even if the rule is expired or would not match.
- Roll out in **Shadow** mode first (the default): every alert opens a room and `triage.shadowOutcome` records what Enforce would
  have done. Switch to Enforce when the shadow outcomes look right.

## Nodes

### Normalize Alert (`triage.normalizeAlert`)

One output. Turns a payload into one canonical alert per item under `alert` (an Alertmanager or Grafana group gives one item per
alert). It accepts a raw payload item, or a Webhook item whose `body` holds the payload (an object or a JSON string).

| Parameter | Type | Default |
|---|---|---|
| Format (`format`) | options: `auto`, `alertmanager`, `grafana`, `datadog`, `cloudwatch`, `sentry`, `wazuh`, `generic` | `auto` |
| Source Name / Title / Severity / Service / ID / Description / Status / Fingerprint / Environment Path (`genericSource`, `titlePath`, `severityPath`, `servicePath`, `idPath`, `descriptionPath`, `statusPath`, `fingerprintPath`, `environmentPath`), Generic only | string, dot paths | `generic`, `title`, `severity`, `service`, `id`, `description`, `status`, empty, `environment` |
| Severity Map (`severityMap`) | JSON, raw value (lower case) to `sev1`-`sev4` | `{}` |
| Default Severity (`defaultSeverity`) | options `sev1`-`sev4` | `sev3` |
| Keep Raw Payload (`includeRaw`) | boolean | `true` |

`auto` tries grafana, alertmanager, cloudwatch, sentry, wazuh, datadog in that order; a payload that fits none is read as
`generic` with the default paths (`title`, `severity`, `service`, …), so an alert from an unknown source is triaged, not
dropped. Pick `generic` to map other paths, or a fixed format to reject everything else.

**Canonical alert** (`alert`):

```jsonc
{
  "source": "alertmanager",            // grafana | datadog | cloudwatch | sentry | wazuh | your generic source name
  "id": "3a1f6c2b9d8e7f40",
  "fingerprint": "3a1f6c2b9d8e7f40",   // null when the source has none
  "status": "firing",                  // firing | resolved
  "title": "Checkout 5xx rate above 5%",
  "description": "5xx ratio is 12% for 10m",
  "severity": "sev1",                  // sev1 | sev2 | sev3 | sev4
  "severityRaw": "critical",
  "service": "checkout",               // string | null
  "entity": { "kind": "pod", "id": "checkout-7d9f8-abcde" },   // kind "unknown" and id "" when nothing identifies it
  "environment": "production",         // string | null
  "startsAt": "2026-10-28T09:15:00.000Z",   // ISO 8601 | null
  "endsAt": null,
  "groupKey": "{}:{alertname=\"HighErrorRate\"}",   // Alertmanager / Grafana, else null
  "labels": { "alertname": "HighErrorRate" },       // string map (Datadog/Sentry tags, CloudWatch dimensions, Wazuh fields)
  "links": [{ "kind": "runbook", "url": "https://…" }],   // runbook | dashboard | alert | other; http(s) only, at most 10
  "tags": [],                          // Datadog tags, Sentry tags, Wazuh rule groups
  "dedupKey": "alertmanager:3a1f6c2b9d8e7f40",   // source:fingerprint, else source:<16 hex of sha256(source|title|service)>
  "raw": { }                           // the original payload (the single alert for Alertmanager/Grafana); omitted when Keep Raw is off
}
```

**Severity mapping** (override any entry with Severity Map):

| Source | Raw value | Canonical |
|---|---|---|
| Generic words / Alertmanager and Grafana `severity` label (or `priority`) | critical, crit, fatal, emergency, page, P0, P1, sev1 | sev1 |
| | high, error, major, P2, sev2 | sev2 |
| | warning, warn, medium, P3, sev3 | sev3 |
| | info, low, minor, notice, debug, P4, P5, sev4 | sev4 |
| Numbers | 1 / 2 / 3 / 4 and 5 | sev1 / sev2 / sev3 / sev4 |
| Datadog | `priority` (P1-P5, normal = sev3), else `alert_type` (error = sev2, warning = sev3, info/success = sev4) | as above |
| CloudWatch | an `sev1`-`sev4` or `P0`-`P4` tag in the alarm name or description; else ALARM = sev2, INSUFFICIENT_DATA = sev3, OK = sev4 | |
| Sentry | `level`: fatal = sev1, error = sev2, warning = sev3, info/debug = sev4 | |
| Wazuh | `rule.level`: 13-15 = sev1, 10-12 = sev2, 7-9 = sev3, 0-6 = sev4 | |
| Anything else | | Default Severity |

Status: `resolved`/`ok`/`recovered` (Alertmanager and Grafana `status`, Datadog `alert_transition` Recovered, CloudWatch `OK`, Sentry
`resolved`) is `resolved`, everything else `firing`.

### Extract IOCs (`triage.extractIocs`)

One output; also an MCP tool. Refangs the text first (`hxxp`, `[.]`, `(.)`, `[:]`, `[at]`), then finds IPv4, IPv6, domains, URLs,
e-mails, MD5/SHA-1/SHA-256 and CVE ids, deduplicated. Domains need a real TLD from a compact built-in list, so `report.pdf` or
`index.html` are not domains; TLDs that are also file extensions (`.sh`, `.py`, `.md`, `.zip`…) only count inside a URL or e-mail.

| Parameter | Type | Default |
|---|---|---|
| Fields (`fields`) | string, comma-separated dot paths; empty = whole item | empty |
| Indicator Types (`types`) | multiOptions: ipv4, ipv6, domain, url, email, md5, sha1, sha256, cve | all |
| Drop Private IPs (`dropPrivate`) | boolean | `false` |
| Defang Values (`defangValues`) | boolean: put the defanged form in `value` too | `false` |
| One Item per IOC (`splitItems`) | boolean | `false` |

Output: the input item plus `iocs: [{ type, value, defanged, private? }]` (`private` only on IPs: private, loopback, link-local, CGNAT,
documentation and other reserved ranges) and `iocCounts` (a count per type, zero included). With One Item per IOC each item holds one
`ioc` (plus `iocCounts`); an item without indicators emits nothing.

### Parse Email (`triage.parseEmail`)

One output. For phishing reports; dependency-free and tolerant of malformed input (problems go to `warnings`, a truncated message
still gives what was readable).

| Parameter | Type | Default |
|---|---|---|
| Email From (`source`) | options `field` (raw RFC 822 text) / `binary` (.eml file) | `field` |
| Field (`field`) | string, when `field` | `email` |
| Input Binary Field (`binaryPropertyName`) | string, when `binary` | `data` |
| Output Field (`outputField`) | string | `email` |
| Emit Attachments as Binary (`attachmentsAsBinary`) | boolean | `false` |
| Binary Field Prefix (`binaryPrefix`) | string | `attachment_` |

Output `email`: `headers` (`from`, `to`, `cc`, `replyTo` as `{name, address}`, `returnPath`, decoded `subject`, ISO `date` and `dateRaw`,
`messageId`, `received[]`), `allHeaders`, `authentication` (`spf`, `dkim`, `dmarc` verdicts from Authentication-Results, `dkimAll`, `raw`),
`fromDomain`, `replyToMismatch`, `returnPathMismatch`, `text`, `html` (base64 and quoted-printable decoded, charset best effort), `urls`
(href targets and text URLs), `attachments: [{ filename, contentType, size, sha256, disposition, contentId? }]`, `warnings`. With
Emit Attachments as Binary every attachment is also added as `attachment_0`, `attachment_1`… (the input's own files stay).

### Triage Rules (`triage.triageRules`)

Four outputs, in order: **Bypass**, **Noise**, **Ask**, **Evaluate** (no rule matched). The severity bypass is checked first, then the
rules in order; the first match wins.

| Parameter | Type | Default |
|---|---|---|
| Severity Field (`severityField`) | string | `alert.severity` |
| Always Open For Severity (`bypassSeverities`) | multiOptions sev1-sev4; sev1 always bypasses | `["sev1"]` |
| Rules (`rules`) | fixedCollection `rule`, repeatable | none |

Each rule: `name`, `action` (`open` = Always Open → Bypass, `ask` = Ask On-call → Ask, `noise` = Noise → Noise), `match` (`all` / `any`),
`conditions` (a repeatable `condition`: `path` (dot path into the item), `operator`, `value`), `approvedBy`, `approvedAt`, `expiresAt`.
Operators: `equals`, `notEquals`, `contains`, `regex` (a pattern, or `/pattern/flags`), `in` (comma list or JSON array), `exists`,
`notExists`. Comparisons are case-sensitive; an array field matches when any element does. A rule without conditions never matches.
An expired rule (or an unparsable `expiresAt`) is skipped and named in `triage.expiredRules`.

Annotation on matched items: `triage.rule = { name, action, approvedBy }` (the bypass is `{ name: "Severity bypass (sev1)", action:
"open", approvedBy: null }`) and `triage.matchedAt`. Items that match nothing pass through unchanged.

### Triage Decision (`triage.triageDecision`)

Three outputs, in order: **Open**, **Attach**, **Ask**. There is no Noise output.

| Parameter | Type | Default |
|---|---|---|
| Mode (`mode`) | options `shadow` / `enforce` | `shadow` |
| Verdict Field (`verdictField`) | string, dot path; `output` is used when it is empty | `verdict` |
| Minimum Confidence (`minConfidence`) | number 0-1 | `0.7` |
| Existing Room Field (`existingRoomField`) | string, dot path to the dedupKey of an open room | `group.dedupKey` |
| Severity Field (`severityField`) | string | `alert.severity` |

The verdict may be an object or JSON text, including text wrapped in markdown code fences or prose, or nested under `output`.

Enforce logic, first match wins:

1. severity sev1 → **Open**
2. verdict missing, unparsable or invalid → **Open** (`fail open: …`)
3. AI says `noise` → **Ask** (never dropped)
4. AI says `unsure`, or confidence below the minimum → **Ask**
5. `real` or `duplicate` with an existing room key → **Attach**
6. otherwise → **Open**

Shadow mode sends everything to Open and records the Enforce result as `triage.shadowOutcome`.

Annotation: `triage = { ...earlier fields, outcome, mode, shadowOutcome?, verdict, confidence, reasons, suggestedSeverity?, failedOpen?,
decidedAt, policy: "v1", summary, dedupKey }`. `summary` is a short paragraph for the Landfall room summary; `dedupKey` is the existing
room's key for Attach, else `alert.dedupKey`.

**Verdict schema to ask the AI node for** (set it as the structured output, or put it in the prompt):

```json
{
  "verdict": "real | duplicate | unsure | noise",
  "confidence": 0.0,
  "reasons": ["short reason", "another reason"],
  "suggestedSeverity": "sev1 | sev2 | sev3 | sev4 (optional)",
  "summary": "One or two sentences for the responders (optional)"
}
```

`confidence` is a number from 0 to 1 (85 or "high" is invalid and fails open). Tell the model to answer `unsure` when it lacks
evidence, and to answer `duplicate` only for an alert that repeats one in an open room.

## Transports and MCP

HTTP :7109 and gRPC :7209 by default; add a broker with `LANDFLOW_TRANSPORTS` as in `plugins/text-toolkit/README.md`. `maxConcurrency`
defaults to 8 (`LANDFLOW_MAX_CONCURRENCY` overrides). Extract IOCs is `usableAsTool` and appears on the MCP face at
`http://127.0.0.1:7109/mcp`; the MCP token rules are the same as in text-toolkit.
