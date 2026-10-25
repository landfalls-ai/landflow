"""Feed parsing (RSS 2.0, Atom, RDF, hostile XML), RSS Read and RSS Feed Trigger against a local feed server."""

from __future__ import annotations

import unittest
from pathlib import Path

from _support import FakeApi, LogCapture, execute, jsons, make_plugin, metric_value, paired

from productivity.rss import FeedError, iso_date, parse_feed, snippet, strip_html

FIXTURES = Path(__file__).resolve().parent / "fixtures"


def fixture(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def rss(items: list[tuple[str, str | None]]) -> str:
    """A minimal RSS 2.0 feed: ``(guid, RFC 822 date or None)`` per item, newest first."""
    entries = "".join(
        f"<item><title>Item {guid}</title><link>https://feed.test/{guid}</link><guid>{guid}</guid>"
        + (f"<pubDate>{date}</pubDate>" if date else "") + "</item>"
        for guid, date in items
    )
    return f'<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>{entries}</channel></rss>'


class ParseTests(unittest.TestCase):
    def test_rss2(self):
        fmt, items = parse_feed(fixture("rss2.xml"))
        self.assertEqual((fmt, len(items)), ("rss", 2))
        first = items[0]
        self.assertEqual(first["title"], "Polling triggers are here")
        self.assertEqual(first["link"], "https://blog.example.com/polling")
        self.assertEqual(first["pubDate"], "Sun, 25 Oct 2026 10:00:00 +0200")
        self.assertEqual(first["isoDate"], "2026-10-25T08:00:00.000Z")
        self.assertEqual((first["creator"], first["dc:creator"]), ("Ada Lovelace", "Ada Lovelace"))
        self.assertEqual(first["guid"], "post-2")
        self.assertEqual(first["categories"], ["release", "triggers"])
        self.assertEqual(first["content"], "<p>Polls <b>every</b> N seconds.</p><script>alert(1)</script>")
        self.assertEqual(first["contentSnippet"], "Polls every N seconds.")
        self.assertEqual(first["content:encoded"], "<h1>Polling</h1><p>Full &amp; complete text.</p>")
        self.assertEqual(first["content:encodedSnippet"], "Polling\nFull & complete text.")
        self.assertEqual(first["enclosure"], {"url": "https://cdn.example.com/ep2.mp3", "length": "12345", "type": "audio/mpeg"})
        self.assertEqual(first["comments"], "https://blog.example.com/polling#comments")
        second = items[1]
        self.assertEqual((second["title"], second["creator"], second["isoDate"]), ("Hello & welcome", "team@example.com (Team)", "2026-10-24T08:30:00.000Z"))
        self.assertNotIn("categories", second)

    def test_atom(self):
        fmt, items = parse_feed(fixture("atom.xml"))
        self.assertEqual((fmt, len(items)), ("atom", 2))
        one, two = items
        self.assertEqual(one["title"], "Atom entry one")
        self.assertEqual(one["link"], "https://atom.example.com/one")
        self.assertEqual(one["pubDate"], "2026-10-25T09:15:30.250+02:00")
        self.assertEqual(one["isoDate"], "2026-10-25T07:15:30.250Z")
        self.assertEqual((one["creator"], one["author"]), ("Grace Hopper", "Grace Hopper"))
        self.assertEqual((one["guid"], one["id"]), ("urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6a",) * 2)
        self.assertEqual(one["categories"], ["compilers", "history"])
        self.assertEqual(one["content"], "<div><p>Full <strong>xhtml</strong> body</p></div>")
        self.assertEqual(one["contentSnippet"], "Full xhtml body")
        self.assertEqual(one["summary"], "Short summary")
        self.assertEqual(one["enclosure"], {"url": "https://atom.example.com/one.mp4", "length": "999", "type": "video/mp4"})
        self.assertEqual((two["link"], two["pubDate"], two["isoDate"]), ("https://atom.example.com/two", "2026-10-24T08:00:00Z", "2026-10-24T08:00:00.000Z"))
        self.assertEqual((two["content"], two["contentSnippet"]), ("<p>Only a <i>summary</i></p>", "Only a summary"))

    def test_rdf(self):
        fmt, items = parse_feed(fixture("rdf.xml"))
        self.assertEqual((fmt, [i["title"] for i in items]), ("rdf", ["RDF item A", "RDF item B"]))
        a, b = items
        self.assertEqual((a["creator"], a["isoDate"], a["categories"], a["contentSnippet"]),
                         ("Alan Turing", "2026-10-23T07:00:00.000Z", ["computing"], "Description A"))
        self.assertEqual((b["link"], b["guid"], b["isoDate"]), ("https://rdf.example.com/b", "https://rdf.example.com/b", "2026-10-22T06:00:00.000Z"))

    def test_custom_fields(self):
        _, items = parse_feed(fixture("rss2.xml"), ["media:thumbnail", "comments", "atom:nothing", "unknown:x"])
        self.assertEqual(items[0]["media:thumbnail"], {"url": "https://cdn.example.com/ep2.jpg", "width": "120"})
        self.assertNotIn("atom:nothing", items[0])
        self.assertNotIn("unknown:x", items[0])

    def test_html_entities_and_legacy_encoding(self):
        _, items = parse_feed(rss([("a&nbsp;b", None)]).encode())
        self.assertEqual(items[0]["guid"], "a b")
        latin = '<?xml version="1.0" encoding="windows-1252"?><rss><channel><item><title>Caf\xe9 \x93quoted\x94</title></item></channel></rss>'
        _, items = parse_feed(latin.encode("latin-1"))
        self.assertEqual(items[0]["title"], "Café “quoted”")

    def test_hostile_xml_is_refused(self):
        laughs = b'<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><rss><channel><item><title>&lol2;</title></item></channel></rss>'
        xxe = b'<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss><channel><item><title>&x;</title></item></channel></rss>'
        param = b'<?xml version="1.0"?><!DOCTYPE r [<!ENTITY % p SYSTEM "http://127.0.0.1:9/evil.dtd"> %p;]><rss/>'
        for document in (laughs, xxe, param):
            with self.assertRaises(FeedError):
                parse_feed(document)
        with self.assertRaisesRegex(FeedError, "not well-formed"):
            parse_feed(b"<rss><channel>")
        with self.assertRaisesRegex(FeedError, "not an RSS or Atom feed"):
            parse_feed(b"<html><body>hi</body></html>")

    def test_external_dtd_is_not_fetched(self):
        doc = b'<?xml version="1.0"?><!DOCTYPE rss PUBLIC "-//Netscape Communications//DTD RSS 0.91//EN" "http://127.0.0.1:9/rss-0.91.dtd"><rss version="0.91"><channel><item><title>Old&nbsp;feed</title></item></channel></rss>'
        _, items = parse_feed(doc)
        self.assertEqual(items[0]["title"], "Old feed")

    def test_text_helpers(self):
        self.assertEqual(strip_html("<p>a<br>b</p><style>x{}</style><script>bad()</script> &amp; c"), "a\nb\n&amp; c".replace("&amp;", "&"))
        long = "<p>" + " ".join(["word"] * 200) + "</p>"
        cut = snippet(long)
        self.assertTrue(cut.endswith("…") and len(cut) <= 301, cut)
        self.assertEqual(iso_date("Mon, 26 Oct 2026 01:02:03 EST"), "2026-10-26T06:02:03.000Z")
        self.assertEqual(iso_date("2026-10-25"), "2026-10-25T00:00:00.000Z")
        self.assertIsNone(iso_date("yesterday"))


class RssNodeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.feed = FakeApi().__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.feed.__exit__()

    def setUp(self):
        self.feed.reset()
        self.plugin = make_plugin()
        self.feed.route("GET", "/rss2.xml", (200, fixture("rss2.xml"), {"Content-Type": "application/rss+xml"}))
        self.feed.route("GET", "/atom.xml", (200, fixture("atom.xml"), {"Content-Type": "application/atom+xml"}))

    def test_read_items_per_input(self):
        with LogCapture() as logs:
            response = execute(self.plugin, "rssFeedRead", {}, inputs=[{"json": {}}, {"json": {}}],
                               item_parameters=[{"url": f"{self.feed.url}/rss2.xml"}, {"url": f"{self.feed.url}/atom.xml", "options": {"customFields": "summary"}}])
        self.assertEqual([j["title"] for j in jsons(response)], ["Polling triggers are here", "Hello & welcome", "Atom entry one", "Atom entry two"])
        self.assertEqual(paired(response), [0, 0, 1, 1])
        self.assertIn("application/rss+xml", self.feed.requests[0]["headers"]["accept"])
        parse_spans = logs.spans("rss.parse")
        self.assertEqual([s["attributes"]["landflow.items"] for s in parse_spans], [2, 2])
        self.assertEqual([s["attributes"]["rss.format"] for s in parse_spans], ["rss", "atom"])
        execute_span = logs.spans("plugin.execute productivity.rssFeedRead")[0]
        self.assertEqual(parse_spans[0]["parent_span_id"], execute_span["span_id"])
        self.assertEqual(logs.spans("HTTP GET")[0]["parent_span_id"], execute_span["span_id"])

    def test_errors(self):
        self.feed.route("GET", "/gone.xml", (404, "<html>gone</html>", {"Content-Type": "text/html"}))
        self.feed.route("GET", "/page.html", (200, "<html><body>not a feed</body></html>", {"Content-Type": "text/html"}))
        gone = execute(self.plugin, "rssFeedRead", {"url": f"{self.feed.url}/gone.xml"})
        self.assertEqual(gone["error"]["message"], "Feed request failed (HTTP 404 Not Found)")
        page = execute(self.plugin, "rssFeedRead", {"url": f"{self.feed.url}/page.html"})
        self.assertEqual(page["error"]["message"], "Could not parse the feed: not an RSS or Atom feed (root element <html>)")
        bad = execute(self.plugin, "rssFeedRead", {"url": "file:///etc/passwd"})
        self.assertIn("must start with http:// or https://", bad["error"]["message"])
        self.assertEqual(metric_value(self.plugin, "landflow.productivity.api_errors", service="rss", status_class="4xx"), 1)


class RssTriggerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.feed = FakeApi().__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.feed.__exit__()

    def setUp(self):
        self.feed.reset()
        self.plugin = make_plugin()
        self.items = [("b", "Sat, 24 Oct 2026 10:00:00 GMT"), ("a", "Fri, 23 Oct 2026 10:00:00 GMT")]
        self.feed.route("GET", "/feed.xml", lambda r: (200, rss(self.items), {"Content-Type": "application/rss+xml"}))

    def poll(self, state=None, mode="poll"):
        return execute(self.plugin, "rssFeedReadTrigger", {"feedUrl": f"{self.feed.url}/feed.xml"}, mode=mode, poll_state=state)

    def test_manual_returns_the_latest_item_without_state(self):
        response = self.poll({"lastIsoDate": "2030-01-01T00:00:00.000Z", "seen": ["b"]}, mode="manual")
        self.assertEqual([j["guid"] for j in jsons(response)], ["b"])
        self.assertNotIn("pollState", response)

    def test_first_poll_baseline_then_new_items_oldest_first(self):
        first = self.poll()
        self.assertEqual(first["outputs"], [[]])
        self.assertEqual(first["pollState"], {"lastIsoDate": "2026-10-24T10:00:00.000Z", "seen": ["b", "a"]})
        self.items = [("d", "Sun, 25 Oct 2026 12:00:00 GMT"), ("c", "Sun, 25 Oct 2026 09:00:00 GMT")] + self.items
        second = self.poll(first["pollState"])
        self.assertEqual([j["guid"] for j in jsons(second)], ["c", "d"])
        self.assertEqual(second["pollState"], {"lastIsoDate": "2026-10-25T12:00:00.000Z", "seen": ["d", "c", "b", "a"]})
        self.assertEqual(metric_value(self.plugin, "landflow.productivity.poll.new_items", trigger="rss"), 2)
        third = self.poll(second["pollState"])
        self.assertEqual((third["outputs"], third["pollState"]), ([[]], second["pollState"]))

    def test_same_date_items_are_deduplicated_by_guid(self):
        state = self.poll()["pollState"]
        self.items = [("b2", "Sat, 24 Oct 2026 10:00:00 GMT")] + self.items  # same timestamp as "b"
        response = self.poll(state)
        self.assertEqual([j["guid"] for j in jsons(response)], ["b2"])
        self.assertEqual(jsons(self.poll(response["pollState"])), [])

    def test_older_unseen_items_are_ignored(self):
        state = self.poll()["pollState"]
        self.items = self.items + [("old", "Thu, 01 Oct 2026 10:00:00 GMT")]
        self.assertEqual(jsons(self.poll(state)), [])

    def test_items_without_dates(self):
        self.items = [("y", None), ("x", None)]
        state = self.poll()["pollState"]
        self.assertEqual(state, {"lastIsoDate": None, "seen": ["y", "x"]})
        self.items = [("z", None)] + self.items
        response = self.poll(state)
        self.assertEqual([j["guid"] for j in jsons(response)], ["z"])
        self.assertEqual(jsons(self.poll(response["pollState"])), [])

    def test_seen_list_is_capped(self):
        state = {"lastIsoDate": None, "seen": [f"old{n}" for n in range(500)]}
        self.items = [("new", None)]
        response = self.poll(state)
        self.assertEqual(len(response["pollState"]["seen"]), 200)
        self.assertEqual(response["pollState"]["seen"][:2], ["new", "old0"])

    def test_failed_fetch_keeps_state(self):
        self.feed.route("GET", "/feed.xml", (503, "down"))
        response = self.poll({"lastIsoDate": None, "seen": ["a"]})
        self.assertNotIn("pollState", response)
        self.assertEqual(response["error"]["message"], "Feed request failed (HTTP 503 Service Unavailable)")


if __name__ == "__main__":
    unittest.main()
