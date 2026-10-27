"""Stripe: the Stripe Trigger, a webhook endpoint registered when the workflow is published (the only Stripe node here: no actions yet)."""

from __future__ import annotations

from typing import Any

from landflow_sdk import CredentialType, Node, NodeOperationError, verify_stripe_signature

from .common import Api, api_error, collection, count_new_items, count_written, split_list, test_call

DEFAULT_BASE_URL = "https://api.stripe.com"
DEFAULT_TOLERANCE_SECONDS = 300
PERMISSION_HINT = "The key needs Write access to Webhook Endpoints (a secret key sk_… always has it; a restricted key rk_… needs it granted)."


def stripe_api(ctx: Any, creds: dict[str, Any]) -> Api:
    headers = {"Authorization": f"Bearer {creds.get('apiKey', '')}"}
    if str(creds.get("stripeVersion") or "").strip():
        headers["Stripe-Version"] = str(creds["stripeVersion"]).strip()
    return Api(ctx, "stripe", creds.get("baseUrl") or DEFAULT_BASE_URL, headers)


def test_stripe(data: dict[str, Any], ctx: Any) -> tuple[bool, str]:
    ok, reason, balance = test_call(stripe_api(ctx, data), "/v1/balance")
    if not ok:
        return False, reason or "Stripe rejected the key"
    mode = "live mode" if isinstance(balance, dict) and balance.get("livemode") else "test mode"
    return True, f"authenticated ({mode})"


STRIPE_API = CredentialType(
    name="stripeApi",
    display_name="Stripe API",
    documentation_url="https://docs.stripe.com/keys",
    description="A secret key (sk_live_… / sk_test_…) or a restricted key (rk_…) from Developers, API keys. The Stripe Trigger registers a webhook endpoint "
                "with it, so a restricted key needs Write access to Webhook Endpoints.",
    test=test_stripe,
    properties=[
        {"name": "apiKey", "displayName": "Secret Key", "type": "string", "required": True, "typeOptions": {"password": True},
         "placeholder": "sk_live_… / sk_test_… / rk_…"},
        {"name": "baseUrl", "displayName": "API Base URL", "type": "string", "default": DEFAULT_BASE_URL,
         "description": "Only to point at a proxy or a test double"},
        {"name": "stripeVersion", "displayName": "Stripe-Version", "type": "string", "default": "", "placeholder": "optional, e.g. 2024-06-20",
         "description": "Pins the API version of requests (and of events sent to the endpoint it registers); empty: the account's default"},
    ],
)

EVENTS = [
    ("Any Event", "*", "Every event Stripe sends (all event types, current and future)"),
    ("Charge Dispute Created", "charge.dispute.created", None),
    ("Charge Failed", "charge.failed", None),
    ("Charge Refunded", "charge.refunded", None),
    ("Charge Succeeded", "charge.succeeded", None),
    ("Checkout Session Completed", "checkout.session.completed", "A customer completed Checkout"),
    ("Checkout Session Expired", "checkout.session.expired", None),
    ("Customer Created", "customer.created", None),
    ("Customer Deleted", "customer.deleted", None),
    ("Customer Updated", "customer.updated", None),
    ("Customer Subscription Created", "customer.subscription.created", None),
    ("Customer Subscription Deleted", "customer.subscription.deleted", "A subscription was canceled"),
    ("Customer Subscription Trial Will End", "customer.subscription.trial_will_end", "Three days before a trial ends"),
    ("Customer Subscription Updated", "customer.subscription.updated", None),
    ("Invoice Created", "invoice.created", None),
    ("Invoice Finalized", "invoice.finalized", None),
    ("Invoice Paid", "invoice.paid", None),
    ("Invoice Payment Failed", "invoice.payment_failed", None),
    ("Invoice Payment Succeeded", "invoice.payment_succeeded", None),
    ("Payment Intent Canceled", "payment_intent.canceled", None),
    ("Payment Intent Created", "payment_intent.created", None),
    ("Payment Intent Payment Failed", "payment_intent.payment_failed", None),
    ("Payment Intent Succeeded", "payment_intent.succeeded", None),
    ("Payout Failed", "payout.failed", None),
    ("Payout Paid", "payout.paid", None),
    ("Price Created", "price.created", None),
    ("Product Created", "product.created", None),
    ("Setup Intent Succeeded", "setup_intent.succeeded", None),
]


