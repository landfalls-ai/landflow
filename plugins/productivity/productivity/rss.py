"""RSS Read and RSS Feed Trigger: RSS 2.0, RSS 1.0 (RDF) and Atom feeds, parsed safely with the standard library.

Feed content is untrusted: the XML is parsed with expat directly so DTD entity declarations
and external entities are refused (no entity expansion, no network or file access), the body
size is capped, and HTML is only ever stripped to text, never interpreted.
"""

from __future__ import annotations

import html
import re
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html.entities import name2codepoint
from html.parser import HTMLParser
from typing import Any
from urllib.parse import unquote, urlsplit
from xml.parsers import expat

from landflow_sdk import Node, NodeOperationError, poll_interval_property
from landflow_sdk.binary import extension_from_mime_type

from .common import collection, count_api_error, count_new_items, item_errors, items_of, out, split_list, text_param

MAX_FEED_BYTES = 10 * 1024 * 1024
DEFAULT_ENCLOSURE_MB = 25
SNIPPET_CHARS = 300
SEEN_KEEP = 200
SEEN_MAX = 1000
ACCEPT = "application/rss+xml, application/atom+xml, application/rdf+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5"

NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "atom03": "http://purl.org/atom/ns#",
    "content": "http://purl.org/rss/1.0/modules/content/",
    "dc": "http://purl.org/dc/elements/1.1/",
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "rss1": "http://purl.org/rss/1.0/",
    "rss09": "http://my.netscape.com/rdf/simple/0.9/",
    "media": "http://search.yahoo.com/mrss/",
    "itunes": "http://www.itunes.com/dtds/podcast-1.0.dtd",
    "slash": "http://purl.org/rss/1.0/modules/slash/",
    "wfw": "http://wellformedweb.org/CommentAPI/",
}
_XML_ENTITIES = {"amp", "lt", "gt", "quot", "apos"}
_ENTITY_RE = re.compile(r"&([A-Za-z][A-Za-z0-9]{1,31});")


class FeedError(ValueError):
    pass


# --------------------------------------------------------------------- XML


def _forbidden(*_args: Any) -> None:
    raise FeedError("the feed declares XML entities, which are refused for safety")


def parse_xml(data: bytes) -> tuple[ET.Element, dict[str, str]]:
    """Bytes -> (root element, prefix -> namespace URI declared in the document).

    Tags use ElementTree's ``{uri}local`` form. Entity declarations and external
    entity references raise ``FeedError``; HTML named entities (``&nbsp;``) that
    are not declared anywhere are decoded as characters.
    """
    retry = {expat.errors.codes[expat.errors.XML_ERROR_UNDEFINED_ENTITY], expat.errors.codes[expat.errors.XML_ERROR_UNKNOWN_ENCODING]}
    try:
        return _parse(data)
    except expat.ExpatError as exc:
        if exc.code not in retry:
            raise FeedError(f"not well-formed XML ({expat.errors.messages[exc.code]}, line {exc.lineno})") from None
    # an encoding expat lacks (windows-1252…) or undeclared HTML entities: decode in Python,
    # rewrite named entities as numeric references and parse the UTF-8 result
    fixed = _ENTITY_RE.sub(lambda m: m.group(0) if m.group(1) in _XML_ENTITIES or m.group(1) not in name2codepoint
                           else f"&#{name2codepoint[m.group(1)]};", _decode(data))
    fixed = re.sub(r"^\s*<\?xml[^>]*\?>", '<?xml version="1.0" encoding="utf-8"?>', fixed)
    try:
        return _parse(fixed.encode("utf-8"))
    except expat.ExpatError as exc:
        raise FeedError(f"not well-formed XML ({expat.errors.messages[exc.code]}, line {exc.lineno})") from None


def _decode(data: bytes) -> str:
    """Bytes -> text using the BOM or the XML declaration's encoding (UTF-8 when unknown)."""
    for bom, codec in ((b"\xef\xbb\xbf", "utf-8-sig"), (b"\xff\xfe", "utf-16"), (b"\xfe\xff", "utf-16")):
        if data.startswith(bom):
            return data.decode(codec, errors="replace")
    declared = re.match(rb"^\s*<\?xml[^>]*encoding=[\"']([A-Za-z0-9._-]+)[\"']", data)
    codec = declared.group(1).decode("ascii") if declared else "utf-8"
    try:
        return data.decode(codec, errors="replace")
    except LookupError:
        return data.decode("utf-8", errors="replace")


