from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class DynamicValue(_message.Message):
    __slots__ = ("json",)
    JSON_FIELD_NUMBER: _ClassVar[int]
    json: bytes
    def __init__(self, json: _Optional[bytes] = ...) -> None: ...

class PluginInfo(_message.Message):
    __slots__ = ("id", "name", "version", "description", "language", "sdk_name", "sdk_version", "icon", "author", "homepage", "color")
    ID_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    LANGUAGE_FIELD_NUMBER: _ClassVar[int]
    SDK_NAME_FIELD_NUMBER: _ClassVar[int]
    SDK_VERSION_FIELD_NUMBER: _ClassVar[int]
    ICON_FIELD_NUMBER: _ClassVar[int]
    AUTHOR_FIELD_NUMBER: _ClassVar[int]
    HOMEPAGE_FIELD_NUMBER: _ClassVar[int]
    COLOR_FIELD_NUMBER: _ClassVar[int]
    id: str
    name: str
    version: str
    description: str
    language: str
    sdk_name: str
    sdk_version: str
    icon: str
    author: str
    homepage: str
    color: str
    def __init__(self, id: _Optional[str] = ..., name: _Optional[str] = ..., version: _Optional[str] = ..., description: _Optional[str] = ..., language: _Optional[str] = ..., sdk_name: _Optional[str] = ..., sdk_version: _Optional[str] = ..., icon: _Optional[str] = ..., author: _Optional[str] = ..., homepage: _Optional[str] = ..., color: _Optional[str] = ...) -> None: ...

class GetManifestRequest(_message.Message):
    __slots__ = ("host_version",)
    HOST_VERSION_FIELD_NUMBER: _ClassVar[int]
    host_version: str
    def __init__(self, host_version: _Optional[str] = ...) -> None: ...

class GetManifestResponse(_message.Message):
    __slots__ = ("protocol", "plugin", "nodes", "credential_types", "transports", "max_concurrency")
    PROTOCOL_FIELD_NUMBER: _ClassVar[int]
    PLUGIN_FIELD_NUMBER: _ClassVar[int]
    NODES_FIELD_NUMBER: _ClassVar[int]
    CREDENTIAL_TYPES_FIELD_NUMBER: _ClassVar[int]
    TRANSPORTS_FIELD_NUMBER: _ClassVar[int]
    MAX_CONCURRENCY_FIELD_NUMBER: _ClassVar[int]
    protocol: str
    plugin: PluginInfo
    nodes: _containers.RepeatedCompositeFieldContainer[DynamicValue]
    credential_types: _containers.RepeatedCompositeFieldContainer[DynamicValue]
    transports: _containers.RepeatedScalarFieldContainer[str]
    max_concurrency: int
    def __init__(self, protocol: _Optional[str] = ..., plugin: _Optional[_Union[PluginInfo, _Mapping]] = ..., nodes: _Optional[_Iterable[_Union[DynamicValue, _Mapping]]] = ..., credential_types: _Optional[_Iterable[_Union[DynamicValue, _Mapping]]] = ..., transports: _Optional[_Iterable[str]] = ..., max_concurrency: _Optional[int] = ...) -> None: ...

class NodeRef(_message.Message):
    __slots__ = ("id", "name", "type", "type_version")
    ID_FIELD_NUMBER: _ClassVar[int]
    NAME_FIELD_NUMBER: _ClassVar[int]
    TYPE_FIELD_NUMBER: _ClassVar[int]
    TYPE_VERSION_FIELD_NUMBER: _ClassVar[int]
    id: str
    name: str
    type: str
    type_version: int
    def __init__(self, id: _Optional[str] = ..., name: _Optional[str] = ..., type: _Optional[str] = ..., type_version: _Optional[int] = ...) -> None: ...

class PairedItem(_message.Message):
    __slots__ = ("item", "input")
    ITEM_FIELD_NUMBER: _ClassVar[int]
    INPUT_FIELD_NUMBER: _ClassVar[int]
    item: int
    input: int
    def __init__(self, item: _Optional[int] = ..., input: _Optional[int] = ...) -> None: ...

