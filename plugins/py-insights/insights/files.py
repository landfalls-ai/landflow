"""Binary files for the insight nodes: text read from a binary file, rows read from a CSV / JSON file, and a CSV result file."""

from __future__ import annotations

import csv
import io
import json
from typing import Any

from landflow_sdk import NodeOperationError
from landflow_sdk.binary import base_mime_type, file_extension_of

MAX_FILE_BYTES = 20 * 1024 * 1024  # a text or table file bigger than this is refused (it is held in memory)
RESULT_FILE_NAME = "insights.csv"


def binary_source_properties(label: str, description: str, extra_show: dict[str, list[Any]] | None = None) -> list[dict[str, Any]]:
    """``fromBinary`` (boolean) + ``binaryPropertyName``: the option that makes a node read its input from a binary file."""
    return [
        {"name": "fromBinary", "displayName": label, "type": "boolean", "default": False, "description": description},
        {
            "name": "binaryPropertyName", "displayName": "Input Binary Field", "type": "string", "default": "data",
            "description": "Name of the binary property that holds the file (the file node's default is 'data')",
            "displayOptions": {"show": {"fromBinary": [True], **(extra_show or {})}},
        },
    ]


def result_file_properties(description: str) -> list[dict[str, Any]]:
    """``outputFile`` (boolean) + ``outputBinaryName``: the option that attaches a CSV of the analysis as a binary file."""
    return [
        {"name": "outputFile", "displayName": "Output Result File", "type": "boolean", "default": False, "description": description},
        {
            "name": "outputBinaryName", "displayName": "Output Binary Field", "type": "string", "default": "data",
            "description": "Binary property that receives the CSV file", "displayOptions": {"show": {"outputFile": [True]}},
        },
    ]


def flag(ctx: Any, name: str, i: int) -> bool:
    value = ctx.get_node_parameter(name, i, False)
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes", "on")
    return bool(value)


def read_bytes(ctx: Any, i: int) -> tuple[bytes, dict[str, Any], str]:
    """``(bytes, ref, property name)`` of input item ``i``'s binary file named by the ``binaryPropertyName`` parameter."""
    name = str(ctx.get_node_parameter("binaryPropertyName", i, "data") or "data").strip() or "data"
    ref = ctx.assert_binary_data(i, name)
    size = ref.get("fileSize")
    if isinstance(size, int) and size > MAX_FILE_BYTES:
        raise NodeOperationError(f"Binary file '{name}' is {size} bytes; the limit is {MAX_FILE_BYTES // (1024 * 1024)} MB", item_index=i)
    return ctx.get_binary_bytes(i, name), ref, name


def decode_text(raw: bytes) -> str:
    """UTF-8 (with or without a BOM), else UTF-16 when a BOM says so, else Latin-1 (never fails)."""
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        return raw.decode("utf-16", errors="replace")
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("latin-1")


def read_text(ctx: Any, i: int) -> str:
    """The text of input item ``i``'s binary file."""
    raw, _ref, _name = read_bytes(ctx, i)
    return decode_text(raw)


def _rows_from_json(text: str, ref: dict[str, Any], i: int) -> list[dict[str, Any]]:
    stripped = text.strip()
    try:
        value: Any = json.loads(stripped) if stripped else []
    except ValueError:
        lines = [line for line in stripped.splitlines() if line.strip()]  # NDJSON: one object per line
        try:
            value = [json.loads(line) for line in lines]
        except ValueError as exc:
            raise NodeOperationError(f"'{ref.get('fileName') or 'the file'}' is not valid JSON: {exc}", item_index=i) from None
    if isinstance(value, dict):  # {"data": [...]} / {"items": [...]} / {"rows": [...]}, else a single row
        value = next((value[k] for k in ("data", "items", "rows", "records", "results") if isinstance(value.get(k), list)), [value])
    if not isinstance(value, list):
        raise NodeOperationError("The JSON file must hold an array of objects", item_index=i)
    return [row if isinstance(row, dict) else {"value": row} for row in value]


def _rows_from_csv(text: str, ref: dict[str, Any], i: int) -> list[dict[str, Any]]:
    sample = text[:4096]
    if file_extension_of(ref.get("fileName")) == "tsv" or base_mime_type(ref.get("mimeType")) == "text/tab-separated-values":
        delimiter = "\t"
    else:
        try:
            delimiter = csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
        except csv.Error:
            delimiter = ","
    reader = csv.DictReader(io.StringIO(text, newline=""), delimiter=delimiter)
    return [{k: v for k, v in row.items() if k is not None} for row in reader]


def read_rows(ctx: Any, i: int) -> list[dict[str, Any]]:
    """Rows (dicts) of input item ``i``'s CSV / TSV / JSON / NDJSON file; the format follows the MIME type or extension, else the content."""
    raw, ref, _name = read_bytes(ctx, i)
    text = decode_text(raw)
    mime = base_mime_type(ref.get("mimeType"))
    extension = file_extension_of(ref.get("fileName"))
    if mime in ("application/json", "application/x-ndjson") or mime.endswith("+json") or extension in ("json", "ndjson"):
        return _rows_from_json(text, ref, i)
    if mime in ("text/csv", "text/tab-separated-values") or extension in ("csv", "tsv"):
        return _rows_from_csv(text, ref, i)
    return _rows_from_json(text, ref, i) if text.lstrip()[:1] in ("{", "[") else _rows_from_csv(text, ref, i)


def csv_bytes(header: list[str], rows: list[list[Any]]) -> bytes:
    """A CSV (UTF-8, ``\\r\\n`` line ends, quoted where needed); lists and dicts become JSON text."""
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer)
    writer.writerow(header)
    for row in rows:
        writer.writerow([json.dumps(cell, ensure_ascii=False) if isinstance(cell, (list, dict)) else ("" if cell is None else cell) for cell in row])
    return buffer.getvalue().encode("utf-8")


def attach_result_file(ctx: Any, out: list[dict[str, Any]], header: list[str], rows: list[list[Any]], file_name: str = RESULT_FILE_NAME) -> None:
    """When the ``outputFile`` option is on, store one CSV of the whole run and add it to every output item under ``outputBinaryName``."""
    if not out or not flag(ctx, "outputFile", 0):
        return
    name = str(ctx.get_node_parameter("outputBinaryName", 0, "data") or "data").strip() or "data"
    ref = ctx.prepare_binary_data(csv_bytes(header, rows), file_name, "text/csv")
    for item in out:
        item["binary"] = {**(item.get("binary") or {}), name: ref}
