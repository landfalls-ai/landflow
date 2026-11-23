"""productivity: Notion (with a polling trigger), Airtable, GitHub, Jira, HubSpot, Stripe and RSS nodes for Landflow."""

from __future__ import annotations

from landflow_sdk import Plugin, Telemetry

from .airtable import AIRTABLE_OAUTH2_API, AIRTABLE_TOKEN_API, Airtable
from .github import GITHUB_API, GITHUB_APP_API, GITHUB_OAUTH2_API, GitHub, GitHubTrigger, GitHubWebhookTrigger
from .hubspot import HUBSPOT_APP_TOKEN, HUBSPOT_OAUTH2_API, HubSpot
from .jira import JIRA_CLOUD_API, JIRA_CLOUD_OAUTH2_API, JIRA_SERVER_PAT_API, JiraNode
from .notion import NOTION_API, NOTION_OAUTH2_API, Notion
from .notion_activity import NotionTrigger
from .rss import RssFeedRead, RssFeedReadTrigger
from .stripe import STRIPE_API, StripeWebhookTrigger

PLUGIN_ID = "productivity"
VERSION = "0.1.0"


def build_plugin(telemetry: Telemetry | None = None) -> Plugin:
    return Plugin(
        PLUGIN_ID,
        "Productivity",
        VERSION,
        nodes=[Notion(), NotionTrigger(), Airtable(), GitHub(), GitHubTrigger(), GitHubWebhookTrigger(), StripeWebhookTrigger(), JiraNode(), HubSpot(), RssFeedRead(), RssFeedReadTrigger()],
        credential_types=[NOTION_API, NOTION_OAUTH2_API, AIRTABLE_TOKEN_API, AIRTABLE_OAUTH2_API, GITHUB_API, GITHUB_OAUTH2_API, GITHUB_APP_API, JIRA_CLOUD_API, JIRA_CLOUD_OAUTH2_API, JIRA_SERVER_PAT_API, HUBSPOT_APP_TOKEN, HUBSPOT_OAUTH2_API, STRIPE_API],
        description="Notion, Airtable, GitHub, Jira, HubSpot, Stripe and RSS: actions, live pickers, polling triggers (Notion pages, GitHub, RSS) and GitHub and Stripe webhook triggers.",
        icon="file:icons/productivity.svg",  # relative to this package; inlined as a data: URL
        color="#7c3aed",
        author="Landflow",
        telemetry=telemetry,
    )
