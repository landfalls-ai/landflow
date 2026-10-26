"""Sentiment: lexicon-based polarity scoring (no model, no network)."""

from __future__ import annotations

import math
from typing import Any

from landflow_sdk import Node, NodeOperationError

from .text import INTENSIFIERS, LEXICON, NEGATION_WINDOW, NEGATORS, get_path, set_path, tokenize

ALPHA = 15.0  # normalization constant: score = raw / sqrt(raw^2 + ALPHA), as in VADER
THRESHOLD = 0.05


def score_text(text: str) -> dict[str, Any]:
    tokens = tokenize(text)
    raw = 0.0
    matched: list[str] = []
    negate_until = -1
    for i, token in enumerate(tokens):
        if token in NEGATORS or token.endswith("n't"):
            negate_until = i + NEGATION_WINDOW
            continue
        weight = LEXICON.get(token)
        if weight is None:
            continue
        value = float(weight)
        phrase = token
        if i > 0 and tokens[i - 1] in INTENSIFIERS:
            value *= INTENSIFIERS[tokens[i - 1]]
            phrase = f"{tokens[i - 1]} {phrase}"
        if i <= negate_until:
            value *= -0.75  # "not good" is milder than "bad"
            phrase = f"not {phrase}"
        raw += value
        matched.append(phrase)
    score = raw / math.sqrt(raw * raw + ALPHA) if raw else 0.0
    score = round(max(-1.0, min(1.0, score)), 4)
    label = "positive" if score >= THRESHOLD else "negative" if score <= -THRESHOLD else "neutral"
    return {"score": score, "label": label, "matched": matched}


class Sentiment(Node):
    description = {
        "name": "sentiment",
        "displayName": "Sentiment",
        "description": "Score the sentiment of a text field (-1..1) with a built-in lexicon",
        "version": 1,
        "kind": "action",
        "idempotent": True,  # a pure computation over the input items: running it twice gives the same result
        "categories": ["AI", "Text"],
        "icon": "file:icons/sentiment.svg",
        "color": "#f97316",
        "subtitle": "{{field}}",
        "inputs": [{"type": "main"}],
        "outputs": [{"type": "main"}],
        "usableAsTool": True,
        "toolDescription": (
            "Analyze the emotional tone of a piece of text. Pass the text in the `text` argument. "
            "Returns `sentiment.score` from -1 (very negative) to 1 (very positive), `sentiment.label` "
            "(positive, neutral or negative) and `sentiment.matched`, the sentiment words that drove the "
            "score (negations such as 'not good' are handled). Deterministic and fast (lexicon-based, "
            "English); use it to triage reviews, support tickets or messages by tone, not for sarcasm."
        ),
        "keywords": ["sentiment", "tone", "emotion", "polarity", "opinion", "review"],
        "properties": [
            {
                "name": "field",
                "displayName": "Text Field",
                "type": "string",
                "default": "text",
                "required": True,
                "description": "Field holding the text to score (dot paths allowed)",
            },
            {
                "name": "outputField",
                "displayName": "Output Field",
                "type": "string",
                "default": "sentiment",
                "description": "Field that receives {score, label, matched}",
            },
        ],
    }

    def execute(self, ctx):
        items = ctx.get_input_data()
        out = []
        counts = {"positive": 0, "neutral": 0, "negative": 0}
        # A child span of the SDK's `plugin.execute py-insights.sentiment` server span.
        with ctx.span("insights.sentiment.score", {"insights.items": len(items)}) as span:
            for i, item in enumerate(items):
                field = str(ctx.get_node_parameter("field", i) or "text")
                output_field = str(ctx.get_node_parameter("outputField", i) or "sentiment")
                text = get_path(item["json"], field)
                if text is None:
                    raise NodeOperationError(
                        f"Item {i} has no field '{field}'",
                        description="Set 'Text Field' to the property that holds the text.",
                        item_index=i,
                    )
                result = score_text(text if isinstance(text, str) else str(text))
                counts[result["label"]] += 1
                data = dict(item["json"])
                set_path(data, output_field, result)
                out.append({"json": data})
            span.set_attributes({f"insights.sentiment.{label}": n for label, n in counts.items()})
        # Custom metric: Prometheus `insights_sentiment_labels_total{insights_sentiment_label=...}` on GET /metrics.
        labels = ctx.metrics.counter("insights.sentiment.labels", "{item}", "Items scored, by sentiment label")
        for label, n in counts.items():
            if n:
                labels.add(n, {"insights.sentiment.label": label})
        ctx.logger.info(
            f"scored {len(out)} item(s): {counts['positive']} positive, {counts['neutral']} neutral, "
            f"{counts['negative']} negative",
            **{f"insights.sentiment.{label}": n for label, n in counts.items()},
        )
        return out
