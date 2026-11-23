# Webhook triggers for Jira, Linear, Shopify and Notion

## Problem

[limitations.md](../limitations.md): "Not yet built: webhook-based triggers for apps other than GitHub, Stripe and
Slack (the others poll; ...)". [protocol.md section 12](../protocol.md#12-app-webhook-triggers) defines
`triggerSource: "appWebhook"` with `WebhookMethod` (checkExists/create/delete) and `ReceiveWebhook`, static data per
workflow and node, and idempotency keys; the host side is `apps/web/src/lib/server/app-webhooks.ts` and the public
route `apps/web/src/app/api/webhook/app/[workflowId]/[nodeId]/route.ts`. Jira (`plugins/productivity/productivity/jira.py`)
and Notion (`notion.py`) have action nodes only; Linear and Shopify have no plugin at all (new).

## Goals / Non-goals

Goals:
- One webhook trigger node per app, each with the publish-time register/unregister lifecycle where the app's API allows it, signature verification over the raw body, replay protection and an idempotency key.
- Reuse the SDK helpers (`verify_hmac_sha256`, `safe_equal` in `sdks/python/landflow_sdk/signatures.py`, `verifyHmacSha256` in `@landflow/sdk`); add named helpers only when a scheme needs one.
- Tests against local fakes only, like every plugin ("no test needs a real account").

Non-goals:
- Linear or Shopify action nodes (a trigger needs a credential type, so a minimal credential is in scope; actions are not).
- Changing the protocol or host: the existing contract is enough (the Slack Trigger already handles services that cannot self-register).
- Polling replacements: existing polling triggers keep working.

## Design

Per app, verify the current vendor docs before building (these notes are from memory and flagged in Risks).

| App | Where | Registration | Signature | Idempotency key |
|---|---|---|---|---|
| Jira | `productivity/jira.py` (new class `JiraWebhookTrigger`, credential types `jiraCloudApi`/OAuth2/Server PAT already exist) | Cloud: REST `POST /rest/api/3/webhook` (OAuth apps; API-token users register via admin UI and paste the URL); Server/DC: `POST /rest/webhooks/1.0/webhook`. Dynamic Cloud webhooks expire in 30 days, so `checkExists` also refreshes (`PUT .../webhook/refresh`) | Cloud admin webhooks sign with a secret (`X-Hub-Signature`, HMAC-SHA256, WebSub style); URL-secret fallback when unsigned | `X-Atlassian-Webhook-Identifier`, else event timestamp + issue id |
| Linear | new plugin `plugins/linear` (TypeScript, ports next free after 7111/7211; see `docs/features/integrations.md`) | GraphQL `webhookCreate` (url, resourceTypes, secret); `webhookDelete`; `checkExists` queries `webhooks` | `Linear-Signature` hex HMAC-SHA256 of the raw body; body `webhookTimestamp` checked within 60 s (replay) | `Linear-Delivery` header |
| Shopify | new plugin `plugins/shopify` (Go or TypeScript) | Admin API `POST /admin/api/<ver>/webhooks.json` per topic; `GET`/`DELETE` for check and cleanup | `X-Shopify-Hmac-Sha256` base64 HMAC-SHA256 of the raw body with the app's client secret (`verifyHmacSha256 ... encoding: 'base64'`) | `X-Shopify-Webhook-Id` |
| Notion | `productivity/notion.py` (new class `NotionWebhookTrigger`) | No create API: the subscription is made in the integration's settings; `create` only verifies the token and stores the URL (the Slack Trigger pattern, `plugins/messaging/src/nodes/slack-trigger.ts`). Notion sends a one-time `verification_token` in the first POST; the node stores it in static data (`setStaticData`) and answers 200 | `X-Notion-Signature: sha256=<hex>` HMAC with that verification token (`verify_hmac_sha256(..., prefix="sha256=")`) | event `id` |

