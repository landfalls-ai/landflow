"""py-insights: field statistics, sentiment and keyword extraction for Landflow."""

from landflow_sdk import Plugin

from .keywords import KeywordExtract
from .sentiment import Sentiment
from .stats import FieldStats

PLUGIN_ID = "py-insights"
VERSION = "0.1.0"


def build_plugin() -> Plugin:
    return Plugin(
        PLUGIN_ID,
        "Insights",
        VERSION,
        nodes=[FieldStats(), Sentiment(), KeywordExtract()],
        description="Dependency-free data and text insights: field statistics, lexicon sentiment, keyword extraction.",
        icon="file:icons/insights.svg",  # relative to this package; inlined as a data: URL
        color="#f59e0b",
        author="Landflow",
    )