def _parse(data: bytes) -> tuple[ET.Element, dict[str, str]]:
    builder = ET.TreeBuilder()
    prefixes: dict[str, str] = {}
    parser = expat.ParserCreate(namespace_separator="}")
    parser.buffer_text = True
    parser.SetParamEntityParsing(expat.XML_PARAM_ENTITY_PARSING_NEVER)
    parser.EntityDeclHandler = _forbidden
    parser.UnparsedEntityDeclHandler = _forbidden
    parser.ExternalEntityRefHandler = _forbidden

    def name(raw: str) -> str:
        return "{" + raw if "}" in raw else raw

    def skipped(entity: str, is_parameter: bool) -> None:  # undeclared entity in a document with an external DTD
        if not is_parameter and entity in name2codepoint:
            builder.data(chr(name2codepoint[entity]))

    parser.StartElementHandler = lambda tag, attrs: builder.start(name(tag), {name(k): v for k, v in attrs.items()})
    parser.EndElementHandler = lambda tag: builder.end(name(tag))
    parser.CharacterDataHandler = builder.data
    parser.StartNamespaceDeclHandler = lambda prefix, uri: prefixes.setdefault(prefix or "", uri)
    parser.SkippedEntityHandler = skipped
    parser.Parse(data, True)
    return builder.close(), prefixes


def _local(tag: Any) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _ns(tag: Any) -> str:
    return tag[1:].split("}", 1)[0] if isinstance(tag, str) and tag.startswith("{") else ""


def _text(element: ET.Element | None) -> str | None:
    """Text of an element, including any markup inside it (Atom ``type="xhtml"``, unescaped HTML)."""
    if element is None:
        return None
    if len(element):
        copy = ET.fromstring(ET.tostring(element))
        for node in copy.iter():  # drop namespaces so the markup reads as plain (X)HTML
            node.tag = _local(node.tag)
        return ((copy.text or "") + "".join(ET.tostring(child, encoding="unicode") for child in copy)).strip()
    return (element.text or "").strip()


# -------------------------------------------------------------------- text


class _Stripper(HTMLParser):
    BLOCKS = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "section", "article"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        if tag in ("script", "style", "template"):
            self._skip += 1
        elif tag in self.BLOCKS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in ("script", "style", "template"):
            self._skip = max(0, self._skip - 1)
        elif tag in self.BLOCKS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self._skip:
            self.parts.append(data)


def strip_html(value: str | None) -> str:
    """HTML -> plain text (scripts and styles dropped, entities decoded, whitespace collapsed)."""
    if not value:
        return ""
    stripper = _Stripper()
    try:
        stripper.feed(value)
        stripper.close()
        text = "".join(stripper.parts)
    except Exception:  # noqa: BLE001 - malformed markup: fall back to a regex
        text = html.unescape(re.sub(r"<[^>]*>", " ", value))
    lines = (" ".join(line.split()) for line in text.splitlines())
    return "\n".join(line for line in lines if line).strip()


def snippet(value: str | None, limit: int = SNIPPET_CHARS) -> str:
    """``contentSnippet``: the text without HTML, cut at about ``limit`` characters on a word boundary."""
    text = strip_html(value)
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0].rstrip(",;:.-")
    return (cut or text[:limit]) + "…"


def iso_date(value: str | None) -> str | None:
    """RFC 822 (RSS) or ISO 8601 (Atom, dc:date) -> ``YYYY-MM-DDTHH:MM:SS.mmmZ`` (as JavaScript's toISOString)."""
    if not value:
        return None
    value = value.strip()
    parsed: datetime | None = None
    try:
        parsed = parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00").replace("z", "+00:00"))
        except ValueError:
            return None
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    parsed = parsed.astimezone(timezone.utc)
    return parsed.strftime("%Y-%m-%dT%H:%M:%S.") + f"{parsed.microsecond // 1000:03d}Z"


# ------------------------------------------------------------------- feeds


