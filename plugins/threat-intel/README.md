# Threat Intel plugin (`threat-intel`)

Threat-intelligence lookups for Landflow, written with the Go SDK: VirusTotal, AbuseIPDB, GreyNoise, urlscan.io, Shodan,
AlienVault OTX and MISP, one node per service in n8n's resource → operation shape, plus **IOC Enrich**, the aggregate
node a triage flow uses. The plugin calls the services' REST APIs directly with the standard library only.

It is built for AI SOC triage: before an alert opens an incident war room, enrich its IOCs (IPs, domains, URLs, file
hashes) and let an AI node judge whether the alert is real. **Every operation is a read.** Operation names start with
`get`, `search`, `check` or `lookup`, so the host marks each MCP tool `readOnlyHint: true`; every node is `usableAsTool`
and idempotent. Nothing here submits, creates or deletes: urlscan.io has no Submit operation because a submitted scan is
public by default.

```sh
cd plugins/threat-intel
go run .                             # HTTP :7110, gRPC :7210, announces to LANDFLOW_REGISTRY_URL (default http://127.0.0.1:3000)
LANDFLOW_REGISTRY_URL=off go run .   # standalone
go vet ./... && go test ./...        # against httptest fakes: no account, no network, no real service is ever called
```

`LANDFLOW_HTTP_PORT` / `LANDFLOW_GRPC_PORT` override the ports; `LANDFLOW_MAX_CONCURRENCY` (default 10) the calls one
instance takes at once. Every service call goes through the SDK's traced HTTP client, so it is a client span in the
workflow's trace; API keys are password fields, masked in the UI and redacted from logs, spans and error messages.

## Nodes

| Node (type) | Resource → operation | Parameters | Output |
|---|---|---|---|
| **VirusTotal** (`threat-intel.virusTotal`) | IP Address / Domain / URL / File → Get (`get`) | `ip`, `domain`, `url` (sent as VirusTotal's URL id, base64url without padding) or `hash` (MD5, SHA-1, SHA-256); **Simplify** | `{indicator, found, malicious, suspicious, harmless, undetected, reputation, lastAnalysisDate, link}`; Simplify off: the full v3 report |
| **AbuseIPDB** (`threat-intel.abuseIpDb`) | IP Address → Check (`check`) | `ip`, `maxAgeInDays` (1-365, default 30), `verbose` | AbuseIPDB's `data` object (`abuseConfidenceScore`, `totalReports`, `countryCode`, `isp`, …; with Verbose the `reports`) plus `link` |
| **GreyNoise** (`threat-intel.greyNoise`) | IP Address → Get (`get`), the Community API `/v3/community/{ip}` | `ip` | GreyNoise's answer (`noise`, `riot`, `classification`, `name`, `last_seen`, `link`) plus `seen`. A 404 ("not observed") is a normal result: `{ip, noise:false, riot:false, seen:false, message}` |
| **urlscan.io** (`threat-intel.urlscan`) | Scan → Search (`search`), Get Result (`getResult`) | Search: `query` (urlscan syntax, e.g. `domain:"example.com"`), `size` (default 20). Get Result: `uuid`. **Simplify** | Search: `{query, total, took, hasMore, link, results:[{uuid, url, domain, ip, country, time, link, screenshot}]}`. Get Result: `{uuid, url, domain, ip, country, server, status, time, score, malicious, categories, tags, link, screenshot}`. Simplify off: urlscan's JSON |
| **Shodan** (`threat-intel.shodan`) | Host → Get (`get`) · DNS → Resolve (`lookup`) | `ip` (+ **Simplify**) · `hostnames` (comma-separated) | Host: `{ip, found, hostnames, domains, org, isp, country, os, ports, vulns, tags, lastUpdate, link}` (`found:false` on 404; Simplify off: the banner data). DNS: `{results:[{hostname, ip}]}` (`ip` null when unresolved) |
| **AlienVault OTX** (`threat-intel.alienVaultOtx`) | Indicator → Get (`get`), section `general` | `indicatorType` (IPv4, IPv6, domain, hostname, url, file), `indicator`; **Simplify** | `{indicator, type, found, pulseCount, pulses, reputation, country, asn, link}` (`found:false` on 404; Simplify off: the full section) |
| **MISP** (`threat-intel.misp`) | Attribute → Search (`search`), `POST /attributes/restSearch` | at least one of `value` (`%` wildcards), `type`, `tags` (comma-separated), `last` (e.g. `7d`); `limit` (default 50); **Simplify** | `{count, attributes:[{id, eventId, type, category, value, toIds, timestamp, comment, tags, eventInfo, link}]}`; Simplify off: MISP's `response.Attribute` |
| **IOC Enrich** (`threat-intel.iocEnrich`) | none (a single operation) | see below | see below |

All nodes read their parameters per item, pair every output item with its input, honour **On Error: Continue**, and fail
with the item index, the HTTP status and the service's own message, e.g. `VirusTotal API error 401: Wrong API key`, plus a
hint (check the key; rate limit; service unavailable). A **404 is a result, not an error** for the lookups where "never
seen" is an answer: VirusTotal, GreyNoise, Shodan Host and OTX return `found:false` / `seen:false`. For urlscan.io Get
Result and every other status, the item fails.

## Credentials

Each type has **Test connection** (one cheap authenticated call). Every key field is a `password` field. Every type also
has an optional **API Base URL** that replaces the service's host and keeps the paths (a proxy, a regional endpoint, a
test double); MISP's is required.

