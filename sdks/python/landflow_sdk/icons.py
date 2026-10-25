"""``file:`` icons.

Plugin and node icons may be written n8n-style as ``"file:icons/stats.svg"``.
``Plugin`` inlines them as base64 ``data:`` URLs when it builds the manifest,
so they travel identically over HTTP and gRPC and the host never sees a path.
A relative path resolves against the directory of the Python file that
declares it (the node's module for node icons, the module calling
``Plugin(...)`` for the plugin icon) unless ``Plugin(icon_dir=...)`` is given.
"""

from __future__ import annotations

import base64
import os
import re
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from .errors import DescriptorError

#: Icons are inlined into every manifest, so keep them small.
MAX_ICON_BYTES = 64 * 1024

_MIME_TYPES = {".svg": "image/svg+xml", ".png": "image/png"}
_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_SVG_TAG = re.compile(rb"<svg[\s>]")


def icon_file(path: str | os.PathLike[str]) -> str:
    """Read an SVG/PNG (at most ``MAX_ICON_BYTES``) and return it as a base64 ``data:`` URL.

    >>> icon = icon_file(Path(__file__).parent / "icons" / "stats.svg")
    """
    path = Path(path)
    mime = _MIME_TYPES.get(path.suffix.lower())
    if mime is None:
        raise DescriptorError(f"icon {path}: only .svg and .png files are supported")
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        raise DescriptorError(f"icon {path}: file not found") from None
    except OSError as exc:
        raise DescriptorError(f"icon {path}: {exc.strerror or exc}") from None
    if len(data) > MAX_ICON_BYTES:
        raise DescriptorError(
            f"icon {path}: {len(data)} bytes exceeds the {MAX_ICON_BYTES // 1024} KB limit (icons are inlined into the manifest)"
        )
    valid = data.startswith(_PNG_SIGNATURE) if mime == "image/png" else _SVG_TAG.search(data) is not None
    if not valid:
        raise DescriptorError(f"icon {path}: content is not a valid {'PNG' if mime == 'image/png' else 'SVG'} file")
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def resolve_icon(icon: Any, base_dir: str | os.PathLike[str]) -> Any:
    """``file:<path>`` -> data: URL; any other value (lucide:, emoji:, https:, data:) is returned unchanged."""
    if not isinstance(icon, str) or not icon.startswith("file:"):
        return icon
    if icon.startswith("file://"):  # a real file URL
        path = Path(urllib.request.url2pathname(urllib.parse.urlparse(icon).path))
    else:  # n8n's relative form: "file:stats.svg", "file:icons/stats.svg"
        path = Path(icon[len("file:"):])
    if not path.is_absolute():
        path = Path(base_dir) / path
    return icon_file(path)