def parse_feed(data: bytes, custom_fields: list[str] | None = None) -> tuple[str, list[dict[str, Any]]]:
    """Bytes -> ``(format, items)`` with format ``rss`` / ``rdf`` / ``atom`` and rss-parser's item fields."""
    root, prefixes = parse_xml(data)
    kind = _local(root.tag).lower()
    if kind == "rss" or (kind == "channel" and not _ns(root.tag)):
        channel = root.find("channel") if kind == "rss" else root
        entries = [] if channel is None else channel.findall("item")
        fmt, items = "rss", [_rss_item(e) for e in entries]
    elif kind == "rdf":
        entries = [e for e in root if _local(e.tag) == "item"]
        fmt, items = "rdf", [_rss_item(e) for e in entries]
    elif kind == "feed":
        entries = [e for e in root if _local(e.tag) == "entry"]
        fmt, items = "atom", [_atom_item(e) for e in entries]
    else:
        raise FeedError(f"not an RSS or Atom feed (root element <{_local(root.tag)}>)")
    if custom_fields:
        namespaces = {**NS, **{k: v for k, v in prefixes.items() if k}}
        for item, entry in zip(items, entries):
            for field in custom_fields:
                value = _custom(entry, field, namespaces)
                if value is not None:
                    item[field] = value
    return fmt, items


def _child(entry: ET.Element, *names: str) -> ET.Element | None:
    """First child matching ``local`` (no namespace or the item's own) or ``prefix:local``."""
    for name in names:
        prefix, _, local = name.rpartition(":")
        for child in entry:
            if _local(child.tag) != local:
                continue
            if prefix and _ns(child.tag) != NS[prefix]:
                continue
            if not prefix and _ns(child.tag) not in ("", NS["rss1"], NS["rss09"], NS["atom"], NS["atom03"]):
                continue
            return child
    return None


def _children(entry: ET.Element, local: str, *namespaces: str) -> list[ET.Element]:
    return [c for c in entry if _local(c.tag) == local and _ns(c.tag) in namespaces]


def _rss_item(entry: ET.Element) -> dict[str, Any]:
    item: dict[str, Any] = {}
    for key, names in (("title", ("title",)), ("link", ("link",)), ("pubDate", ("pubDate", "dc:date")), ("author", ("author",)),
                       ("comments", ("comments",))):
        value = _text(_child(entry, *names))
        if value:
            item[key] = value
    creator = _text(_child(entry, "dc:creator"))
    if creator:
        item["creator"] = item["dc:creator"] = creator
    elif item.get("author"):
        item["creator"] = item["author"]
    if not item.get("link"):  # RSS 1.0: rdf:about holds the URL
        about = entry.get(f"{{{NS['rdf']}}}about")
        if about:
            item["link"] = about
    encoded = _text(_child(entry, "content:encoded"))
    description = _text(_child(entry, "description"))
    if encoded:
        item["content:encoded"] = encoded
        item["content:encodedSnippet"] = snippet(encoded)
    content = description if description else encoded
    if content:
        item["content"] = content
        item["contentSnippet"] = snippet(content)
    guid = _text(_child(entry, "guid"))
    if guid:
        item["guid"] = guid
    elif entry.get(f"{{{NS['rdf']}}}about"):
        item["guid"] = entry.get(f"{{{NS['rdf']}}}about")
    categories = [c for c in (_text(e) for e in _children(entry, "category", "") + _children(entry, "subject", NS["dc"])) if c]
    if categories:
        item["categories"] = categories
    enclosure = _child(entry, "enclosure")
    if enclosure is not None and enclosure.get("url"):
        item["enclosure"] = {k: enclosure.get(k) for k in ("url", "length", "type") if enclosure.get(k) is not None}
    item["isoDate"] = iso_date(item.get("pubDate"))
    if item["isoDate"] is None:
        del item["isoDate"]
    return item


