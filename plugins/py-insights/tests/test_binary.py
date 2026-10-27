"""Binary files on the insight nodes: text read from a file, rows read from a CSV / JSON file, a CSV result file."""

from __future__ import annotations

import base64
import csv
import io
import sys
import unittest
from pathlib import Path
from typing import Any

PLUGIN_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN_DIR))
try:
    import landflow_sdk  # noqa: F401
except ImportError:  # not installed: use the SDK from this checkout
    sys.path.insert(0, str(PLUGIN_DIR.parents[1] / "sdks" / "python"))

from insights import build_plugin  # noqa: E402


def file_ref(raw: bytes, name: str, mime: str | None = None) -> dict[str, Any]:
    ref: dict[str, Any] = {"fileName": name, "fileSize": len(raw), "data": base64.b64encode(raw).decode("ascii")}
    if mime:
        ref["mimeType"] = mime
    return ref


def run(node: str, parameters: dict[str, Any], items: list[dict[str, Any]]) -> dict[str, Any]:
    return build_plugin().execute({
        "protocol": "landflow.plugin/v1", "executionId": "ex_test", "mode": "manual",
        "node": {"id": "n1", "name": node, "type": f"py-insights.{node}", "typeVersion": 1},
        "parameters": parameters, "itemParameters": [], "inputs": [items],
    })


def result_csv(item: dict[str, Any], name: str = "data") -> list[dict[str, str]]:
    ref = item["binary"][name]
    assert ref["mimeType"] == "text/csv", ref
    return list(csv.DictReader(io.StringIO(base64.b64decode(ref["data"]).decode("utf-8"))))


class SentimentFileTests(unittest.TestCase):
    def test_reads_the_text_from_a_binary_file_and_keeps_the_file(self):
        raw = "I love this, it is great and wonderful".encode()
        item = {"json": {"id": 1}, "binary": {"data": file_ref(raw, "review.txt")}}
        response = run("sentiment", {"fromBinary": True}, [item])
        out = response["outputs"][0][0]
        self.assertEqual(out["json"]["sentiment"]["label"], "positive")
        self.assertEqual(out["binary"]["data"]["fileName"], "review.txt")

    def test_a_named_property_and_a_utf8_bom(self):
        raw = b"\xef\xbb\xbfthis is terrible and awful"
        item = {"json": {}, "binary": {"note": file_ref(raw, "note.md")}}
        out = run("sentiment", {"fromBinary": True, "binaryPropertyName": "note"}, [item])["outputs"][0][0]
        self.assertEqual(out["json"]["sentiment"]["label"], "negative")

    def test_without_the_option_the_field_is_still_used(self):
        out = run("sentiment", {"field": "text"}, [{"json": {"text": "good"}}])["outputs"][0][0]
        self.assertEqual(out["json"]["sentiment"]["label"], "positive")
        self.assertNotIn("binary", out)

    def test_a_missing_file_is_an_error(self):
        response = run("sentiment", {"fromBinary": True}, [{"json": {"text": "good"}}])
        self.assertIn('no binary file "data"', response["error"]["message"])

    def test_result_file_has_one_row_per_item(self):
        items = [{"json": {"text": "great"}}, {"json": {"text": "awful"}}]
        outputs = run("sentiment", {"field": "text", "outputFile": True, "outputBinaryName": "report"}, items)["outputs"][0]
        rows = result_csv(outputs[0], "report")
        self.assertEqual([r["label"] for r in rows], ["positive", "negative"])
        self.assertEqual(outputs[1]["binary"]["report"], outputs[0]["binary"]["report"])
        self.assertEqual(outputs[0]["binary"]["report"]["fileName"], "sentiment.csv")


