"""``file:`` icon resolution and the plugin brand colour. Run:

    python3 -m unittest discover -s sdks/python/tests
"""

from __future__ import annotations

import base64
import importlib.util
import json
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from landflow_sdk import MAX_ICON_BYTES, DescriptorError, Node, Plugin, icon_file  # noqa: E402

try:
    from landflow_sdk import grpc_server
except Exception:  # noqa: BLE001 - grpc extra not installed
    grpc_server = None

SVG = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="24" r="20" fill="#f59e0b"/></svg>'
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 8


def _data_url(mime: str, data: bytes) -> str:
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def _node(icon: str | None, name: str = "pic") -> Node:
    class Pic(Node):
        description = {
            "name": name, "displayName": "Pic", "version": 1, "kind": "action",
            "inputs": [{"type": "main"}], "outputs": [{"type": "main"}], "properties": [],
            **({"icon": icon} if icon is not None else {}),
        }

        def execute(self, ctx):
            return []

    return Pic()


class IconTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls.dir = Path(cls._tmp.name)
        icons = cls.dir / "icons"
        icons.mkdir()
        (icons / "plugin.svg").write_bytes(SVG)
        (icons / "node.png").write_bytes(PNG)
        (icons / "big.svg").write_bytes(b"<svg>" + b" " * MAX_ICON_BYTES + b"</svg>")
        (icons / "fake.svg").write_bytes(b"not an svg")
        (icons / "icon.gif").write_bytes(b"GIF89a")

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_relative_to_the_declaring_module(self):
        # A plugin package elsewhere on disk: node and plugin icons resolve next to its own files.
        (self.dir / "iconpkg.py").write_text(textwrap.dedent("""
            from landflow_sdk import Node, Plugin

            class Pic(Node):
                description = {"name": "pic", "displayName": "Pic", "version": 1, "kind": "action",
                               "icon": "file:icons/node.png", "inputs": [], "outputs": [], "properties": []}

                def execute(self, ctx):
                    return []

            def build():
                return Plugin("icon-pkg", "Icons", "1.0.0", nodes=[Pic], icon="file:icons/plugin.svg", color="#f59e0b")
        """))
        spec = importlib.util.spec_from_file_location("iconpkg", self.dir / "iconpkg.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules["iconpkg"] = module
        try:
            spec.loader.exec_module(module)
            manifest = module.build().manifest()
        finally:
            del sys.modules["iconpkg"]
        self.assertEqual(manifest["plugin"]["icon"], _data_url("image/svg+xml", SVG))
        self.assertEqual(manifest["plugin"]["color"], "#f59e0b")
        self.assertEqual(manifest["nodes"][0]["icon"], _data_url("image/png", PNG))
        self.assertNotIn("file:", json.dumps(manifest))

    def test_icon_dir_absolute_paths_urls_and_passthrough(self):
        plugin = Plugin(
            "x", "X", "1",
            nodes=[_node("file:icons/node.png"), _node(f"file:{self.dir / 'icons' / 'plugin.svg'}", "abs"),
                   _node((self.dir / "icons" / "plugin.svg").as_uri(), "url"), _node("lucide:smile", "lucide")],
            icon="file:icons/plugin.svg", icon_dir=self.dir,
        )
        manifest = plugin.manifest()
        self.assertEqual(manifest["plugin"]["icon"], _data_url("image/svg+xml", SVG))
        self.assertNotIn("color", manifest["plugin"])
        self.assertEqual(
            [n["icon"] for n in manifest["nodes"]],
            [_data_url("image/png", PNG), _data_url("image/svg+xml", SVG), _data_url("image/svg+xml", SVG), "lucide:smile"],
        )
        self.assertEqual(icon_file(self.dir / "icons" / "node.png"), _data_url("image/png", PNG))

    def test_invalid_icons_fail_at_startup(self):
        cases = {
            "file:icons/missing.svg": "file not found",
            "file:icons/big.svg": "exceeds the 64 KB limit",
            "file:icons/fake.svg": "not a valid SVG",
            "file:icons/icon.gif": "only .svg and .png",
        }
        for icon, message in cases.items():
            with self.subTest(icon=icon), self.assertRaises(DescriptorError) as caught:
                Plugin("x", "X", "1", nodes=[_node(icon)], icon_dir=self.dir)
            self.assertIn("node 'pic'", str(caught.exception))
            self.assertIn(message, str(caught.exception))
        with self.assertRaisesRegex(DescriptorError, "plugin icon: .*file not found"):
            Plugin("x", "X", "1", nodes=[_node(None)], icon="file:nope.svg", icon_dir=self.dir)

    def test_color_must_be_hex(self):
        for color in ("#fa0", "#ffaa00", "#ffaa00cc"):
            self.assertEqual(Plugin("x", "X", "1", nodes=[_node(None)], color=color).manifest()["plugin"]["color"], color)
        with self.assertRaises(DescriptorError):
            Plugin("x", "X", "1", nodes=[_node(None)], color="orange")

    @unittest.skipIf(grpc_server is None, "grpc extra not installed")
    def test_grpc_manifest_carries_icon_and_color(self):
        plugin = Plugin("x", "X", "1", nodes=[_node(None)], icon="file:icons/plugin.svg", color="#f59e0b", icon_dir=self.dir)
        msg = grpc_server.manifest_to_proto(plugin.manifest())
        self.assertEqual((msg.plugin.icon, msg.plugin.color), (_data_url("image/svg+xml", SVG), "#f59e0b"))


if __name__ == "__main__":
    unittest.main()