def _atom_item(entry: ET.Element) -> dict[str, Any]:
    atom = (NS["atom"], NS["atom03"])
    item: dict[str, Any] = {}
    title = _text(_child(entry, "title"))
    if title:
        item["title"] = strip_html(title) if "<" in title else title
    links = _children(entry, "link", *atom)
    alternate = next((l for l in links if l.get("rel", "alternate") == "alternate" and l.get("href")), None)
    if alternate is None:
        alternate = next((l for l in links if l.get("href") and l.get("rel") not in ("enclosure", "self", "edit", "replies")), None)
    if alternate is not None:
        item["link"] = alternate.get("href")
    published = _text(_child(entry, "published", "issued")) or _text(_child(entry, "updated", "modified"))
    if published:
        item["pubDate"] = published
    author = _child(entry, "author")
    name = _text(_child(author, "name")) if author is not None else None
    if name:
        item["author"] = item["creator"] = name
    elif _text(_child(entry, "dc:creator")):
        item["creator"] = _text(_child(entry, "dc:creator"))
    content = _text(_child(entry, "content"))
    summary = _text(_child(entry, "summary"))
    if summary:
        item["summary"] = summary
    if content or summary:
        item["content"] = content or summary
        item["contentSnippet"] = snippet(content or summary)
    entry_id = _text(_child(entry, "id"))
    if entry_id:
        item["id"] = item["guid"] = entry_id
    categories = [c.get("term") or c.get("label") or (c.text or "").strip() for c in _children(entry, "category", *atom)]
    if any(categories):
        item["categories"] = [c for c in categories if c]
    enclosure = next((l for l in links if l.get("rel") == "enclosure" and l.get("href")), None)
    if enclosure is not None:
        item["enclosure"] = {"url": enclosure.get("href"), **{k: enclosure.get(k) for k in ("length", "type") if enclosure.get(k) is not None}}
    iso = iso_date(item.get("pubDate"))
    if iso:
        item["isoDate"] = iso
    return item


def _custom(entry: ET.Element, field: str, namespaces: dict[str, str]) -> Any:
    prefix, _, local = field.rpartition(":")
    uri = namespaces.get(prefix) if prefix else None
    if prefix and uri is None:
        return None
    matches = [c for c in entry if _local(c.tag) == local and (_ns(c.tag) == uri if prefix else True)]
    values = [(_text(m) if (m.text or "").strip() or len(m) else dict(m.attrib) or "") for m in matches]
    if not values:
        return None
    return values[0] if len(values) == 1 else values


# -------------------------------------------------------------------- fetch


def read_feed(ctx: Any, url: str, custom_fields: list[str] | None = None, item_index: int | None = None) -> list[dict[str, Any]]:
    """GET ``url`` with ``ctx.http`` (client span) and parse it inside an ``rss.parse`` span."""
    if not re.match(r"^https?://", url, re.IGNORECASE):
        raise NodeOperationError(f"Feed URL must start with http:// or https://, got {url!r}", item_index=item_index)
    try:
        resp = ctx.http.request("GET", url, headers={"Accept": ACCEPT}, timeout=30)
    except NodeOperationError as exc:
        count_api_error(ctx, "rss", None)
        raise NodeOperationError(f"Could not fetch the feed: {exc.message}", item_index=item_index) from None
    if resp.status >= 400:
        count_api_error(ctx, "rss", resp.status)
        raise NodeOperationError(f"Feed request failed (HTTP {resp.status}{' ' + resp.reason if resp.reason else ''})", item_index=item_index)
    if len(resp.content) > MAX_FEED_BYTES:
        raise NodeOperationError(f"The feed is larger than {MAX_FEED_BYTES // (1024 * 1024)} MB", item_index=item_index)
    with ctx.span("rss.parse", {"landflow.bytes": len(resp.content)}) as span:
        try:
            fmt, items = parse_feed(resp.content, custom_fields)
        except FeedError as exc:
            raise NodeOperationError(f"Could not parse the feed: {exc}", item_index=item_index) from None
        span.set_attributes({"rss.format": fmt, "landflow.items": len(items)})
    return items