| Type | Fields | How the key is sent | Test calls |
|---|---|---|---|
| `virusTotalApi` | API Key, API Base URL | `x-apikey` header | `GET /api/v3/users/{key}` |
| `abuseIpDbApi` | API Key, API Base URL | `Key` header | `GET /api/v2/check?ipAddress=127.0.0.1` |
| `greyNoiseApi` | API Key (optional), API Base URL | `key` header, when set | `GET /v3/community/8.8.8.8` (a 404 passes) |
| `urlscanApi` | API Key, API Base URL | `API-Key` header | `GET /user/quotas/` |
| `shodanApi` | API Key, API Base URL | `key` query parameter | `GET /api-info` |
| `otxApi` | API Key, API Base URL | `X-OTX-API-KEY` header | `GET /api/v1/users/me` |
| `mispApi` | API Base URL, Auth Key, Allow Unverified TLS | `Authorization: <key>` header | `GET /users/view/me` |

**Allow Unverified TLS** (MISP only, off by default) skips certificate verification for a lab MISP with a self-signed
certificate. Leave it off in production: with it on, the connection is open to interception.

## IOC Enrich

Takes items carrying IOCs, asks every service that has a credential attached **and** supports the IOC's type, and returns
one verdict per IOC. A credential is optional per service: attach only the ones you have. GreyNoise's key is optional
too, but its credential must be attached to enable it (the keyless Community API is rate limited harder).

**Input** (the first that the item has wins):

1. an **IOCs array** at `iocsPath` (default `iocs`): `{type, value}` objects or plain strings. Option **Enrich Every Array
   Element** (default on; off enriches only the first).
2. an **IOC object or string** at `iocPath` (default `ioc`): `{"ioc": {"type": "ip", "value": "1.2.3.4"}}`.
3. **type and value fields** at `typePath` / `valuePath` (default `type` / `value`): `{"type": "ip", "value": "1.2.3.4"}`.

All paths are dot paths (`alert.observable.value`, `iocs.0`). A type can be `ip` (`ipv4`, `ipv6`), `domain` (`hostname`,
`fqdn`), `url`, `hash` (`md5`, `sha1`, `sha256`, `file`) or empty/`auto` to detect it. Values are normalised: IPs
canonicalised, domains and hashes lower-cased, and defanged forms (`hxxps://evil[.]example`, `1[.]2[.]3[.]4`) refanged. An
empty IOCs array (Extract IOCs found nothing) passes through with verdict `unknown` and the reason "no IOCs to look up",
so a triage flow can send every alert through. An item with no IOC at all, or a single IOC that cannot be parsed, fails
the item; an unparsable element of an array gets an `error` entry of its own.

**Services and the types they take**

| Service id | ip | domain | url | hash | Score and verdict (per service) |
|---|---|---|---|---|---|
| `virustotal` | yes | yes | yes | yes | score = 10 per malicious engine + 5 per suspicious, max 100; `malicious` from 5 engines; never analysed: no data |
| `abuseipdb` | yes | | | | score = abuse confidence score; `malicious` from 75 |
| `greynoise` | yes | | | | classification malicious: 100, malicious; benign or RIOT: 0, not malicious; noise of unknown class: score 25, no verdict; not observed: no data |
| `urlscan` | yes | yes | yes | | the newest public scan's own verdict (one search, then that result): malicious 100, otherwise 0; no scan or no verdict: no data |
| `shodan` | yes | | | | exposure, not reputation: only tags `compromised` / `malware` give a verdict (malicious, 80); ports and CVEs go in the summary |
| `otx` | yes | yes | yes | yes | score = 15 per pulse mentioning it, max 100; `malicious` from 5 pulses; a whitelisted indicator is 0, not malicious; no record: no data |
| `misp` | yes | yes | yes | yes | a matching attribute flagged `to_ids`: 90, malicious; a match without it: 50, no verdict; no match: no data |