class StripeWebhookTrigger(Node):
    """Registers a Stripe webhook endpoint when the workflow is published (Stripe returns its signing secret ``whsec_…`` once, kept in
    the static data), verifies every call's ``Stripe-Signature`` and starts a run per selected event. Stripe retries a failed delivery
    for days: the event id is the idempotency key, so a retry starts no second run."""

    description = {
        "name": "stripeWebhookTrigger",
        "displayName": "Stripe Trigger",
        "description": "Starts the workflow on Stripe events: payments, invoices, subscriptions, customers, …",
        "version": 1,
        "kind": "trigger",
        "triggerSource": "appWebhook",
        "categories": ["Finance"],
        "icon": "file:icons/stripe.svg",
        "color": "#635BFF",
        "subtitle": "{{events}}",
        "documentationUrl": "https://docs.stripe.com/webhooks",
        "inputs": [],
        "outputs": [{"type": "main"}],
        "credentials": [{"name": "stripeApi", "required": True}],
        "keywords": ["stripe", "payment", "webhook", "invoice", "subscription", "checkout", "charge", "event"],
        "properties": [
            {
                "name": "webhookNotice", "type": "notice", "default": "",
                "displayName": "Landflow creates the webhook endpoint in your Stripe account (live or test mode, as the key) when you publish the workflow "
                               "and deletes it when you unpublish. " + PERMISSION_HINT,
            },
            {
                "name": "events", "displayName": "Events", "type": "multiOptions", "default": ["payment_intent.succeeded"],
                "noDataExpression": True, "options": [{"name": name, "value": value, **({"description": text} if text else {})} for name, value, text in EVENTS],
                "description": "The event types Stripe sends to Landflow; each starts one run",
            },
            {
                "name": "additionalEvents", "displayName": "Additional Events", "type": "string", "default": "", "noDataExpression": True,
                "placeholder": "invoice.upcoming, customer.tax_id.created",
                "description": "More event types, comma-separated (any type from Stripe's event reference)",
            },
            {
                "name": "options", "displayName": "Options", "type": "collection", "default": {}, "placeholder": "Add option",
                "values": [
                    {"name": "tolerance", "displayName": "Signature Tolerance (s)", "type": "number", "default": DEFAULT_TOLERANCE_SECONDS,
                     "typeOptions": {"minValue": 0}, "description": "How far the signed timestamp may be from now before the call is rejected as a replay"},
                    {"name": "connect", "displayName": "Listen to Connected Accounts", "type": "boolean", "default": False,
                     "description": "Whether the endpoint receives events of the connected accounts of a Stripe Connect platform (items then have an account id)"},
                ],
            },
        ],
    }

    def execute(self, ctx):
        # A manual run has no event: the trigger outputs nothing (pin data from a past execution to test downstream nodes).
        ctx.logger.info("Stripe sends events to the published workflow; a manual run has no event to output")
        return []

    # -- lifecycle (docs/protocol.md §12)

    @staticmethod
    def _events(ctx) -> list[str]:
        raw = ctx.get_node_parameter("events") or []
        picked = [str(e).strip() for e in (raw if isinstance(raw, list) else split_list(raw)) if str(e).strip()]
        events = {*picked, *split_list(ctx.get_node_parameter("additionalEvents", 0, ""))}
        if "*" in events:
            return ["*"]
        if not events:
            raise NodeOperationError("Select at least one event", description="Pick events, add some under Additional Events, or choose Any Event.")
        return sorted(events)

    def webhook_check_exists(self, ctx):
        endpoint_id = ctx.get_static_data().get("webhookId")
        if not endpoint_id:
            return False
        resp = stripe_api(ctx, ctx.get_credentials("stripeApi")).request("GET", f"/v1/webhook_endpoints/{endpoint_id}", expect=(404,))
        endpoint = resp.json if isinstance(resp.json, dict) else {}
        if resp.status == 404 or endpoint.get("deleted"):
            return False
        return (endpoint.get("url") == ctx.get_webhook_url() and endpoint.get("status", "enabled") == "enabled"
                and sorted(endpoint.get("enabled_events") or []) == self._events(ctx))

    def webhook_create(self, ctx):
        api = stripe_api(ctx, ctx.get_credentials("stripeApi"))
        events = self._events(ctx)
        connect = bool(collection(ctx, "options", 0).get("connect"))
        form: dict[str, Any] = {"url": ctx.get_webhook_url(), "enabled_events[]": events,
                                "description": f"Landflow workflow {ctx.workflow_id}"}
        if connect:
            form["connect"] = "true"
        with ctx.span("stripe.webhook.create", {"stripe.events": ",".join(events)}):
            resp = api.request("POST", "/v1/webhook_endpoints", data=form, expect=(403,))
        if resp.status == 403:
            raise NodeOperationError("Stripe API error (HTTP 403): the key cannot create webhook endpoints", description=PERMISSION_HINT)
        endpoint = resp.json if isinstance(resp.json, dict) else {}
        if not endpoint.get("id") or not endpoint.get("secret"):
            raise NodeOperationError("Stripe did not return the endpoint's signing secret")
        ctx.set_static_data({"webhookId": endpoint["id"], "webhookSecret": endpoint["secret"], "webhookEvents": events, "connect": connect})
        count_written(ctx, "stripe", "webhook.create")
        ctx.logger.info(f"Stripe webhook endpoint {endpoint['id']} created", events=",".join(events))
        return True

    def webhook_delete(self, ctx):
        endpoint_id = ctx.get_static_data().get("webhookId")
        if endpoint_id:
            resp = stripe_api(ctx, ctx.get_credentials("stripeApi")).request("DELETE", f"/v1/webhook_endpoints/{endpoint_id}", expect=(404,))
            if resp.status != 404:
                count_written(ctx, "stripe", "webhook.delete")
        ctx.set_static_data({})
        return True

    def webhook(self, ctx):
        static = ctx.get_static_data()
        try:
            tolerance = float(collection(ctx, "options", 0).get("tolerance", DEFAULT_TOLERANCE_SECONDS))
        except (TypeError, ValueError):
            tolerance = float(DEFAULT_TOLERANCE_SECONDS)
        if not verify_stripe_signature(str(static.get("webhookSecret") or ""), ctx.get_raw_body(), ctx.get_header("Stripe-Signature"),
                                       tolerance_seconds=max(0.0, tolerance)):
            ctx.logger.warn("rejected a call with a missing, invalid or stale Stripe-Signature")
            return {"response": {"status": 401, "json": {"error": "invalid signature"}}}
        body = ctx.get_body()
        if not isinstance(body, dict) or not body.get("id") or not body.get("type"):
            return {"response": {"status": 400, "json": {"error": "not a Stripe event"}}}
        event_type = str(body["type"])
        events = static.get("webhookEvents") or ["*"]
        if "*" not in events and event_type not in events:
            return {"response": {"status": 200, "json": {"ignored": event_type}}}  # 2xx: Stripe retries failures for days
        item = {
            "id": body["id"],
            "type": event_type,
            "created": body.get("created"),
            "livemode": body.get("livemode"),
            "data": body.get("data"),
            "apiVersion": body.get("api_version"),
            "request": body.get("request"),
            "body": body,
        }
        if body.get("account"):  # Stripe Connect: the connected account the event is about
            item["account"] = body["account"]
        count_new_items(ctx, "stripeWebhook", 1)
        return {"items": [item], "idempotencyKey": str(body["id"])}