def download_enclosure(ctx: Any, enclosure: dict[str, Any], max_bytes: int, item_index: int | None = None) -> tuple[bytes, str, str | None]:
    """GET an item's enclosure (podcast audio, an attached image or document) -> ``(bytes, file name, MIME type)``. No credentials are sent."""
    url = str(enclosure.get("url") or "")
    if not re.match(r"^https?://", url, re.IGNORECASE):
        raise NodeOperationError(f"Enclosure URL must start with http:// or https://, got {url!r}", item_index=item_index)
    declared = str(enclosure.get("length") or "")
    if declared.isdigit() and int(declared) > max_bytes:
        raise NodeOperationError(f"The enclosure is {declared} bytes; the limit is {max_bytes // (1024 * 1024)} MB", item_index=item_index)
    try:
        resp = ctx.http.request("GET", url, headers={"Accept": "*/*"}, timeout=120)
    except NodeOperationError as exc:
        count_api_error(ctx, "rss", None)
        raise NodeOperationError(f"Could not download the enclosure: {exc.message}", item_index=item_index) from None
    if resp.status >= 400:
        count_api_error(ctx, "rss", resp.status)
        raise NodeOperationError(f"Enclosure request failed (HTTP {resp.status}{' ' + resp.reason if resp.reason else ''})", item_index=item_index)
    if len(resp.content) > max_bytes:
        raise NodeOperationError(f"The enclosure is larger than {max_bytes // (1024 * 1024)} MB", item_index=item_index)
    mime = str(enclosure.get("type") or "").split(";")[0].strip() or resp.headers.get("Content-Type", "").split(";")[0].strip() or None
    name = unquote(urlsplit(url).path.rstrip("/").rsplit("/", 1)[-1]) or "enclosure"
    if "." not in name and extension_from_mime_type(mime):
        name = f"{name}.{extension_from_mime_type(mime)}"
    return resp.content, name, mime


# -------------------------------------------------------------------- nodes


class RssFeedRead(Node):
    description = {
        "name": "rssFeedRead",
        "displayName": "RSS Read",
        "description": "Read the items of an RSS 2.0, RSS 1.0 (RDF) or Atom feed, optionally downloading the enclosures as binary files",
        "version": 1,
        "kind": "action",
        "idempotent": True,  # only reads a feed
        "categories": ["Utility"],
        "icon": "file:icons/rss.svg",
        "color": "#F26522",
        "subtitle": "{{url}}",
        "documentationUrl": "https://www.rssboard.org/rss-specification",
        "inputs": [{"type": "main"}],
        "outputs": [{"type": "main"}],
        "usableAsTool": True,
        "toolDescription": (
            "Read an RSS or Atom feed. Pass the feed address in `url`. Returns one item per entry with `title`, `link`, "
            "`isoDate`, `creator`, `contentSnippet` (plain text) and `categories`. Use it to get the latest news or posts."
        ),
        "keywords": ["rss", "atom", "feed", "news", "blog", "podcast"],
        "properties": [
            {"name": "url", "displayName": "URL", "type": "string", "default": "", "required": True,
             "placeholder": "https://example.com/feed.xml", "description": "URL of the RSS or Atom feed"},
            {
                "name": "options", "displayName": "Options", "type": "collection", "default": {}, "placeholder": "Add option",
                "values": [
                    {"name": "customFields", "displayName": "Custom Fields", "type": "string", "default": "",
                     "placeholder": "media:thumbnail, itunes:duration",
                     "description": "Comma-separated extra elements to read from each item (prefix:name for namespaced ones)"},
                    {"name": "downloadEnclosures", "displayName": "Download Enclosures", "type": "boolean", "default": False,
                     "description": "Whether to download each item's enclosure (podcast audio, image, document) into a binary property of its item"},
                    {"name": "binaryPropertyName", "displayName": "Put Enclosure in Field", "type": "string", "default": "data",
                     "description": "Binary property that receives the enclosure (when Download Enclosures is on)"},
                    {"name": "maxEnclosureMb", "displayName": "Max Enclosure Size (MB)", "type": "number", "default": DEFAULT_ENCLOSURE_MB,
                     "typeOptions": {"minValue": 1}, "description": "An enclosure bigger than this is an error"},
                ],
            },
        ],
    }

    def execute(self, ctx):
        results = []
        for i, _item in enumerate(items_of(ctx)):
            with item_errors(ctx, results, i):
                url = text_param(ctx, "url", i, required=True, label="URL")
                options = collection(ctx, "options", i)
                custom = split_list(options.get("customFields"))
                entries = read_feed(ctx, url, custom, i)
                if str(options.get("downloadEnclosures")).lower() not in ("true", "1", "yes", "on"):
                    results.extend(out(entry, i) for entry in entries)
                    continue
                prop = str(options.get("binaryPropertyName") or "").strip() or "data"
                try:
                    max_bytes = max(1, int(float(options.get("maxEnclosureMb") or DEFAULT_ENCLOSURE_MB) * 1024 * 1024))
                except (TypeError, ValueError):
                    raise NodeOperationError("'Max Enclosure Size (MB)' must be a number", item_index=i) from None
                with ctx.span("rss.enclosures", {"landflow.items": len(entries)}):
                    for entry in entries:
                        item = out(entry, i)
                        if isinstance(entry.get("enclosure"), dict) and entry["enclosure"].get("url"):
                            content, name, mime = download_enclosure(ctx, entry["enclosure"], max_bytes, i)
                            item["binary"] = {prop: ctx.prepare_binary_data(content, name, mime)}
                        results.append(item)
        return results