class KeywordsFileTests(unittest.TestCase):
    def test_reads_the_text_from_a_binary_file(self):
        raw = b"kubernetes cluster kubernetes deploy kubernetes cluster"
        item = {"json": {}, "binary": {"data": file_ref(raw, "doc.txt", "text/plain")}}
        out = run("keywords", {"fromBinary": True, "topN": 2, "mode": "frequency", "language": "en", "minCount": 1}, [item])["outputs"][0][0]
        self.assertEqual(out["json"]["keywords"], ["kubernetes", "cluster"])
        self.assertIn("data", out["binary"])

    def test_result_file_lists_keywords_with_scores(self):
        items = [{"json": {"text": "apple apple banana"}}, {"json": {"text": "cherry"}}]
        params = {"field": "text", "topN": 1, "mode": "frequency", "language": "en", "minCount": 1, "outputFile": True}
        outputs = run("keywords", params, items)["outputs"][0]
        rows = result_csv(outputs[0])
        self.assertEqual([(r["item"], r["rank"], r["keyword"]) for r in rows], [("0", "1", "apple"), ("1", "1", "cherry")])


class StatsFileTests(unittest.TestCase):
    def test_aggregates_the_rows_of_a_csv_file(self):
        raw = b"category,price\nfruit,10\nfruit,20\nveg,5\n"
        item = {"json": {}, "binary": {"data": file_ref(raw, "prices.csv")}}
        out = run("stats", {"field": "price", "fromBinary": True}, [item])["outputs"][0][0]["json"]
        self.assertEqual((out["count"], out["sum"], out["max"]), (3, 35, 20))

    def test_semicolon_csv_and_group_by(self):
        raw = "category;price\nfruit;1,5\nfruit;2\nveg;4\n".encode()
        raw = raw.replace(b"1,5", b"1.5")
        item = {"json": {}, "binary": {"data": file_ref(raw, "prices.csv", "text/csv")}}
        outputs = run("stats", {"field": "price", "groupBy": "category", "fromBinary": True}, [item])["outputs"][0]
        by_group = {o["json"]["group"]: o["json"] for o in outputs}
        self.assertEqual(by_group["fruit"]["sum"], 3.5)
        self.assertEqual(by_group["veg"]["count"], 1)

    def test_json_array_and_wrapped_object(self):
        array = b'[{"v": 1}, {"v": 2}, {"v": "x"}]'
        wrapped = b'{"data": [{"v": 10}]}'
        items = [{"json": {}, "binary": {"data": file_ref(array, "a.json")}}, {"json": {}, "binary": {"data": file_ref(wrapped, "b.json")}}]
        out = run("stats", {"field": "v", "fromBinary": True}, items)["outputs"][0][0]["json"]
        self.assertEqual((out["count"], out["sum"], out["skipped"]), (3, 13, 1))

    def test_ndjson_and_sniffed_content(self):
        nd = b'{"v": 4}\n{"v": 6}\n'
        item = {"json": {}, "binary": {"data": file_ref(nd, "rows.txt")}}
        out = run("stats", {"field": "v", "fromBinary": True}, [item])["outputs"][0][0]["json"]
        self.assertEqual(out["sum"], 10)

    def test_invalid_json_is_a_clear_error(self):
        item = {"json": {}, "binary": {"data": file_ref(b"{nope", "x.json")}}
        response = run("stats", {"field": "v", "fromBinary": True}, [item])
        self.assertIn("not valid JSON", response["error"]["message"])

    def test_result_file_has_a_row_per_group(self):
        items = [{"json": {"c": "a", "v": 1}}, {"json": {"c": "b", "v": 2}}, {"json": {"c": "a", "v": 3}}]
        outputs = run("stats", {"field": "v", "groupBy": "c", "outputFile": True}, items)["outputs"][0]
        rows = result_csv(outputs[0])
        self.assertEqual({r["group"]: r["sum"] for r in rows}, {"a": "4", "b": "2"})
        self.assertEqual(len(outputs), 2)

    def test_manifest_declares_the_options(self):
        nodes = {n["name"]: n for n in build_plugin().manifest()["nodes"]}
        for name in ("stats", "sentiment", "keywords"):
            names = {p["name"] for p in nodes[name]["properties"]}
            self.assertTrue({"fromBinary", "binaryPropertyName", "outputFile", "outputBinaryName"} <= names, name)


if __name__ == "__main__":
    unittest.main()
