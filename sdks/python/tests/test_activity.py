"""activity_item against the cases shared with the TypeScript and Go SDKs (packages/protocol/activity-items)."""

from __future__ import annotations

import json
import re
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from landflow_sdk.activity import ACTIVITY_ITEM_SCHEMA, activity_item, clip_text  # noqa: E402

DIR = Path(__file__).resolve().parents[3] / "packages" / "protocol" / "activity-items"
KEYS = {"source": "source", "sourceId": "source_id", "occurredAt": "occurred_at", "kind": "kind", "url": "url",
        "actorEmail": "actor_email", "title": "title", "summary": "summary", "teamHint": "team_hint",
        "initiativeHint": "initiative_hint", "customerHint": "customer_hint", "raw": "raw", "cursor": "cursor"}


def expand(value):
    """``{{repeat:c:n}}rest`` is c n times then rest; ``{{range:n}}`` is [0, …, n-1]."""
    if isinstance(value, str):
        m = re.match(r"^\{\{repeat:(.):(\d+)\}\}(.*)$", value, re.S)
        if m:
            return m.group(1) * int(m.group(2)) + m.group(3)
        m = re.match(r"^\{\{range:(\d+)\}\}$", value)
        if m:
            return list(range(int(m.group(1))))
        return value
    if isinstance(value, list):
        return [expand(v) for v in value]
    if isinstance(value, dict):
        return {k: expand(v) for k, v in value.items()}
    return value


@unittest.skipUnless((DIR / "cases.json").exists(), "activity item cases not found")
class ActivityItemTest(unittest.TestCase):
    def test_schema_matches_published(self) -> None:
        published = json.loads((DIR / "activity-item.schema.json").read_text())
        for key in ("properties", "required", "additionalProperties"):
            self.assertEqual(ACTIVITY_ITEM_SCHEMA[key], published[key], key)

    def test_shared_cases(self) -> None:
        fixture = json.loads((DIR / "cases.json").read_text())
        self.assertEqual(fixture["kit"], "landflow.activity-items/v1")
        for case in fixture["cases"]:
            with self.subTest(case["id"]):
                kwargs = {KEYS[k]: v for k, v in expand(case["input"]).items()}
                if "error" in case:
                    with self.assertRaisesRegex(ValueError, re.escape(case["error"])):
                        activity_item(**kwargs)
                    continue
                self.assertEqual(activity_item(**kwargs), expand(case["output"]))

    def test_extras(self) -> None:
        self.assertEqual(clip_text("😀😀😀", 2), "😀…")
        item = activity_item(source="s", source_id="i", kind="work.x", occurred_at=datetime(2026, 11, 12, tzinfo=timezone.utc), raw=("a", "b"))
        self.assertEqual(item["occurredAt"], "2026-11-12T00:00:00.000Z")
        self.assertEqual(item["raw"], {"value": ["a", "b"]})
        self.assertNotIn("cursor", item)


if __name__ == "__main__":
    unittest.main()
