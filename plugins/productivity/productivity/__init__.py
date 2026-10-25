"""productivity: Notion, Airtable, GitHub, Jira, HubSpot and RSS nodes for Landflow."""

from __future__ import annotations

from landflow_sdk import Plugin, Telemetry

from .airtable import AIRTABLE_TOKEN_API, Airtable
from .github import GITHUB_API, GitHub, GitHubTrigger, GitHubWebhookTrigger
from .hubspot import HUBSPOT_APP_TOKEN, HubSpot
from .jira import JIRA_CLOUD_API, JIRA_SERVER_PAT_API, JiraNode
from .notion import NOTION_API, Notion
from .rss import RssFeedRead, RssFeedReadTrigger

PLUGIN_ID = "productivity"
VERSION = "0.1.0"


def build_plugin(telemetry: Telemetry | None = None) -> Plugin:
    return Plugin(
        PLUGIN_ID,
        "Productivity",
        VERSION,
        nodes=[Notion(), Airtable(), GitHub(), GitHubTrigger(), GitHubWebhookTrigger(), JiraNode(), HubSpot(), RssFeedRead(), RssFeedReadTrigger()],
        credential_types=[NOTION_API, AIRTABLE_TOKEN_API, GITHUB_API, JIRA_CLOUD_API, JIRA_SERVER_PAT_API, HUBSPOT_APP_TOKEN],
        description="Notion, Airtable, GitHub, Jira, HubSpot and RSS: actions, live pickers, polling triggers and a GitHub webhook trigger.",
        icon="file:icons/productivity.svg",  # relative to this package; inlined as a data: URL
        color="#7c3aed",
        author="Landflow",
        telemetry=telemetry,
    )