**Skipped:** private (RFC 1918, ULA), loopback, link-local, multicast, unspecified and special-purpose reserved IPs
(CGNAT `100.64.0.0/10`, documentation, benchmarking, `240.0.0.0/4`, `255.255.255.255`…), and URLs whose host is one.
They are not sent to any service: `verdict: "unknown"`, `skipped: true`, `skipReason`.

**Output** (the input item's fields are kept; option **Keep Input Fields**; the result lands in `threatIntel`, option
**Output Field**):

```jsonc
{
  "alertId": "A-1",                                   // the input, unchanged
  "threatIntel": {
    "ioc": { "type": "ip", "value": "45.33.32.156" },
    "verdict": "malicious",                           // malicious | suspicious | clean | unknown
    "score": 100,                                     // highest service score, 0-100, or null
    "reasons": ["virustotal: 12 malicious, 3 suspicious, 20 harmless, 30 undetected (reputation 0)", "abuseipdb: abuse confidence 95%, …"],
    "services": [                                     // one per service that was asked, in a fixed order
      { "service": "virustotal", "malicious": true, "score": 100, "summary": "…", "link": "https://www.virustotal.com/gui/ip-address/…" },
      { "service": "otx", "malicious": null, "score": null, "summary": "lookup failed", "link": "…", "error": "AlienVault OTX API error 503: …" },
      { "service": "greynoise", "malicious": false, "score": 0, "summary": "…", "link": "…", "cached": true }
    ]
  }
}
```

`malicious` is `true` / `false` when the service has a verdict and `null` when it has none (not seen, no data, failed);
`score` is `null` when it gives none; `error` appears only on a failed lookup; `cached` only on a cache hit. For an IOCs
array the result is `{verdict, score, reasons, iocs:[<the object above, per IOC>]}`: `verdict` is the worst of the
IOCs (malicious > suspicious > unknown > clean, so *clean* means every live IOC is clean; skipped ones do not count), `score`
the highest, and `reasons` those of the IOCs that decide it, prefixed with the IOC.

**Overall verdict** (thresholds are options, **Malicious From Score** default 70 and **Suspicious From Score** default 30):

| Verdict | When |
|---|---|
| `malicious` | any service says malicious, or the highest service score is ≥ 70 |
| `suspicious` | the highest service score is ≥ 30 |
| `clean` | at least one service says *not* malicious and no score reaches 30 |
| `unknown` | otherwise: no service is configured for the type, none returned data, or all failed |

A service that fails never fails the item: its `error` is filled, it adds a `<service> failed: …` reason, and the verdict
comes from the others. Absence of data is never read as *clean*: only a service that analysed the IOC and found nothing
counts toward `clean`.

**Cache.** **Cache TTL (Seconds)** (default 3600, 0 = off) keeps each service's answer for an IOC in memory, keyed by
service, IOC and a fingerprint of the credential, so a burst of alerts about one indicator asks each service once (also
inside one run, and concurrent lookups share one call). Failed lookups are never cached. The cache lives in the plugin
process: a restart, or another replica, starts empty; it is bounded at 10 000 entries.

**Limits.** At most **Concurrency** service calls run at once (option, default 4, max 10). A `429` is retried **once**
after its `Retry-After` (seconds or an HTTP date; 1 s when absent); a `Retry-After` over 30 s is not waited, and a second
`429` becomes the service's `error`. This holds for every node, not only IOC Enrich.

As a tool, IOC Enrich takes `value` (and `type`) or `iocs`, with `readOnlyHint: true` set on the node because its name
carries no read verb.

## Rate limits and free tiers

Every service here meters by API key, and the free tiers are small and differ per service (per minute, per day or per month;
some count searches and lookups separately). The plugin does not hard-code any number: check each service's current plan
page. That is why IOC Enrich caches, bounds its concurrency, asks only the services that support the IOC's type, and skips
private addresses. To stay inside a free tier, lower **Concurrency**, raise **Cache TTL**, or detach the credentials of
services you do not need. Each urlscan.io enrichment of a domain, URL or IP costs one search and, when something is found,
one result read; each VirusTotal, AbuseIPDB, GreyNoise, Shodan and OTX enrichment costs one call, MISP one search.
