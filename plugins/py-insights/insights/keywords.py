"""Keyword Extract: top-N keywords per item, by frequency or a light TF-IDF."""

from __future__ import annotations

import math
from collections import Counter
from typing import Any

from landflow_sdk import Node, NodeOperationError

from .text import LANGUAGE_NAMES, STOPWORDS, get_path, set_path, stopwords_for, tokenize

MIN_WORD_LENGTH = 3


def _keywords_tokens(text: str, language: str) -> list[str]:
    stop = stopwords_for(language)
    words = []
    for token in tokenize(text):
        if token.endswith("'s"):
            token = token[:-2]
        if len(token) >= MIN_WORD_LENGTH and token not in stop:
            words.append(token)
    return words


def _int_param(ctx, name: str, item_index: int, low: int, high: int) -> int:
    raw = ctx.get_node_parameter(name, item_index)
    try:
        value = int(float(raw))
    except (TypeError, ValueError):
        raise NodeOperationError(f"'{name}' must be a number, got {raw!r}", item_index=item_index) from None
    return max(low, min(high, value))


class KeywordExtract(Node):
    description = {
        "name": "keywords",
        "displayName": "Keyword Extract",
        "description": "Extract the top-N keywords from a text field, with stopword removal",
        "version": 1,
        "kind": "action",
        "idempotent": True,  # a pure computation over the input items: running it twice gives the same result
        "categories": ["Text"],
        "icon": "file:icons/keywords.svg",
        "color": "#fbbf24",
        "subtitle": "{{mode}} · top {{topN}}",
        "inputs": [{"type": "main"}],
        "outputs": [{"type": "main"}],
        "usableAsTool": True,
        "toolDescription": (
            "Extract the most important keywords from a text. Pass the text in the `text` argument "
            "(optionally `topN`, default 5). Returns `keywords`, a list of lowercase words ranked by "
            "importance with common stopwords removed. Use it to tag, summarize or route documents."
        ),
        "keywords": ["keywords", "tags", "topics", "tf-idf", "extract", "terms"],
        "properties": [
            {
                "name": "field",
                "displayName": "Text Field",
                "type": "string",
                "default": "text",
                "required": True,
                "description": "Field holding the text (dot paths allowed)",
            },
            {
                "name": "topN",
                "displayName": "Top N",
                "type": "number",
                "default": 5,
                "typeOptions": {"minValue": 1, "maxValue": 100},
                "description": "How many keywords to return per item",
            },
            {
                "name": "mode",
                "displayName": "Ranking",
                "type": "options",
                "default": "frequency",
                "noDataExpression": True,
                "options": [
                    {"name": "Frequency", "value": "frequency", "description": "Most frequent words in the item"},
                    {
                        "name": "TF-IDF Lite",
                        "value": "tfidf-lite",
                        "description": "Frequent in this item, rare across all input items",
                    },
                ],
            },
            {
                "name": "minCount",
                "displayName": "Minimum Occurrences",
                "type": "number",
                "default": 1,
                "typeOptions": {"minValue": 1},
                "description": "Ignore words that appear fewer times than this in the item",
                "displayOptions": {"show": {"mode": ["frequency"]}},
            },
            {
                "name": "tfidfNotice",
                "displayName": "TF-IDF Lite compares items with each other, so send several items (one per document).",
                "type": "notice",
                "default": "",
                "displayOptions": {"show": {"mode": ["tfidf-lite"]}},
            },
            {
                "name": "language",
                "displayName": "Stopword Language",
                "type": "options",
                "default": "en",
                "typeOptions": {"loadOptionsMethod": "languages"},
                "description": "Which stopword list to remove",
            },
            {
                "name": "outputField",
                "displayName": "Output Field",
                "type": "string",
                "default": "keywords",
            },
            {
                "name": "includeScores",
                "displayName": "Include Scores",
                "type": "boolean",
                "default": False,
                "description": "Emit [{keyword, score}] instead of plain strings",
            },
        ],
    }

    def load_options(self, method: str, parameters: dict[str, Any]) -> list[dict[str, Any]]:
        if method == "languages":
            return [
                {
                    "name": LANGUAGE_NAMES[code],
                    "value": code,
                    "description": f"{len(STOPWORDS[code])} stopwords" if STOPWORDS[code] else "No stopword removal",
                }
                for code in LANGUAGE_NAMES
            ]
        return super().load_options(method, parameters)

    def execute(self, ctx):
        items = ctx.get_input_data()
        docs: list[list[str]] = []
        for i, item in enumerate(items):
            field = str(ctx.get_node_parameter("field", i) or "text")
            text = get_path(item["json"], field)
            if text is None:
                raise NodeOperationError(
                    f"Item {i} has no field '{field}'",
                    description="Set 'Text Field' to the property that holds the text.",
                    item_index=i,
                )
            docs.append(_keywords_tokens(text if isinstance(text, str) else str(text), str(ctx.get_node_parameter("language", i) or "en")))

        doc_freq: Counter[str] = Counter()
        for words in docs:
            doc_freq.update(set(words))
        n_docs = len(docs)

        out = []
        for i, (item, words) in enumerate(zip(items, docs)):
            top_n = _int_param(ctx, "topN", i, 1, 100)
            mode = ctx.get_node_parameter("mode", i)
            counts = Counter(words)
            first_seen = {w: idx for idx, w in reversed(list(enumerate(words)))}
            if mode == "tfidf-lite":
                total = len(words) or 1
                scores = {
                    w: (c / total) * (math.log((1 + n_docs) / (1 + doc_freq[w])) + 1.0) for w, c in counts.items()
                }
            elif mode in (None, "", "frequency"):
                min_count = _int_param(ctx, "minCount", i, 1, 1_000_000)
                scores = {w: float(c) for w, c in counts.items() if c >= min_count}
            else:
                raise NodeOperationError(f"Unknown ranking mode {mode!r}", item_index=i)
            ranked = sorted(scores, key=lambda w: (-scores[w], first_seen[w]))[:top_n]
            if ctx.get_node_parameter("includeScores", i):
                value: Any = [{"keyword": w, "score": round(scores[w], 4)} for w in ranked]
            else:
                value = ranked
            data = dict(item["json"])
            set_path(data, str(ctx.get_node_parameter("outputField", i) or "keywords"), value)
            out.append({"json": data})
        ctx.logger.info(f"extracted keywords from {len(out)} item(s)")
        return out
