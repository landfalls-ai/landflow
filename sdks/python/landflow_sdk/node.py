"""The ``Node`` interface every Landflow node implements."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .context import ExecuteContext, LoadOptionsContext

POLL_INTERVAL_MIN_SECONDS = 10


class Node(ABC):
    """Base class for a node type.

    Subclasses provide:

    * ``description`` -- a dict following ``NodeDescriptor`` (class attribute or
      property). ``name`` is the *local* name; the host sees ``<pluginId>.<name>``.
    * ``execute(ctx)`` -- returns ``list[list[item]]`` (one list per main output)
      or a flat ``list[item]`` for a single output. An item is ``{"json": {...}}``;
      a bare dict is wrapped as ``{"json": dict}``.
    * ``load_options(method, parameters[, ctx])`` (optional) -- backs properties that
      set ``typeOptions.loadOptionsMethod``; returns ``[{name, value, description?}]``.
      Overrides that accept a third argument get a ``LoadOptionsContext``
      (credentials, logger, span, http, metrics).

    Credentials: declare ``"credentials": [{"name": "githubApi", "required": True}]``
    (types declared in ``Plugin(credential_types=...)``) and read them with
    ``ctx.get_credentials("githubApi")``.

    Polling triggers: ``"kind": "trigger"``, ``"triggerSource": "poll"`` and a
    ``poll_interval_property()``; use ``ctx.mode``, ``ctx.is_first_poll()``,
    ``ctx.get_poll_state()`` and ``ctx.set_poll_state(...)`` (docs/protocol.md §8).

    One instance serves concurrent requests from several threads, so keep
    per-execution state in local variables, not on ``self``.
    """

    @property
    @abstractmethod
    def description(self) -> dict[str, Any]:  # pragma: no cover - abstract
        """The NodeDescriptor dict."""

    @abstractmethod
    def execute(self, ctx: "ExecuteContext") -> list:  # pragma: no cover - abstract
        """Run the node over ``ctx.get_input_data()`` and return its outputs."""

    def load_options(
        self, method: str, parameters: dict[str, Any], ctx: "LoadOptionsContext | None" = None
    ) -> list[dict[str, Any]]:
        """Resolve a dynamic dropdown. Override and fall back to ``super()`` for unknown methods."""
        raise NotImplementedError(method)


def poll_interval_property(default_seconds: int = 60) -> dict[str, Any]:
    """The ``pollInterval`` number property a ``triggerSource: "poll"`` node declares (seconds, minimum 10)."""
    if isinstance(default_seconds, bool) or not isinstance(default_seconds, int) or default_seconds < POLL_INTERVAL_MIN_SECONDS:
        raise ValueError(f"poll interval default must be an int >= {POLL_INTERVAL_MIN_SECONDS} seconds")
    return {
        "name": "pollInterval",
        "displayName": "Poll Interval (seconds)",
        "type": "number",
        "default": default_seconds,
        "description": "How often to check for new events while the workflow is active",
        "typeOptions": {"minValue": POLL_INTERVAL_MIN_SECONDS},
        "noDataExpression": True,
    }
