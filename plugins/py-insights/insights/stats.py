"""Field Statistics: aggregate a numeric field across all input items."""

from __future__ import annotations

import json
import math
import statistics
from typing import Any

from landflow_sdk import Node, NodeOperationError

from .files import attach_result_file, binary_source_properties, flag, read_rows, result_file_properties
from .text import get_path


def _to_number(value: Any) -> float | int | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return value if math.isfinite(value) else None
    if isinstance(value, str):
        text = value.strip()
        try:
            return int(text)
        except ValueError:
            pass
        try:
            number = float(text)
        except ValueError:
            return None
        return number if math.isfinite(number) else None
    return None


def summarize(values: list[float | int]) -> dict[str, Any]:
    count = len(values)
    if not count:
        return {"count": 0, "sum": 0, "mean": None, "median": None, "min": None, "max": None, "stdev": None}
    total = sum(values) if all(isinstance(v, int) for v in values) else math.fsum(values)
    return {
        "count": count,
        "sum": total,
        "mean": statistics.fmean(values),
        "median": statistics.median(values),
        "min": min(values),
        "max": max(values),
        "stdev": statistics.stdev(values) if count > 1 else None,
    }


class FieldStats(Node):
    description = {
        "name": "stats",
        "displayName": "Field Statistics",
        "description": "Aggregate a numeric field across all items: count, sum, mean, median, min, max, stdev (sample)",
        "version": 1,
        "kind": "action",
        "idempotent": True,  # a pure computation over the input items: running it twice gives the same result
        "categories": ["Data"],
        "icon": "file:icons/stats.svg",
        "color": "#f59e0b",
        "subtitle": "{{field}}",
        "inputs": [{"type": "main"}],
        "outputs": [{"type": "main"}],
        "keywords": ["aggregate", "summarize", "average", "mean", "median", "sum", "group by"],
        "properties": [
            {
                "name": "field",
                "displayName": "Field",
                "type": "string",
                "default": "value",
                "required": True,
                "placeholder": "e.g. price or order.total",
                "description": "Numeric field to aggregate (dot paths allowed). Non-numeric values are skipped.",
            },
            {
                "name": "groupBy",
                "displayName": "Group By",
                "type": "string",
                "default": "",
                "placeholder": "e.g. category",
                "description": "Optional field to group by. When set, one item is emitted per group.",
            },
            *binary_source_properties("Rows From Binary File", "Aggregate the rows of a CSV, TSV, JSON or NDJSON file on each item instead of the item's own fields"),
            *result_file_properties("Attach a CSV of the statistics (one row per group) as a binary file"),
        ],
    }

    def execute(self, ctx):
        items = ctx.get_input_data()
        if flag(ctx, "fromBinary", 0):  # the rows of each item's file are the data: one pseudo-item per row
            items = [{"json": row} for i in range(len(items)) for row in read_rows(ctx, i)]
        field = str(ctx.get_node_parameter("field", 0) or "").strip()
        group_by = str(ctx.get_node_parameter("groupBy", 0) or "").strip()
        if not field:
            raise NodeOperationError("Field is required", description="Set 'Field' to the numeric property to aggregate.")

        groups: dict[str, dict[str, Any]] = {}
        for item in items:
            data = item["json"]
            if group_by:
                group_value = get_path(data, group_by)
                key = json.dumps(group_value, sort_keys=True, default=str)
            else:
                group_value, key = None, ""
            bucket = groups.setdefault(key, {"group": group_value, "values": [], "skipped": 0})
            number = _to_number(get_path(data, field))
            if number is None:
                bucket["skipped"] += 1
            else:
                bucket["values"].append(number)

        if not group_by:
            bucket = groups.get("", {"values": [], "skipped": 0})
            if items and not bucket["values"]:
                ctx.logger.warn(f"no numeric values found in '{field}' across {len(items)} item(s)")
            ctx.logger.info(f"aggregated {len(bucket['values'])} value(s) of '{field}' from {len(items)} item(s)")
            result = [{"json": {"field": field, **summarize(bucket["values"]), "skipped": bucket["skipped"]}}]
            self._attach(ctx, result)
            return result

        out = []
        for bucket in groups.values():
            out.append(
                {
                    "json": {
                        "groupBy": group_by,
                        "group": bucket["group"],
                        "field": field,
                        **summarize(bucket["values"]),
                        "skipped": bucket["skipped"],
                    }
                }
            )
        self._attach(ctx, out)
        ctx.logger.info(f"aggregated '{field}' from {len(items)} item(s) into {len(out)} group(s) by '{group_by}'")
        return out

    @staticmethod
    def _attach(ctx, out: list[dict[str, Any]]) -> None:
        """The ``outputFile`` option: one CSV row per output item."""
        columns = list(dict.fromkeys(key for item in out for key in item["json"]))
        attach_result_file(ctx, out, columns, [[item["json"].get(c) for c in columns] for item in out], "stats.csv")
