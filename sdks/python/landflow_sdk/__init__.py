"""Landflow plugin SDK for Python.

    from landflow_sdk import CredentialType, Node, Plugin, poll_interval_property, serve

App webhook triggers (``triggerSource: "appWebhook"``) get a ``WebhookContext``; ``landflow_sdk.signatures``
verifies GitHub, Stripe and Slack webhook signatures.

See README.md for a quickstart, docs/protocol.md for the wire protocol and
docs/observability.md for spans, metrics and logs. Transports are ``Binding``s
over one ``Dispatcher`` (``landflow_sdk.binding``, ``landflow_sdk.dispatcher``);
the gRPC one lives in ``landflow_sdk.grpc_server`` and needs the ``grpc`` extra;
OTLP export needs the ``otel`` extra. Nothing here imports grpcio or opentelemetry.
"""

from ._version import __version__
from .binary import MAX_INLINE_BINARY_BYTES, BinaryClient, file_type_of, mime_type_from_file_name
from .binding import Binding, BindingContext, BindingInfo, GrpcBinding, HttpBinding
from .context import CredentialTestContext, ExecuteContext, LoadOptionsContext, NodeLogger
from .credentials import CredentialType
from .dispatcher import CallCancelledError, CancelToken, Dispatcher, OverloadedError
from .errors import (
    DescriptorError,
    NodeOperationError,
    ProtocolError,
    UnknownCredentialTypeError,
    UnknownMethodError,
    UnknownNodeError,
)
from .http_client import HttpClient, HttpError, HttpResponse
from .icons import MAX_ICON_BYTES, icon_file
from .logs import LogFormatter, configure_logging
from .mcp import DEFAULT_MCP_PATH, LIST_OPTIONS_TOOL, McpBinding, McpFace, is_loopback_host, load_mcp_credentials, mcp_available, mcp_mode
from .mcp_tools import gateway_tool_name, mcp_tools_from_manifest, tool_call_to_parameters, without_binding
from .metrics import Metrics, MetricsRegistry
from .node import Node, poll_interval_property
from .plugin import SDK_NAME, Plugin
from .protocol import (
    DEFAULT_ANNOUNCE_TTL_SECONDS,
    DEFAULT_HEARTBEAT_SECONDS,
    HTTP_PATHS,
    PROTOCOL_VERSION,
)
from .registry_proof import registry_proof, verify_registry_proof
from .serve import PluginServer, serve
from .signatures import (
    DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
    github_signature,
    hmac_sha256,
    safe_equal,
    slack_signature,
    stripe_signature,
    verify_github_signature,
    verify_hmac_sha256,
    verify_slack_signature,
    verify_stripe_signature,
)
from .telemetry import Span, SpanContext, Telemetry, current_span
from .webhooks import WebhookContext

__all__ = [
    "BinaryClient",
    "Binding",
    "BindingContext",
    "BindingInfo",
    "CallCancelledError",
    "CancelToken",
    "CredentialTestContext",
    "CredentialType",
    "DEFAULT_ANNOUNCE_TTL_SECONDS",
    "DEFAULT_HEARTBEAT_SECONDS",
    "DEFAULT_SIGNATURE_TOLERANCE_SECONDS",
    "DescriptorError",
    "Dispatcher",
    "ExecuteContext",
    "GrpcBinding",
    "HTTP_PATHS",
    "HttpClient",
    "HttpBinding",
    "HttpError",
    "HttpResponse",
    "LoadOptionsContext",
    "LogFormatter",
    "MAX_ICON_BYTES",
    "MAX_INLINE_BINARY_BYTES",
    "Metrics",
    "MetricsRegistry",
    "Node",
    "NodeLogger",
    "NodeOperationError",
    "OverloadedError",
    "PROTOCOL_VERSION",
    "Plugin",
    "PluginServer",
    "ProtocolError",
    "SDK_NAME",
    "Span",
    "SpanContext",
    "Telemetry",
    "UnknownCredentialTypeError",
    "UnknownMethodError",
    "UnknownNodeError",
    "WebhookContext",
    "__version__",
    "configure_logging",
    "current_span",
    "file_type_of",
    "github_signature",
    "hmac_sha256",
    "icon_file",
    "mime_type_from_file_name",
    "poll_interval_property",
    "registry_proof",
    "safe_equal",
    "serve",
    "slack_signature",
    "stripe_signature",
    "verify_github_signature",
    "verify_hmac_sha256",
    "verify_registry_proof",
    "verify_slack_signature",
    "verify_stripe_signature",
]