class Item(_message.Message):
    __slots__ = ("json", "paired_item", "binary")
    JSON_FIELD_NUMBER: _ClassVar[int]
    PAIRED_ITEM_FIELD_NUMBER: _ClassVar[int]
    BINARY_FIELD_NUMBER: _ClassVar[int]
    json: DynamicValue
    paired_item: PairedItem
    binary: DynamicValue
    def __init__(self, json: _Optional[_Union[DynamicValue, _Mapping]] = ..., paired_item: _Optional[_Union[PairedItem, _Mapping]] = ..., binary: _Optional[_Union[DynamicValue, _Mapping]] = ...) -> None: ...

class BinaryAccess(_message.Message):
    __slots__ = ("url", "token")
    URL_FIELD_NUMBER: _ClassVar[int]
    TOKEN_FIELD_NUMBER: _ClassVar[int]
    url: str
    token: str
    def __init__(self, url: _Optional[str] = ..., token: _Optional[str] = ...) -> None: ...

class Branch(_message.Message):
    __slots__ = ("items",)
    ITEMS_FIELD_NUMBER: _ClassVar[int]
    items: _containers.RepeatedCompositeFieldContainer[Item]
    def __init__(self, items: _Optional[_Iterable[_Union[Item, _Mapping]]] = ...) -> None: ...

class ExecuteRequest(_message.Message):
    __slots__ = ("protocol", "execution_id", "workflow_id", "mode", "node", "parameters", "item_parameters", "inputs", "credentials", "poll_state", "continue_on_fail", "binary_access", "idempotency_key")
    PROTOCOL_FIELD_NUMBER: _ClassVar[int]
    EXECUTION_ID_FIELD_NUMBER: _ClassVar[int]
    WORKFLOW_ID_FIELD_NUMBER: _ClassVar[int]
    MODE_FIELD_NUMBER: _ClassVar[int]
    NODE_FIELD_NUMBER: _ClassVar[int]
    PARAMETERS_FIELD_NUMBER: _ClassVar[int]
    ITEM_PARAMETERS_FIELD_NUMBER: _ClassVar[int]
    INPUTS_FIELD_NUMBER: _ClassVar[int]
    CREDENTIALS_FIELD_NUMBER: _ClassVar[int]
    POLL_STATE_FIELD_NUMBER: _ClassVar[int]
    CONTINUE_ON_FAIL_FIELD_NUMBER: _ClassVar[int]
    BINARY_ACCESS_FIELD_NUMBER: _ClassVar[int]
    IDEMPOTENCY_KEY_FIELD_NUMBER: _ClassVar[int]
    protocol: str
    execution_id: str
    workflow_id: str
    mode: str
    node: NodeRef
    parameters: DynamicValue
    item_parameters: _containers.RepeatedCompositeFieldContainer[DynamicValue]
    inputs: _containers.RepeatedCompositeFieldContainer[Branch]
    credentials: DynamicValue
    poll_state: DynamicValue
    continue_on_fail: bool
    binary_access: BinaryAccess
    idempotency_key: str
    def __init__(self, protocol: _Optional[str] = ..., execution_id: _Optional[str] = ..., workflow_id: _Optional[str] = ..., mode: _Optional[str] = ..., node: _Optional[_Union[NodeRef, _Mapping]] = ..., parameters: _Optional[_Union[DynamicValue, _Mapping]] = ..., item_parameters: _Optional[_Iterable[_Union[DynamicValue, _Mapping]]] = ..., inputs: _Optional[_Iterable[_Union[Branch, _Mapping]]] = ..., credentials: _Optional[_Union[DynamicValue, _Mapping]] = ..., poll_state: _Optional[_Union[DynamicValue, _Mapping]] = ..., continue_on_fail: _Optional[bool] = ..., binary_access: _Optional[_Union[BinaryAccess, _Mapping]] = ..., idempotency_key: _Optional[str] = ...) -> None: ...

class LogEntry(_message.Message):
    __slots__ = ("level", "message")
    LEVEL_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    level: str
    message: str
    def __init__(self, level: _Optional[str] = ..., message: _Optional[str] = ...) -> None: ...