**Node shape** copies `StripeWebhookTrigger` (`stripe.py` lines 80-217): `triggerSource: "appWebhook"`, an `events`
multiOptions plus `additionalEvents`, `webhookNotice`, `webhook_check_exists`/`webhook_create`/`webhook_delete`,
`webhook(ctx)` returning `{"items", "response", "idempotencyKey"}`, and `execute()` returning `[]` for manual runs.
Secrets from the vendor (Shopify none, Linear/Jira ours) are generated random and kept in static data, never in
parameters. Items are the vendor event payload plus a small normalized head (`event`, `resource`, `id`, `actor`).

**Host and protocol.** No host change. The route is public by design (`/api/webhook/app/...`, the node verifies the caller). Confirm the
public-route allowance in `auth/policy.ts` and `openapi.ts` already covers the path (it does for GitHub/Stripe/Slack; the
test in step 1 proves it for a new plugin). Retries and backoff for failed `create` are the host's
(`LANDFLOW_APP_WEBHOOK_RETRY_MS`).

**Credentials.** Jira and Notion reuse existing types; Linear gets `linearApi` (API key or OAuth2, base URL
overridable for fakes); Shopify gets `shopifyApi` (shop domain, Admin API access token, client secret, API version).
Each declares a connection test like the others.

**Queue mode:** app-webhook registration is reconciled by the leader; any main receives the call and runs it. **Local
deploy:** a real vendor cannot reach `localhost`, so live checks use a tunnel the user starts themselves; nothing in the
repo does. New plugins also need `deploy/docker/*.Dockerfile` args and `deploy/k8s/base` manifests, built with OrbStack's builder only.

## Implementation plan

1. Fake-service harness and signature fixtures for the four schemes (`plugins/productivity/tests/_webhook_transports.py` has the transport helpers). Test: unit tests of each verifier with good, bad, stale signatures.
2. Notion trigger first (no new plugin, simplest registration): handshake, signature, dedupe. Test: `plugins/productivity/tests/test_notion_webhook.py` modeled on `test_github_webhook.py`.
3. Jira trigger: Cloud and Server paths, refresh on `checkExists`. Test: `test_jira_webhook.py` against the existing Jira fake.
4. Linear plugin skeleton (`pnpm plugin:linear` script, manifest, credential) plus the trigger. Test: Vitest like `plugins/messaging/test/slack-trigger.test.ts`.
5. Shopify plugin plus trigger, base64 HMAC. Test: its own suite with a fake Admin API.
6. Host-level test that a published workflow registers, receives a signed call and starts one run for each new node type (`apps/web/test`, using the fake plugin transports; see the existing app-webhook tests).
7. Docs, marketplace/catalog listing, history rows.

## Docs to update

`docs/protocol.md` section 12 (list of example triggers), `docs/features/integrations.md` (table rows, new plugin rows,
credentials), `docs/limitations.md` (narrow the "Not yet built" line to the apps still polling), `docs/roadmap.md`,
`docs/development.md` (new plugin test commands, `pnpm plugin:*`), `docs/history.md`, and `docs/README.md` if a page is added.

## Risks and open questions

- Vendor facts above are unverified here: Jira's signature header and 30-day expiry, Notion's verification flow, Linear's timestamp rule. Each step starts by reading the vendor's current docs.
- Jira Cloud API-token users cannot create dynamic webhooks (OAuth/Connect only): the node needs a manual-paste mode like Slack.
- Shopify mandatory compliance webhooks and per-API-version topic names change; keep the topic list data-driven.
- Scope: four triggers are more than one wave; ship Notion + Jira (existing plugin, no packaging) before the two new plugins.
- Public reachability for real-vendor tests is the user's tunnel, never ours (CLAUDE.md local-only rule).

## Effort and first slice

**L overall** (M for Notion + Jira, M for each new plugin). First slice: the Notion Webhook Trigger in the productivity
plugin: no new credential or packaging, exercises the handshake-token pattern, and ships with its fake-based test.