def item_key(item: dict[str, Any]) -> str:
    """Identity for dedupe: guid, else link, else title + date."""
    return str(item.get("guid") or item.get("link") or f"{item.get('title', '')}|{item.get('pubDate', '')}")[:500]


def newest_first(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """By ``isoDate`` descending when every item has one; feed order (usually newest first) otherwise."""
    if items and all(item.get("isoDate") for item in items):
        return sorted(items, key=lambda item: item["isoDate"], reverse=True)
    return list(items)


class RssFeedReadTrigger(Node):
    description = {
        "name": "rssFeedReadTrigger",
        "displayName": "RSS Feed Trigger",
        "description": "Starts the workflow when an RSS or Atom feed publishes a new item (polling)",
        "version": 1,
        "kind": "trigger",
        "triggerSource": "poll",
        "categories": ["Utility"],
        "icon": "file:icons/rss.svg",
        "color": "#F26522",
        "subtitle": "{{feedUrl}}",
        "documentationUrl": "https://www.rssboard.org/rss-specification",
        "inputs": [],
        "outputs": [{"type": "main"}],
        "keywords": ["rss", "atom", "feed", "news", "poll"],
        "properties": [
            poll_interval_property(300),
            {"name": "feedUrl", "displayName": "Feed URL", "type": "string", "default": "", "required": True,
             "placeholder": "https://example.com/feed.xml", "description": "URL of the RSS or Atom feed"},
            {
                "name": "pollNotice", "type": "notice", "default": "",
                "displayName": "The first poll after activation only records what is in the feed. Executing the node in the editor returns the latest item.",
            },
        ],
    }

    def execute(self, ctx):
        url = text_param(ctx, "feedUrl", 0, required=True, label="Feed URL")
        items = read_feed(ctx, url)
        ordered = newest_first(items)
        if ctx.mode != "poll":  # editor run: the latest item, as n8n does; state untouched
            return [{"json": item} for item in ordered[:1]]

        current_keys = list(dict.fromkeys(item_key(item) for item in ordered))
        dates = [item["isoDate"] for item in items if item.get("isoDate")]
        state = ctx.get_poll_state()
        if state is None:  # first poll: baseline only
            ctx.set_poll_state({"lastIsoDate": max(dates, default=None), "seen": current_keys[:SEEN_MAX]})
            return []

        last = state.get("lastIsoDate")
        seen = set(state.get("seen") or [])
        fresh = [
            item for item in ordered
            if item_key(item) not in seen and (not last or not item.get("isoDate") or item["isoDate"] >= last)
        ]
        fresh.reverse()  # oldest first
        keep = max(SEEN_KEEP, len(current_keys))
        merged = list(dict.fromkeys(current_keys + [k for k in state.get("seen") or [] if isinstance(k, str)]))
        ctx.set_poll_state({"lastIsoDate": max([d for d in dates + [last] if d], default=None), "seen": merged[:min(keep, SEEN_MAX)]})
        count_new_items(ctx, "rss", len(fresh))
        if fresh:
            ctx.logger.info(f"{len(fresh)} new feed item(s)")
        return [{"json": item} for item in fresh]