class NodeError(_message.Message):
    __slots__ = ("message", "description", "item_index")
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    DESCRIPTION_FIELD_NUMBER: _ClassVar[int]
    ITEM_INDEX_FIELD_NUMBER: _ClassVar[int]
    message: str
    description: str
    item_index: int
    def __init__(self, message: _Optional[str] = ..., description: _Optional[str] = ..., item_index: _Optional[int] = ...) -> None: ...

class ExecuteResponse(_message.Message):
    __slots__ = ("outputs", "logs", "error", "poll_state")
    OUTPUTS_FIELD_NUMBER: _ClassVar[int]
    LOGS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    POLL_STATE_FIELD_NUMBER: _ClassVar[int]
    outputs: _containers.RepeatedCompositeFieldContainer[Branch]
    logs: _containers.RepeatedCompositeFieldContainer[LogEntry]
    error: NodeError
    poll_state: DynamicValue
    def __init__(self, outputs: _Optional[_Iterable[_Union[Branch, _Mapping]]] = ..., logs: _Optional[_Iterable[_Union[LogEntry, _Mapping]]] = ..., error: _Optional[_Union[NodeError, _Mapping]] = ..., poll_state: _Optional[_Union[DynamicValue, _Mapping]] = ...) -> None: ...

class LoadOptionsRequest(_message.Message):
    __slots__ = ("node_type", "method", "parameters", "credentials")
    NODE_TYPE_FIELD_NUMBER: _ClassVar[int]
    METHOD_FIELD_NUMBER: _ClassVar[int]
    PARAMETERS_FIELD_NUMBER: _ClassVar[int]
    CREDENTIALS_FIELD_NUMBER: _ClassVar[int]
    node_type: str
    method: str
    parameters: DynamicValue
    credentials: DynamicValue
    def __init__(self, node_type: _Optional[str] = ..., method: _Optional[str] = ..., parameters: _Optional[_Union[DynamicValue, _Mapping]] = ..., credentials: _Optional[_Union[DynamicValue, _Mapping]] = ...) -> None: ...

class LoadOptionsResponse(_message.Message):
    __slots__ = ("options",)
    OPTIONS_FIELD_NUMBER: _ClassVar[int]
    options: DynamicValue
    def __init__(self, options: _Optional[_Union[DynamicValue, _Mapping]] = ...) -> None: ...

class TestCredentialsRequest(_message.Message):
    __slots__ = ("credential_type", "data")
    CREDENTIAL_TYPE_FIELD_NUMBER: _ClassVar[int]
    DATA_FIELD_NUMBER: _ClassVar[int]
    credential_type: str
    data: DynamicValue
    def __init__(self, credential_type: _Optional[str] = ..., data: _Optional[_Union[DynamicValue, _Mapping]] = ...) -> None: ...

class TestCredentialsResponse(_message.Message):
    __slots__ = ("ok", "message")
    OK_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    ok: bool
    message: str
    def __init__(self, ok: _Optional[bool] = ..., message: _Optional[str] = ...) -> None: ...

class WebhookMethodRequest(_message.Message):
    __slots__ = ("protocol", "method", "workflow_id", "node", "parameters", "credentials", "webhook_url", "static_data")
    PROTOCOL_FIELD_NUMBER: _ClassVar[int]
    METHOD_FIELD_NUMBER: _ClassVar[int]
    WORKFLOW_ID_FIELD_NUMBER: _ClassVar[int]
    NODE_FIELD_NUMBER: _ClassVar[int]
    PARAMETERS_FIELD_NUMBER: _ClassVar[int]
    CREDENTIALS_FIELD_NUMBER: _ClassVar[int]
    WEBHOOK_URL_FIELD_NUMBER: _ClassVar[int]
    STATIC_DATA_FIELD_NUMBER: _ClassVar[int]
    protocol: str
    method: str
    workflow_id: str
    node: NodeRef
    parameters: DynamicValue
    credentials: DynamicValue
    webhook_url: str
    static_data: DynamicValue
    def __init__(self, protocol: _Optional[str] = ..., method: _Optional[str] = ..., workflow_id: _Optional[str] = ..., node: _Optional[_Union[NodeRef, _Mapping]] = ..., parameters: _Optional[_Union[DynamicValue, _Mapping]] = ..., credentials: _Optional[_Union[DynamicValue, _Mapping]] = ..., webhook_url: _Optional[str] = ..., static_data: _Optional[_Union[DynamicValue, _Mapping]] = ...) -> None: ...

