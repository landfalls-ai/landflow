# SAP S/4HANA Cloud plugin: read and write ERP data from flows and agents

Status: phases 1 to 4 built (2026-11-07) in `plugins/sap`, against a fake S/4HANA server only; see [../sap.md](../sap.md). Phase 0 (verify against SAP's own pages), phase 5 (SAML bearer) and phase 6 (a real system) are not done, and decision D6 is still open. Part of the [specs](README.md). The text below is the original research and plan, kept as written; the "Unverified claims" list is unchanged because phase 0 was skipped (it needs an SAP account).

## Problem

Landflow has nodes for SaaS tools, databases and the web, but nothing for the system that holds a company's orders, suppliers, products and
invoices. SAP S/4HANA Cloud is that system for many customers. Flows and agents that answer "which sales orders for customer X are blocked?",
"create a purchase order from this approved request" or "start a flow when a business partner changes" need an SAP node that is safe to give
to a model: writes into an ERP are hard to undo, and the credentials are powerful.

Scope chosen by the user: **SAP S/4HANA Cloud, Public Edition first**; Private Edition differences are noted per section. Everything is
designed to be built and tested **without a real SAP system** (section "Testing"), because Landflow runs only on the local machine.

### How this was researched, and what is weak

SAP's own pages are hard to fetch: the Help Portal and the Business Accelerator Hub render in JavaScript, and `community.sap.com` and
`blogs.sap.com` answered 403 to the fetch tool. Much of what follows therefore rests on SAP Community answers read through search
summaries, SAP developer tutorials, SAP knowledge base articles, the SAP Cloud Application Programming Model (CAP) docs, and third-party
connector docs (Prismatic, Workato, Nango). Each claim carries its link. A claim that I could not confirm from a source is marked
**UNVERIFIED** (the list is collected in "Unverified claims" at the end). The first build step re-checks the load-bearing ones against SAP's
Help Portal in a browser.

## Decisions

The user said "finish everything" on 2026-11-07, which this build took as a go-ahead for D1, D2, D3, D4, D5 and D8 as recommended. D6 is not decided: no test calls any real SAP system.

| # | Decision | Recommendation | State |
|---|---|---|---|
| D1 | Build at all | Yes, as read-only first (slice 1). Writes come after approvals and limits are in. | Taken (go-ahead) |
| D2 | Which authentication to support first | **Basic (communication user) and the API Hub sandbox key first, OAuth 2.0 authorization code with PKCE second, SAML bearer later.** Client credentials is not offered for Public Edition: the sources say Public Edition inbound does not support it (see "Authentication"). Needs the user's answer on which his tenant allows. | Taken: Basic, sandbox key and PKCE; SAML later |
| D3 | Generic OData node, curated nodes, or both | Both, in that order: one metadata-driven **SAP OData** node first, then a few curated operations (Business Partner, Sales Order, Purchase Order, Product, Supplier Invoice) as presets on the same code. | Taken: both |
| D4 | Trigger | **Polling trigger first.** An event trigger only after the user decides to pay for and run an event broker (Advanced Event Mesh, Event Mesh or Cloud Application Event Hub) and a public URL. | Taken: poll first, then event through a webhook only (no broker is run) |
| D5 | Writes in agents | Read-only by default. A write needs the node's "Allow writes" setting **and** approval on the tool. Dry run is on by default for agents. | Taken |
| D6 | Real-system check | A trial or sandbox check is a separate step the user starts. **It is NOT to be run without the user's decision** (section "Testing"). | **Undecided; nothing real is called** |
| D7 | Private Edition | Same plugin, extra credential options (client credentials via the system's OAuth setup, Cloud Connector). Not in slice 1. | Partly: a client-credentials credential type exists, no Cloud Connector |
| D8 | OData V4 | V2 first (most released APIs, and what connectors target), V4 as a second read/write path by the same node. See "Design 1.3". | Taken: V2 first, V4 by the same client |

## Findings that shape the design

1. **Public Edition inbound auth is not what an n8n user expects.** Several SAP Community answers say that in Public Edition the only natively
   supported OAuth 2.0 flows are authorization code with PKCE and SAML 2.0 bearer assertion, and that **client credentials is not supported
   directly**; the inbound OAuth screen is fixed to "Public Client with authorization code (PKCE)". Sources:
   [OAuth 2.0 Client Type in S4HANA Cloud Public](https://community.sap.com/t5/technology-q-a/oauth-2-0-client-type-in-s4hana-cloud-public/qaq-p/14239273),
   [How to configure OAuth 2.0 between Integration Suite and S/4HANA Public Cloud](https://community.sap.com/t5/technology-q-a/how-to-configure-oauth-2-0-authentication-between-sap-integration-suite-cpi/qaq-p/14425039),
   [Principal propagation from BTP to S/4HANA Public Cloud](https://community.sap.com/t5/technology-blog-posts-by-members/principal-propagation-from-btp-to-s-4hana-public-cloud-configuration-notes/ba-p/14480435).
   These are community answers, not an official statement (**UNVERIFIED** against the Help Portal). Third-party guides that show client credentials
   ([Nango](https://nango.dev/docs/api-integrations/sap-odata-oauth2-cc/connect)) use transactions (`SU01`, `SOAUTH2`, `SICF`), which exist in
   **Private Edition and on premise** but not in Public Edition's key-user model.
2. **The tenant's API host carries `-api`** (`https://my123456-api.s4hana.cloud.sap`) for communication-user calls
   ([Prismatic](https://prismatic.io/docs/components/sapS4Hana/)); the same page's examples differ between authorize and token URLs, so the host
   is a credential field, never computed.
3. **Writes need an ETag and a CSRF token.** A `PATCH` without `If-Match` gets 428 or 412
   ([SAP KBA 3514624](https://userapps.support.sap.com/sap/support/knowledge/en/3514624),
   [KBA 3778784](https://userapps.support.sap.com/sap/support/knowledge/en/3778784)); `If-Match: *` works but SAP's own blog calls it not
   recommended ([blog](https://blogs.sap.com/t5/technology-blogs-by-sap/handling-412-precondition-failed-and-428-precondition-required-errors-in/ba-p/13558022),
   not fetched, seen in search results only).
4. **Events do not come as a webhook straight from S/4HANA.** S/4HANA Cloud publishes to SAP Event Mesh, Advanced Event Mesh or Cloud Application
   Event Hub ([CAP guide](https://cap.cloud.sap/docs/guides/events/s4)). Getting them to Landflow needs a broker or a hub and a delivery point
   that calls a public URL (**UNVERIFIED**, see "Events"). Polling needs nothing but the API.
5. **Rate limits are not published.** No official numbers were found; one consultancy note claims hard limits (429) for new public APIs from
   2026-11-13, a SuccessFactors/Ariba-focused claim that is **UNVERIFIED** for S/4HANA
   ([Redress Compliance note](https://redresscompliance.com/research-notes/sap-api-policy-successfactors-rate-limits)). The node must honour 429 and
   `Retry-After` and cap its own concurrency.

## Design

### 1. How an external system integrates with S/4HANA Cloud Public Edition

#### 1.1 The access model: scenarios, arrangements, systems, users

In Public Edition a customer admin does not open a service; they **expose a communication scenario**. The pieces, as the sources describe them:

| Piece | What it is |
|---|---|
| Communication scenario (`SAP_COM_nnnn`) | A named bundle of inbound services (OData, SOAP) and outbound services. SAP ships standard ones; a customer can create a **custom** scenario that adds a custom CDS view exposed as an external API ([KBA 3614521](https://userapps.support.sap.com/sap/support/knowledge/en/3614521), [KBA 2911993](https://userapps.support.sap.com/sap/support/knowledge/en/2911993); both seen in search only). |
| Communication system | The external system's record (host, and its users). For OAuth it can carry the OAuth settings. |
| Communication user | A technical user (user name, password) for the inbound side. |
| Communication arrangement | Ties a scenario to a communication system and to the inbound authentication method, and **creates the service endpoint** and, for OAuth, shows a client id under "OAuth 2.0 Details". |
| Apps | Fiori apps "Maintain Communication Users", "Communication Systems", "Communication Arrangements" |

An OData service can be called by a **communication user** only if it belongs to a scenario that an arrangement uses; a business user needs
a business catalog instead ([KBA 2669062](https://userapps.support.sap.com/sap/support/knowledge/en/2669062), search summary). So the first
thing a Landflow user must do is ask an SAP admin for **one arrangement per scenario** the flows use. The plugin's docs must list the
scenario to ask for per curated node. Examples seen in sources: `SAP_COM_0008` (used as the Business Partner example by
[StackOne](https://docs.stackone.com/connectors/saps4hana/guides/link-account/oauth-2-0), 404 when fetched, search summary only), and
`API_BUSINESS_PARTNER_0001` as the business-partner **authorization scope** in
[SAP's SAML bearer tutorial](https://developers.sap.com/tutorials/abap-environment-business-partner-oauthsamlbearer). The scenario ids for
Sales Order, Purchase Order, Product and Supplier Invoice were **not verified**; the first slice reads them from the API Hub overview pages
in a browser. A list of all scenarios exists
([community blog](https://community.sap.com/t5/financial-management-blog-posts-by-sap/sap-s-4hana-public-cloud-edition-all-communication-scenarios-in-one-place/ba-p/14333677),
403 when fetched).

#### 1.2 Authentication

| Method | Public Edition | Fit for Landflow |
|---|---|---|
| **Basic** (communication user and password, "User Name and Password" enabled on the communication system) | Supported ([Prismatic](https://prismatic.io/docs/components/sapS4Hana/)). SAP may discourage it for production: **UNVERIFIED**. | Simplest and the only one that needs nothing else; fine for a first slice and for a dedicated, least-privilege communication user. |
| **API Hub sandbox key** | The Business Accelerator Hub sandbox at `https://sandbox.api.sap.com/s4hanacloud` takes an API key and serves read-only sample data ([Prismatic](https://prismatic.io/docs/components/sapS4Hana/)). | A zero-cost smoke test of the plugin against real SAP payloads. Needs a free SAP account; the user's decision (D6). |
| **OAuth 2.0 authorization code, PKCE** (client id from the arrangement's "OAuth 2.0 Details", public or confidential client) | Supported and recommended by Prismatic for production; the user signs in with a personal SAP login, not the communication user. Token URL pattern from that page: `https://<tenant>-api.s4hana.cloud.sap/sap/public/bc/sec/oauth2/token`. | The host already runs this flow: a plugin credential type that `extends` `core.oAuth2Api` with `grantType` `pkce` ([protocol.md OAuth2 credentials](../protocol.md)). A run acts as that person and depends on the refresh token staying valid (**UNVERIFIED**: its lifetime in Public Edition). |
| **OAuth 2.0 SAML bearer assertion** | The standard server-to-server path for Public Edition per the sources; needs an OAuth 2.0 identity provider (issuer and signing certificate) in the communication system, and the token URL from the "Own SAP Cloud System" app ([SAP tutorial](https://developers.sap.com/tutorials/abap-environment-business-partner-oauthsamlbearer), [Workato](https://docs.workato.com/connectors/sap-odata/sap-oauth-btp.html)). The usual setup puts SAP BTP in the middle as the issuer. | Landflow would have to **sign SAML assertions itself** (a private key it holds, a certificate the admin uploads) or go through a BTP destination. Real work and a trust decision; phase 3. |
| **OAuth 2.0 client credentials** | Said not to be supported natively on Public Edition (finding 1). **UNVERIFIED.** | Offer it only in the Private Edition credential type (D7). The host supports the grant ([protocol.md](../protocol.md)). |
| OAuth 2.0 mTLS | Listed among supported types in a search summary only. **UNVERIFIED.** | Not planned. |

Credential type `sapS4hanaApi` (plugin `plugins/sap`), same shape as the existing patterns (a node lists several credential types, each with
`displayOptions.show.authentication`, see protocol.md "Token or OAuth2 on one node"):

- `sapS4hanaBasicApi`: `baseUrl` (the `-api` host, https only), `user`, `password`, optional `sapClient` (Private Edition), `allowedServices` (an optional comma list that narrows what flows may reach). Testable: `GET <baseUrl>/sap/opu/odata/sap/API_BUSINESS_PARTNER/$metadata?...` is heavy, so **Test connection** fetches a small `$top=1` of a service the user names (default Business Partner), which also proves the arrangement exists.
- `sapS4hanaOAuth2Api`: extends `core.oAuth2Api`, `grantType` `pkce` (Public) with `authUrl` and `accessTokenUrl` derived from the tenant host in the credential dialog; for Private Edition `clientCredentials`.
- `sapSandboxApi`: `apiKey` (sent as `APIKey` header, per the API Hub convention; **UNVERIFIED** header name), base URL fixed to the sandbox.

The plugin reads `accessToken` from the data on each call and caches nothing, as protocol.md asks.

#### 1.3 The APIs

- **Catalog.** Released APIs live in the [SAP Business Accelerator Hub](https://api.sap.com/) (S/4HANA Cloud package). Its catalog is itself an OData service (`api.sap.com/odata/1.0/catalog.svc`, seen in search results; it returned nothing to the fetch tool, so its shape is **UNVERIFIED**). Plan: **a curated JSON catalog checked into the plugin** (service id, title, V2/V4, path, scenario id, entity sets, which entity has a change timestamp), written once from the Hub in a browser and verified against a real `$metadata`. A live catalog fetch is not planned (the Hub needs no tenant but is not an API Landflow should call at run time).
- **V2.** Services such as `API_BUSINESS_PARTNER` (entities `A_BusinessPartner`, `A_Customer`, `A_Supplier`), `API_SALES_ORDER_SRV` (`A_SalesOrder`, deep insert for items, delete only without follow-on documents), `API_PURCHASEORDER_PROCESS_SRV` (`A_PurchaseOrder`, number from the range), `API_PRODUCT_SRV` (`A_Product`) and the supplier invoice API (service name **UNVERIFIED**; the Hub lists it as `API_SUPPLIERINVOICE_PROCESS_SRV`, to be confirmed). Names and entities from the search summaries of [Workato](https://docs.workato.com/ja/connectors/sap-s4-hana.html), [WSO2](https://wso2.com/integration-platform/docs/connectors/catalog/erp-business/sap.s4hana.api_sales_order_srv/sap-sales-order-connector-overview) and [KBA 3757274](https://userapps.support.sap.com/sap/support/knowledge/en/3757274) (a Sales Order address known issue). Base path pattern `https://<tenant>-api.s4hana.cloud.sap/sap/opu/odata/sap/<SERVICE>` (V2; from the Prismatic and Nango examples and my memory, **UNVERIFIED** for Public Edition).
- **V4.** Newer APIs and some existing ones are OData V4 under a different path (`/sap/opu/odata4/...`, **UNVERIFIED**). The node carries the version per catalog entry. V4 differs in paging (`@odata.nextLink`), count (`$count=true`), update semantics (`PATCH`) and error shape (below). Connectors differ here too: Prismatic's record actions are V2 only and send V4 through a raw request ([source](https://prismatic.io/docs/components/sapS4Hana/)). One third-party page claims V2 APIs are in maintenance mode ([knowledgelib](https://knowledgelib.io/business/erp-integration/sap-s4hana-odata-api-capabilities/2026)); **UNVERIFIED**, check SAP's roadmap page before promising V2-only.

#### 1.4 Protocol rules the node must implement

| Rule | Detail |
|---|---|
| **CSRF** | Writes (`POST`, `PATCH`, `PUT`, `DELETE`, and `$batch`) need an `x-csrf-token`. Fetch it with a `GET` on the service root carrying `x-csrf-token: Fetch`; the answer's `x-csrf-token` header plus its cookies go on the write, **on the same cookie jar**. A 403 whose `x-csrf-token` header says `Required` means fetch again. This is standard SAP Gateway behaviour; [KBA 3778784](https://userapps.support.sap.com/sap/support/knowledge/en/3778784) mentions fetching the token with the ETag. Official page not fetched: **UNVERIFIED** for Public Edition, but every V2 connector does it. |
| **ETag** | A single-entity `GET` returns an ETag (header, and `__metadata.etag` in V2 JSON). `PATCH` and `DELETE` need it as `If-Match`; 428 means missing, 412 means stale ([KBA 3514624](https://userapps.support.sap.com/sap/support/knowledge/en/3514624)). The node does read-then-write itself: it `GET`s the entity, takes the ETag, then writes, and fails with a readable "changed since you read it" on 412 instead of retrying with `*`. `If-Match: *` is an explicit advanced option, off by default. |
| **Service version** | A lowercase `v` in version parameters: an uppercase `V` resolved to an obsolete version and caused a 412 ([KBA 3778784](https://userapps.support.sap.com/sap/support/knowledge/en/3778784)). The node builds only lowercase. |
| **Paging** | V2: `$top`, `$skip`, `$inlinecount=allpages`, and the server may answer `__next`. V4: `$top`, `$skip`, `$count`, `@odata.nextLink`. Server page-size caps per service are **UNVERIFIED**. The node follows next links up to its own `maxRecords`. |
| **Query options** | `$filter`, `$select`, `$expand`, `$orderby`. V2 supports a narrower set of filter functions than V4 ([Cloud SDK docs](https://sap.github.io/cloud-sdk/docs/java/v4/features/odata/v2-vdm-client)). Some APIs refuse `$filter` on a nested timestamp combined with `$expand` ([KBA 3790186](https://userapps.support.sap.com/sap/support/knowledge/en/3790186)). The node passes the user's `$filter` verbatim, quoted and URL-encoded, and surfaces SAP's refusal. |
| **`$metadata`** | `GET <service>/$metadata` (EDMX) gives entity sets, keys, properties, types, navigation properties and, per property, `sap:` annotations (creatable, updatable, filterable; **UNVERIFIED** which ones Public Edition returns). Large: cached per credential and service, with a TTL (default 1 hour), and fetched with `Accept: application/xml`. |
| **Batch** | `$batch` exists. The node does not use it in the first slices (one call, one trace record, one limit). A V4 `$batch` over a long-running service hit a hard 10-minute timeout and answered 500 ([KBA 3775025](https://userapps.support.sap.com/sap/support/knowledge/en/3775025)), one more reason to keep calls small. |
| **Keys** | OData V2 keys in the URL: `A_SalesOrder('4500000001')`, composite keys `A(Key1='x',Key2='y')`. Strings are quoted, quotes doubled, then encoded. The node builds keys from a typed `keys` object, never from a free string, so an agent cannot smuggle a path. |
| **Dates** | V2 JSON dates are `/Date(1700000000000)/` and `PT00H00M00S` durations. The node converts to ISO 8601 on read, and accepts ISO on write (option `keepSapDates` for raw). |
| **Rate limits** | Not published (finding 5). Honour 429 and `Retry-After`, back off, plugin concurrency default 4 per credential. |

#### 1.5 Custom fields and custom CDS views

- A customer adds fields with the Custom Fields and Logic app (key-user extensibility) and exposes custom CDS views through a **custom
  communication scenario**. I found no official page saying whether a custom field appears automatically in a released API
  ([search summary](https://userapps.support.sap.com/sap/support/knowledge/en/3614521)): **UNVERIFIED**. Custom fields normally carry a `YY1_` prefix and
  appear as extra properties in `$metadata` once the field is enabled for the API's business context (**UNVERIFIED**, from memory).
- Because the node reads `$metadata` from the tenant, anything the tenant exposes is visible without a code change: `$select` and write bodies
  take any property in the entity type, and the entity picker lists what `$metadata` returned. A **custom service path** option
  (`/sap/opu/odata/sap/ZMY_SERVICE_SRV`) works for custom CDS views once the admin adds them to a scenario and arrangement.
- Rules that must stay true: Z or `YY1_` names are never rewritten; a property missing from `$metadata` is refused before the request with
  "not in this tenant's service" rather than sent; the curated catalog never hard-codes custom fields.
- Once a custom CDS view is used by a scenario, incompatible changes are blocked on SAP's side ([KBA 3614521](https://userapps.support.sap.com/sap/support/knowledge/en/3614521)): flows break less on custom views than the field list suggests, but a removed field still fails at run time and the error mapping must say which property.

#### 1.6 Private Edition differences

The sources are thin here (no official page fetched), so this table is a list of things to confirm, not a design.

| Topic | Public Edition | Private Edition (UNVERIFIED unless linked) |
|---|---|---|
| Access | Communication scenario and arrangement | Same Fiori apps exist, but classic SAP Gateway services (`/n/iwfnd/maint_service`) and authorizations of a normal SAP user also apply |
| OAuth | PKCE, SAML bearer | Client credentials through `SOAUTH2` and an integration user ([Nango](https://nango.dev/docs/api-integrations/sap-odata-oauth2-cc/connect), a guide that does not name the edition); token path `/sap/bc/sec/oauth2/token?sap-client=<n>` |
| Network | Internet host `-api` | Often behind the customer's network: SAP Cloud Connector or a VPN ([SAP architecture page](https://architecture.learning.sap.com/docs/ref-arch/ebe268), search summary). Landflow runs locally: reachability is the user's problem, and the credential needs `sapClient` |
| Events | Event Mesh or Event Hub | SAP Event Mesh ([SAP Learning, Spanish](https://learning.sap.com/courses/integrating-systems-with-sap-subscription-billing-using-events-and-apis-es/explorar-como-se-integran-sap-s-4-hana-edicion-en-la-nube-publica-y-privada)) |
| Extensibility | Key-user (in-app) | Also developer extensibility, classic ABAP; custom OData services without a scenario |

### 2. Events

#### 2.1 What S/4HANA Cloud can emit

- S/4HANA Cloud publishes **business events** through **Enterprise Event Enablement**: a channel binding (Fiori app "Enterprise Event
  Enablement - Configure Channel Binding") and outbound topic bindings, via the communication arrangement `SAP_COM_0092`
  ([community Q&A](https://community.sap.com/t5/technology-q-a/automatic-sending-of-salesorder-messages-from-the-s-4-hana-public-cloud-to/qaq-p/14056023)
  and [Pricefx guide](https://knowledge.pricefx.com/accelerators-documentation-2/latest/connectors-and-integration-templates/sap-s-4hana-integration-with-pricefx-for-sap-integration-suite/sap-event-mesh-configuration/s-4hana-cloud),
  both third party or community, via search summaries). Topic forms in the sources differ
  (`sap/s4/beh/salesorder/v1/SalesOrder/Created/v1` and `sap/s4/beh/salesorder/created/v1`): **verify on a tenant**.
- The sink is **SAP Event Mesh**, **SAP Integration Suite, Advanced Event Mesh** (AEM), or **SAP Cloud Application Event Hub**
  ([CAP guide](https://cap.cloud.sap/docs/guides/events/s4)). AEM needs certificate-based authentication on the S/4HANA link
  (Pricefx summary). Event Hub is set up by registering the system in a BTP global account and a formation, after which S/4HANA creates the
  arrangement itself ([SAP tutorial](https://developers.sap.com/tutorials/eh-setup-s4hc.html)).
- **Format.** Event Hub requires **CloudEvents** (`id`, `source`, `specversion`, `type`, optional `datacontenttype`, `sappassport`)
  ([SAP tutorial](https://developers.sap.com/tutorials/eh-basic-concepts.html)); CAP consumes S/4HANA events as CloudEvents on Event Mesh too, with
  type names like `sap.s4.beh.businesspartner.v1.BusinessPartner.Changed.v1` ([CAP guide](https://cap.cloud.sap/docs/guides/events/s4)). The
  payload is **thin**: for Business Partner the `data` holds the key (`BusinessPartner`), not the record. So an event trigger emits "this
  key changed", and the next node does a Get. The event catalog is the "Event" section of each API on the Business Accelerator Hub
  ([CAP guide](https://cap.cloud.sap/docs/guides/events/s4)).

#### 2.2 Delivery to something like Landflow

| Option | What is known | Verdict |
|---|---|---|
| AMQP 1.0, MQTT 3.1.1, REST (webhook) from **SAP Event Mesh** | The older service supports these ([DEV Community post](https://dev.to/aliaksandr_tsviatkou/sap-btp-event-mesh-integration-event-driven-architecture-2n8g), third party); its webhook subscription does a challenge-response handshake before activation (same source). | **UNVERIFIED** against SAP docs. |
| REST, JMS, AMQP, MQTT, SMF from **AEM** | SAP Learning lists these ([course page](https://learning.sap.com/courses/sap-integration-suite/introducing-sap-integration-suite-advanced-event-mesh_fa92d521-c872-49d4-9bef-e5a3207eff27), search summary). A "REST delivery point" that posts queue messages to an HTTPS URL is, to my knowledge, an AEM feature; **no source confirmed its name or authentication options**. | **UNVERIFIED.** |
| **Event Hub** to a consumer | The tutorials do not say how a consumer receives events; CAP binds `kind: event-broker`. | **UNVERIFIED.** |

What Landflow can host today:

- **A webhook.** `apps/web/src/lib/server/app-webhooks.ts` registers a trigger's own webhook with an external service when a workflow is
  published (`checkExists`, `create`, `delete` on the plugin, hook id and secret kept as the node's static data), and the service calls
  `{publicUrl}/api/webhook/app/<workflowId>/<nodeId>`, which the plugin's `webhook()` verifies before a run starts. An SAP trigger fits
  as `triggerSource: "appWebhook"`, **but** `create` would have to configure a delivery point in AEM or Event Mesh through *their* management API
  (extra credentials, extra surface). Slice: the user sets up the delivery point by hand, once, and the trigger only verifies and parses
  (a shared secret or header the admin configures; options **UNVERIFIED**).
- **Brokers.** The brokers in `packages/transports` (including `amqp` and `amqp1`) carry the plugin protocol between the host and a plugin
  ([transports.md](../transports.md)); they are not a way for a trigger to consume an application queue, and there is no consumer-style
  trigger today. Reusing an AEM AMQP 1.0 queue would be a **new** trigger type (a long-lived consumer in the plugin, with ack after the run
  starts). Not planned until the webhook path is known to fail.
- **Cost and ops.** AEM and Event Mesh are paid BTP services and Event Hub needs a BTP account and formation; none of them can run locally.
  Event testing therefore uses a **fake delivery** (below), not a real broker.

#### 2.3 The polling alternative (the first trigger)

`triggerSource: "poll"` already exists (`apps/web/src/lib/server/poller.ts`): the host calls the trigger's Execute in mode `poll` with the previous
state, saves the returned state, and the first poll after activation or after a parameter or credential change sets only the baseline, as for every poll trigger. The SAP poll trigger:

- Parameters: service, entity set, **timestamp property** (a dropdown filled from `$metadata`: properties of type date or datetime whose name
  suggests change, e.g. `LastChangeDate`, `LastChangeDateTime`), optional extra `$filter`, `pollInterval` (min 60 s), `maxRecordsPerPoll`.
- State: `{ cursor, seen }` where `cursor` is the highest timestamp seen and `seen` holds the keys (and ETags) at that timestamp.
- Query: `$filter=<ts> ge <cursor minus overlap>` ordered by `<ts> asc`, paged to `maxRecordsPerPoll`; emit items whose key and ETag are
  not in `seen` (so a re-read of the overlap window is silent and an entity that changed again is emitted again).
- **Why overlap and a seen set.** The change fields are weak: `A_BusinessPartner` has `LastChangeDate` (a date, no time; a connector doc
  lists it with `CreationDate`, [sim.ai](https://docs.sim.ai/zh/tools/sap_s4hana), not SAP), and for `API_PRODUCT_SRV` `LastChangeDateTime` and
  `LastChangeDate` can disagree ([KBA 3646601](https://userapps.support.sap.com/sap/support/knowledge/en/3646601)). Which entities have a
  usable timestamp at all is **UNVERIFIED**; the catalog records it per entity and an entity with none is not offered as a trigger (use a
  schedule and a Get instead). Time zone: S/4HANA stores UTC in the datetime fields (**UNVERIFIED**), and the poll never compares with Landflow's clock, only with the cursor.
- Deletions are not seen by polling. Said plainly in the node's help.

### 3. The Landflow design

#### 3.1 Plugin

`plugins/sap` (`@landflow/plugin-sap`), TypeScript SDK, HTTP **7116**, gRPC **7216**, `pnpm plugin:sap` (opt-in, not in `dev:all`, like Agent
Shell and AI SDK; the next free numbers after 7115/7215). Same layout as `plugins/github`: `src/main.ts` (`definePlugin`, credential types,
`serve(plugin, { http: 7116, grpc: 7216, maxConcurrency: 4 })`), `src/odata/` (client, metadata, query builder, errors), `src/nodes/`,
`src/catalog/` (the curated services), `test/` (the fake server). Written like the web-search plugin: caps, limits and a README with the same
sections (node, credentials, safeguards, local testing).

#### 3.2 Nodes

1. **SAP OData** (`sapOData`, action, `usableAsTool`). Resource: Service (a picker from the curated catalog plus **Custom path**),
   Entity Set (from `$metadata`). Operations:

   | Operation | Does | Notes |
   |---|---|---|
   | **Get** | one entity by typed keys, optional `$select`, `$expand` | returns the ETag as `__etag` |
   | **List** | `$filter`, `$select`, `$expand`, `$orderby`, `$top`, paging | `Return All` with a hard `maxRecords` (default 100, ceiling 1000); count and `hasMore` reported |
   | **Create** | `POST` a JSON body (deep insert allowed) | idempotency key honoured: see 3.5 |
   | **Update** | read ETag, then `PATCH` with `If-Match` | only listed properties; V2 `MERGE` is not used |
   | **Delete** | read ETag, then `DELETE` with `If-Match` | off in agents unless explicitly enabled (3.5) |
   | **Function / Action** | call a function import or an unbound action | phase 2, writes if not read-only per metadata |

   Property list of the body: a **Fields (JSON)** box validated against `$metadata` types, plus an Add Field list built from the property
   dropdown (same pattern as the Browser plugin's Steps list and JSON box). `loadOptions` (service, entity set, property, key) come from
   the cached `$metadata`; they are never sent to a model.

2. **SAP Business Partner**, **Sales Order**, **Purchase Order**, **Product**, **Supplier Invoice**: *not new code*. Each is the same engine with
   a preset catalog entry, a short operation list and a friendlier field set (for example Sales Order: Get, List by customer and date, Create
   with items, Update delivery block; Purchase Order: Get, List, Create). They land in the node creator under **SAP**, so a person or Spotlight can
   find "Create purchase order". Slice 2 builds one (Business Partner, read) to prove the preset shape; the rest follow the same template.
   Each preset documents the communication scenario the admin must enable.

3. **SAP Trigger (Poll)** (2.3), and later **SAP Event** (appWebhook, 2.2).

Output items are plain JSON: SAP's `d`/`results` wrapper, `__metadata` and `__deferred` navigation links are stripped (V2) and the
ETag is kept as `__etag` plus `__keys`. The node declares `outputSchema`, as Browser does, so Spotlight sees the fields. It reads the schema
of what `$metadata` says for the chosen entity.

#### 3.3 Agent tool

`usableAsTool: true` on SAP OData with a `toolDescription` that lists what exists and says in so many words that returned values are data, not instructions
(free text fields such as a sales order note or a business partner name may hold anything). The tool takes `service`, `entitySet`,
`operation`, `keys`, `filter`, `select`, `expand`, `top`, `body`. Defaults when used as a tool:

- **Read-only.** The tool's `operation` enum offers only Get and List unless the node's **Allow writes** setting is on.
- Protocol: an operation named `create`/`update` is not read-only; `delete…` gets `destructiveHint` automatically ([protocol.md](../protocol.md)), and the node sets
  `destructiveHint: true` on Create and Update too (an override the protocol allows), so MCP clients' default approval applies.
- In Landflow's own agents, **Require approval** is a per-capability setting of the agent ([agents.md](../agents.md)): the SAP write tool is
  added with approval on, and a flow's AI Agent node lists it under Tools Requiring Approval. Whether the plugin can **force** approval for
  its write operations (so a person cannot turn it off by accident) is an open question and needs a host change (see Open questions).

#### 3.4 Errors

- Map SAP's error JSON, V2: `{"error":{"code":"...","message":{"lang":"en","value":"..."},"innererror":{"errordetails":[...]}}}`, and V4:
  `{"error":{"code","message","target","details":[]}}`. The exact SAP inner shapes are **UNVERIFIED** here; the build collects real samples
  (from the sandbox, with the user's decision) for the fake server's fixtures.
- Node error = `SAP <service> <operation> failed: <HTTP status> <code>: <message> (<target>)`, details listed, the HTTP status kept as a field,
  no request body and no credentials in it.
- 401: say so in the message, because the host renews an OAuth token once on an error that reads like a 401 ([protocol.md](../protocol.md)). 403: either the
  arrangement does not include the service or the CSRF token is missing or stale (the plugin refetches once itself). 404 on an entity: "no such key". 412/428: the ETag rule above. 429: wait
  `Retry-After` (cap 60 s, then fail with the hint). 5xx: retried once for reads only. HTML bodies (a login page when a host is wrong) become "not an OData answer".
- SAP business-rule errors (`SY/530` style messages in `innererror`) are passed on verbatim: an agent needs to read "customer is blocked".

#### 3.5 Writes, idempotency and the approval path

- SAP OData has no idempotency key. The SDK's `ExecuteRequest.idempotencyKey` protects Landflow's own retries over a broker: the node
  declares `idempotent: false` for writes (at most once, like GitHub), and reads opt back in.
- A create that times out may have succeeded. The node does not retry creates; on a timeout it tells the caller to **check before
  retrying** and, when the body has a customer-side reference (for example `PurchaseOrderByCustomer`), offers a Get-by-reference
  step in the template.
- Approvals use the **existing** paths: the agent approval cards in agents and in the AI Agent node, and the MCP approvals for
  external agents (`destructiveHint`, protocol.md section 15). Nothing new is built for slice 1. Run Trace records each SAP call as a tool span with the
  service, entity set, operation and HTTP status, and with the **keys** and counts, not the record (3.6).

#### 3.6 Safety

| Risk | Answer |
|---|---|
| A prompt makes an agent write to the ERP | Writes off by default; on, they need the node setting, the approval on the tool, and a credential that is itself least-privilege (a communication user or role that cannot create or change, for the read-only credential). Document "one credential per intent": a read-only arrangement and a separate write one. |
| Blast radius | **Max records per call** (List 1000, hard), **Max writes per run** (default 5, 0 = none; counted per execution in the plugin like Web Search's per-run limit), no `$batch` and no deep multi-entity PATCH, no wildcard `If-Match` unless the node setting says so, **no delete** unless `Allow deletes` is on as well. |
| Dry run | Option **Dry Run** (default **on** when called as an agent tool, off in a flow): validates the body against `$metadata`, reads the current entity, builds the request and returns "would POST/PATCH ... with this body, ETag ..." without sending the write. Reads still run, so the preview is real. SAP has no native preview, so this is Landflow's. |
| Data minimisation in traces | The tool span records service, entity set, operation, status, row count and keys; **bodies, `$filter` values and returned records are not in the span** unless the workflow's data-in-trace setting already stores them. Fields of personal data (business partner names, addresses, bank details, tax numbers) are the cause: a **Redact Fields** option (a list of property names, defaults for known personal and bank properties: **UNVERIFIED** list from the catalog) blanks them in output and logs when on. Agents get `$select` as a default of key fields, not `*`. |
| Secrets | Credentials stay in saved credentials; the plugin gets them only for the call, and its logs and spans drop them like all SDK plugins ([transports.md](../transports.md): SDKs redact credential values). The host's redaction (`redactorFor`) applies to traces. The error mapper never echoes request headers. The sandbox API key is a credential field. |
| SSRF | `baseUrl` must be https; an operator allow-list `LANDFLOW_SAP_ALLOWED_HOSTS` (suffixes such as `.s4hana.cloud.sap`, plus the loopback fake in tests, not by default) is checked on every request, and redirects are not followed to another host. Custom service path: must start with `/sap/` and contain no `..` or scheme. |
| A hostile text in a field | Same as Web Search: the description says data is data; the agent is not told to follow it; with writes on, approval is the backstop. |
| Prod vs test tenants | The credential has an `environment` label shown in the node and trace ("PROD", "Test"), and a flow that points at a production credential from the editor's Run button asks before running writes. (The mechanism is **to design**; Landflow has environments for variables, not yet for credential labelling.) |

### 4. Testing without a real SAP system

CLAUDE.md "Local only": nothing leaves the machine, no cloud, and AWS-style calls only go to LocalStack. SAP is a cloud service, so **no test calls
real SAP**.

#### 4.1 The fake S/4HANA server (`plugins/sap/test/fake-s4.ts`)

A loopback HTTP server started by the tests (as Web Search's fake providers are), binding `127.0.0.1` on a random port. It emulates, with fixtures
captured from the sandbox when the user allows it and written by hand until then:

| Emulated | Behaviour |
|---|---|
| OAuth token endpoint | `POST /sap/public/bc/sec/oauth2/token` (authorization-code exchange and refresh) and a client-credentials form for Private Edition; returns `access_token`, `expires_in`; an expired or revoked token gives 401 |
| Basic and API key | wrong password 401; missing arrangement 403 |
| `$metadata` | EDMX for 3 services (Business Partner, Sales Order, a custom `ZMY_SRV` with `YY1_` fields), with `sap:` annotations, keys, navigation properties |
| CSRF | `x-csrf-token: Fetch` on a `GET` returns a token and a session cookie; a write without the matching token and cookie is 403 with `x-csrf-token: Required`; the token expires on a timer to test the refetch |
| ETag | `GET` of one entity returns `ETag`; `PATCH` and `DELETE` without `If-Match` is 428, with a stale ETag is 412, `*` is accepted; every write changes the ETag |
| Paging and query | `$top`, `$skip`, `$inlinecount`, `__next` with a server page size, `$filter` subset (`eq`, `ge`, `and`, `startswith`), `$orderby`, `$select`, `$expand`; `LastChangeDateTime` that moves on write (and a `LastChangeDate`-only entity to test overlap) |
| Errors | The V2 and V4 error JSON, a business-rule error (400 with `innererror`), an HTML login page, a 429 with `Retry-After`, a 500, a slow call over the timeout, a 10-minute-like hang |
| Event delivery | A helper that POSTs a CloudEvent (thin payload) to the trigger's webhook URL with the configured secret, valid and invalid, to test the event trigger without a broker |
| Deletion rule | `A_SalesOrder` delete refused when a follow-on document exists (the documented rule) |

Unit tests of the query builder (key quoting, `$filter` encoding, lowercase `v`), the cursor and seen-set logic (overlap, duplicates, clock
skew), metadata parsing, the limits (max records, max writes per run, dry run) and the error mapper run without the server. Route-level and
trigger tests use the host test setup (`apps/web/test/setup.ts`) with the fake. **No test is allowed to default to a real host**: the base URL
has no default, and the integration flag below is off unless set.

#### 4.2 A real check against SAP (NOT to be run without the user's decision)

Not part of any default test run. A separate `LANDFLOW_INTEGRATION=sap` suite (listed in `docs/development.md` once built) that skips unless the flag
**and** explicit credentials variables are set. What it would need, so the user can decide:

- **Cheapest: the Business Accelerator Hub sandbox**, `https://sandbox.api.sap.com/s4hanacloud`, with a free SAP account's API key: read-only sample
  data ([Prismatic](https://prismatic.io/docs/components/sapS4Hana/)). It proves `$metadata`, paging, `$filter`, error shapes and the response
  parsing. It cannot prove writes, CSRF with a session, OAuth or arrangements. A key is a credential: **development key only**, stored as the
  user decides, never committed.
- **A trial or demo S/4HANA Cloud tenant**: SAP offers trial and free-tier-style access to some products; whether one exists for S/4HANA Cloud
  Public Edition now, and what it costs, is **UNVERIFIED** (not researched). It would need a communication user, system and arrangement per
  scenario, test master data and a test-only role. It is a **cloud service outside the local-only rule**: a call to it is a decision for the
  user, and he picks the tenant, the data it may change, and when it is switched off.
- Before any such run: a written test plan, read-only first, writes only on records the run created, and a cleanup step.

### 5. Plan

The estimates are **assumptions** (one developer with an agent, familiar with the SDK, no waits on SAP people) and exclude any real-tenant check.

| Phase | Deliverable | Estimate (assumed) | Done when |
|---|---|---|---|
| **0. Verify** | In a browser: official Help Portal pages for authentication, scenarios, events; scenario ids and service names of the five APIs; sandbox shapes. Updates this spec's UNVERIFIED list. | 0.5 to 1 day, needs the user's browser or an SAP account for the Hub | Every UNVERIFIED in "Unverified claims" is confirmed, corrected or kept with a reason. |
| **1. Smallest first slice: read-only** | `plugins/sap` with `sapS4hanaBasicApi` (and sandbox key), the SAP OData node with **Get and List only**, curated catalog with the 5 services, `$metadata` cache and pickers, paging with `maxRecords`, error mapping, usable as an agent tool, host registered on 7116/7216, fake server with token/`$metadata`/paging/errors, README | 3 to 5 days | A flow lists sales orders and gets one business partner from the fake server; an agent calls it as a tool and sees the trace span with keys and counts only, no bodies; limits and error cases tested; `pnpm --filter @landflow/plugin-sap test` passes with no network; docs and `docs/history.md` row. |
| **2. Writes and safety** | Create, Update, Delete with CSRF and ETag, Allow writes, approvals, Max writes, Dry run, idempotency notes; Business Partner and Purchase Order presets; Redact Fields | 4 to 6 days | Fake-server tests for 428, 412, expired CSRF, stale ETag and deep insert; an agent write waits for approval and a denied write sends nothing; dry run proven to send no write request. |
| **3. Poll trigger and OAuth** | SAP Trigger (Poll) with cursor and seen set; `sapS4hanaOAuth2Api` (PKCE) via `core.oAuth2Api`; Private Edition client-credentials type | 4 to 6 days | A change on the fake server fires one run once; restart keeps the cursor; overlap and duplicate tests; a PKCE round trip against the fake token endpoint; token refresh once on 401. |
| **4. Events** (only if D4 yes) | SAP Event trigger (appWebhook) with CloudEvents parsing and secret check; docs for setting up an AEM or Event Mesh delivery point | 3 to 5 days, plus the user's broker time | The fake delivery fires a run; a wrong secret is refused; the page says exactly which broker settings the admin must enter. |
| **5. SAML bearer** (only if the user cannot use PKCE or Basic) | Assertion signing, key and certificate handling in the credential, token exchange | 5 to 8 days | Fake token endpoint validates the assertion signature; certificate export for the admin documented. |
| **6. Real-system check** (the user's decision) | `LANDFLOW_INTEGRATION=sap` suite, test plan | 1 to 3 days | The user ran it on a system he picked; fixtures refreshed from it. |

Docs per CLAUDE.md for every phase: a feature page (`docs/sap.md`, listed in `docs/README.md`), `docs/reference/` for the variables
(`LANDFLOW_SAP_ALLOWED_HOSTS`, caps), `docs/limitations.md` and `docs/roadmap.md`, a `docs/history.md` row, and the compose and Kubernetes
entries (ports 7116/7216, opt-in profile, as for Browser).

## Risks

| Risk | Answer |
|---|---|
| The auth finding is wrong or changes (client credentials appears, or Basic is retired) | Phase 0 confirms on SAP pages; the credential type list is open ended; nothing else depends on the grant. |
| A user cannot get PKCE to work unattended (refresh token lifetime, user-bound) | Basic with a dedicated communication user is the fallback; SAML bearer is phase 5. |
| Fake and real SAP differ (EDMX annotations, error shapes, page sizes) | Fixtures from the sandbox when allowed; the plugin treats annotations as optional and falls back to "send and let SAP refuse"; real check is phase 6. |
| An agent changes ERP data wrongly | Layers in 3.6; the largest is approval plus a credential that cannot do more than intended. |
| Change timestamps miss changes (date-only fields, clock skew, time zones) | Overlap window and seen set; entity not offered for polling without a usable timestamp. |
| Rate limits arrive (2026 API policy) | Backoff, concurrency cap and `maxRecords`; no promise of throughput. |
| Personal data in traces and outputs | Keys-only spans, Redact Fields, `$select` by default. |
| SAP's terms for external API use (an API policy, indirect access licensing) | Out of scope for code, **UNVERIFIED**; the user checks his contract. Mentioned because a consultancy note on the 2026 API policy exists (above). |
| Scope creep into the whole SAP world (SuccessFactors, Ariba, IDoc, RFC, BAPI) | See "Not planned". |

## Open questions

1. Which tenant does the user have or intend to use (Public Edition test tenant, a customer's, none)? Which authentication does it allow?
2. Is **Basic** acceptable to the user for a first slice, given SAP may deprecate it (UNVERIFIED)?
3. Can the plugin **force approval** on write operations in Landflow's own agents? Today approval is a per-capability setting the person controls. A
   descriptor flag (for example `approval: 'always'` on an operation, as an MCP grant already has in `approval?: 'always' | 'destructive' | 'never'`) would be a host
   change; decide whether to make it.
4. Do we want a **credential environment label** (PROD or Test) as a host feature, since it matters here more than elsewhere?
5. Events: is the user willing to run AEM, Event Mesh or Event Hub (cost, BTP account), and is a public URL for the host available? If not, polling only.
6. Which five APIs and which operations matter most to the user's use case? (The curated list is a guess from the top objects in the brief.)
7. Is OData V2 only enough for the first release, given the unverified "maintenance mode" claim?
8. What is the real list of scenario ids, service paths, change-timestamp properties and event type names for the five objects (phase 0)?
9. Should the node use the Cloud SDK (`@sap-cloud-sdk/odata-v2`, MIT per the SAP docs, not checked) instead of hand-written OData code? Hand-written keeps dependencies small and
   matches the fake server; the SDK has a generator and typed clients. A small spike decides it in phase 1.

## Not planned

- SAP ECC or Private Edition as a primary target, on-premise Gateway administration, IDoc, RFC and BAPI calls, SOAP services, SAP GUI automation
  (a Desktop-agent job, see [18](18-desktop-agent-node.md)).
- Other SAP clouds (SuccessFactors, Ariba, Concur, Business One): different APIs and authentication.
- Running or emulating a broker for SAP events; owning the setup of Event Mesh, AEM or Event Hub for the customer.
- A live fetch of the Business Accelerator Hub catalog at run time; generating typed clients for every released API.
- `$batch`, change sets, delta tokens (V2 delta queries) and large data extraction (this is an integration node, not an ETL tool).
- Creating communication users, systems or arrangements through APIs; any admin action on the tenant.
- Reading attachments and large documents in the first slices (binary handling comes after the data path).
- Calling any real SAP system from a default test or from CI.

## Unverified claims

Marked in the text; collected here.

- Public Edition does not support inbound OAuth client credentials, and the inbound OAuth screen is fixed to PKCE (community answers only).
- Whether Basic is allowed or discouraged for production in Public Edition; the lifetime of PKCE refresh tokens.
- The API Hub sandbox key header name (`APIKey`) and that its data is read-only everywhere.
- V4 service paths for S/4HANA Cloud; page-size caps; which `sap:` annotations Public Edition returns in `$metadata`.
- That V2 APIs are in maintenance mode (one third-party page).
- Scenario ids for Sales Order, Purchase Order, Product and Supplier Invoice; the supplier invoice service name.
- That custom fields (`YY1_`) appear in released APIs and how; the exact V2 and V4 inner error shapes.
- That every Gateway behaviour in 1.4 (CSRF refetch rule, token header values) holds in Public Edition (standard Gateway behaviour; connectors rely on it).
- Which entities have a usable change timestamp, and their time zone.
- Event Mesh and AEM webhook or REST delivery options and their authentication, Event Hub consumer delivery, the topic string form.
- Rate limits, including the claim of hard 429 limits from 2026-11-13.
- Private Edition details in 1.6; whether a free trial of S/4HANA Cloud Public Edition exists and what it costs.
- The `@sap-cloud-sdk/odata-v2` licence and fit (not checked).

## Sources

- SAP developer tutorial, SAML bearer between BTP and S/4HANA Cloud public edition: https://developers.sap.com/tutorials/abap-environment-business-partner-oauthsamlbearer
- SAP developer tutorials, Event Hub: https://developers.sap.com/tutorials/eh-basic-concepts.html and https://developers.sap.com/tutorials/eh-setup-s4hc.html
- CAP, receiving events from S/4HANA Cloud: https://cap.cloud.sap/docs/guides/events/s4
- SAP knowledge base articles: [3514624](https://userapps.support.sap.com/sap/support/knowledge/en/3514624), [3778784](https://userapps.support.sap.com/sap/support/knowledge/en/3778784), [3775025](https://userapps.support.sap.com/sap/support/knowledge/en/3775025), [3757274](https://userapps.support.sap.com/sap/support/knowledge/en/3757274), [3646601](https://userapps.support.sap.com/sap/support/knowledge/en/3646601), [3790186](https://userapps.support.sap.com/sap/support/knowledge/en/3790186), [3614521](https://userapps.support.sap.com/sap/support/knowledge/en/3614521), [2911993](https://userapps.support.sap.com/sap/support/knowledge/en/2911993), [2669062](https://userapps.support.sap.com/sap/support/knowledge/en/2669062)
- SAP Community (several returned 403 to the fetch tool; read as search summaries): the client-type, CPI OAuth, principal propagation, SalesOrder events and scenario-list pages linked above
- SAP Business Accelerator Hub: https://api.sap.com/ (renders in JavaScript; not readable by the fetch tool)
- Third party: [Prismatic](https://prismatic.io/docs/components/sapS4Hana/), [Workato](https://docs.workato.com/connectors/sap-odata/sap-oauth-btp.html), [Nango](https://nango.dev/docs/api-integrations/sap-odata-oauth2-cc/connect), [WSO2](https://wso2.com/integration-platform/docs/connectors/catalog/erp-business/sap.s4hana.api_sales_order_srv/sap-sales-order-connector-overview), [Pricefx](https://knowledge.pricefx.com/accelerators-documentation-2/latest/connectors-and-integration-templates/sap-s-4hana-integration-with-pricefx-for-sap-integration-suite/sap-event-mesh-configuration/s-4hana-cloud), [DEV Community](https://dev.to/aliaksandr_tsviatkou/sap-btp-event-mesh-integration-event-driven-architecture-2n8g), [Redress Compliance](https://redresscompliance.com/research-notes/sap-api-policy-successfactors-rate-limits), [knowledgelib](https://knowledgelib.io/business/erp-integration/sap-s4hana-odata-api-capabilities/2026)
- Landflow: [protocol.md](../protocol.md) (OAuth2 credentials, app webhooks, poll triggers, MCP annotations and approvals), [transports.md](../transports.md), [agents.md](../agents.md), `apps/web/src/lib/server/app-webhooks.ts`, `apps/web/src/lib/server/poller.ts`, [plugins/web-search](../../plugins/web-search/README.md), [plugins/browser](../../plugins/browser/README.md), [plugins/github](../../plugins/github)