class WebhookMethodResponse(_message.Message):
    __slots__ = ("exists", "static_data", "logs", "error")
    EXISTS_FIELD_NUMBER: _ClassVar[int]
    STATIC_DATA_FIELD_NUMBER: _ClassVar[int]
    LOGS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    exists: bool
    static_data: DynamicValue
    logs: _containers.RepeatedCompositeFieldContainer[LogEntry]
    error: NodeError
    def __init__(self, exists: _Optional[bool] = ..., static_data: _Optional[_Union[DynamicValue, _Mapping]] = ..., logs: _Optional[_Iterable[_Union[LogEntry, _Mapping]]] = ..., error: _Optional[_Union[NodeError, _Mapping]] = ...) -> None: ...

class IncomingWebhookRequest(_message.Message):
    __slots__ = ("method", "path", "headers", "query", "body")
    class HeadersEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    class QueryEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    METHOD_FIELD_NUMBER: _ClassVar[int]
    PATH_FIELD_NUMBER: _ClassVar[int]
    HEADERS_FIELD_NUMBER: _ClassVar[int]
    QUERY_FIELD_NUMBER: _ClassVar[int]
    BODY_FIELD_NUMBER: _ClassVar[int]
    method: str
    path: str
    headers: _containers.ScalarMap[str, str]
    query: _containers.ScalarMap[str, str]
    body: bytes
    def __init__(self, method: _Optional[str] = ..., path: _Optional[str] = ..., headers: _Optional[_Mapping[str, str]] = ..., query: _Optional[_Mapping[str, str]] = ..., body: _Optional[bytes] = ...) -> None: ...

class ReceiveWebhookRequest(_message.Message):
    __slots__ = ("protocol", "workflow_id", "node", "parameters", "credentials", "webhook_url", "static_data", "request")
    PROTOCOL_FIELD_NUMBER: _ClassVar[int]
    WORKFLOW_ID_FIELD_NUMBER: _ClassVar[int]
    NODE_FIELD_NUMBER: _ClassVar[int]
    PARAMETERS_FIELD_NUMBER: _ClassVar[int]
    CREDENTIALS_FIELD_NUMBER: _ClassVar[int]
    WEBHOOK_URL_FIELD_NUMBER: _ClassVar[int]
    STATIC_DATA_FIELD_NUMBER: _ClassVar[int]
    REQUEST_FIELD_NUMBER: _ClassVar[int]
    protocol: str
    workflow_id: str
    node: NodeRef
    parameters: DynamicValue
    credentials: DynamicValue
    webhook_url: str
    static_data: DynamicValue
    request: IncomingWebhookRequest
    def __init__(self, protocol: _Optional[str] = ..., workflow_id: _Optional[str] = ..., node: _Optional[_Union[NodeRef, _Mapping]] = ..., parameters: _Optional[_Union[DynamicValue, _Mapping]] = ..., credentials: _Optional[_Union[DynamicValue, _Mapping]] = ..., webhook_url: _Optional[str] = ..., static_data: _Optional[_Union[DynamicValue, _Mapping]] = ..., request: _Optional[_Union[IncomingWebhookRequest, _Mapping]] = ...) -> None: ...

class WebhookReply(_message.Message):
    __slots__ = ("status", "headers", "body")
    class HeadersEntry(_message.Message):
        __slots__ = ("key", "value")
        KEY_FIELD_NUMBER: _ClassVar[int]
        VALUE_FIELD_NUMBER: _ClassVar[int]
        key: str
        value: str
        def __init__(self, key: _Optional[str] = ..., value: _Optional[str] = ...) -> None: ...
    STATUS_FIELD_NUMBER: _ClassVar[int]
    HEADERS_FIELD_NUMBER: _ClassVar[int]
    BODY_FIELD_NUMBER: _ClassVar[int]
    status: int
    headers: _containers.ScalarMap[str, str]
    body: bytes
    def __init__(self, status: _Optional[int] = ..., headers: _Optional[_Mapping[str, str]] = ..., body: _Optional[bytes] = ...) -> None: ...

class ReceiveWebhookResponse(_message.Message):
    __slots__ = ("items", "response", "static_data", "idempotency_key", "logs", "error")
    ITEMS_FIELD_NUMBER: _ClassVar[int]
    RESPONSE_FIELD_NUMBER: _ClassVar[int]
    STATIC_DATA_FIELD_NUMBER: _ClassVar[int]
    IDEMPOTENCY_KEY_FIELD_NUMBER: _ClassVar[int]
    LOGS_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    items: _containers.RepeatedCompositeFieldContainer[Item]
    response: WebhookReply
    static_data: DynamicValue
    idempotency_key: str
    logs: _containers.RepeatedCompositeFieldContainer[LogEntry]
    error: NodeError
    def __init__(self, items: _Optional[_Iterable[_Union[Item, _Mapping]]] = ..., response: _Optional[_Union[WebhookReply, _Mapping]] = ..., static_data: _Optional[_Union[DynamicValue, _Mapping]] = ..., idempotency_key: _Optional[str] = ..., logs: _Optional[_Iterable[_Union[LogEntry, _Mapping]]] = ..., error: _Optional[_Union[NodeError, _Mapping]] = ...) -> None: ...

class HealthRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class HealthResponse(_message.Message):
    __slots__ = ("status", "uptime_ms", "plugin_id", "version")
    STATUS_FIELD_NUMBER: _ClassVar[int]
    UPTIME_MS_FIELD_NUMBER: _ClassVar[int]
    PLUGIN_ID_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    status: str
    uptime_ms: int
    plugin_id: str
    version: str
    def __init__(self, status: _Optional[str] = ..., uptime_ms: _Optional[int] = ..., plugin_id: _Optional[str] = ..., version: _Optional[str] = ...) -> None: ...

class AnnounceRequest(_message.Message):
    __slots__ = ("protocol", "endpoint", "plugin_id", "version", "ttl_seconds", "instance_id")
    PROTOCOL_FIELD_NUMBER: _ClassVar[int]
    ENDPOINT_FIELD_NUMBER: _ClassVar[int]
    PLUGIN_ID_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    TTL_SECONDS_FIELD_NUMBER: _ClassVar[int]
    INSTANCE_ID_FIELD_NUMBER: _ClassVar[int]
    protocol: str
    endpoint: str
    plugin_id: str
    version: str
    ttl_seconds: int
    instance_id: str
    def __init__(self, protocol: _Optional[str] = ..., endpoint: _Optional[str] = ..., plugin_id: _Optional[str] = ..., version: _Optional[str] = ..., ttl_seconds: _Optional[int] = ..., instance_id: _Optional[str] = ...) -> None: ...

class AnnounceResponse(_message.Message):
    __slots__ = ("accepted", "heartbeat_interval_seconds", "message")
    ACCEPTED_FIELD_NUMBER: _ClassVar[int]
    HEARTBEAT_INTERVAL_SECONDS_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    accepted: bool
    heartbeat_interval_seconds: int
    message: str
    def __init__(self, accepted: _Optional[bool] = ..., heartbeat_interval_seconds: _Optional[int] = ..., message: _Optional[str] = ...) -> None: ...

class WithdrawRequest(_message.Message):
    __slots__ = ("endpoint", "plugin_id")
    ENDPOINT_FIELD_NUMBER: _ClassVar[int]
    PLUGIN_ID_FIELD_NUMBER: _ClassVar[int]
    endpoint: str
    plugin_id: str
    def __init__(self, endpoint: _Optional[str] = ..., plugin_id: _Optional[str] = ...) -> None: ...

class WithdrawResponse(_message.Message):
    __slots__ = ("ok",)
    OK_FIELD_NUMBER: _ClassVar[int]
    ok: bool
    def __init__(self, ok: _Optional[bool] = ...) -> None: ...
