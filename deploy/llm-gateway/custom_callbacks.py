"""
The gateway's split of each model call (docs/llm-gateway.md, "The gateway's split"): a LiteLLM callback that reads the
request after the response, counts its parts with the model's own tokenizer and posts only numbers and keyed hashes to
Landflow's POST /api/gateway-parts, under the gateway's response id (the spend log's `request_id`).

Mounted next to the config as /app/custom_callbacks.py and named in config.yaml (`litellm_settings.callbacks:
custom_callbacks.proxy_handler_instance`). Off unless LANDFLOW_PARTS_URL and LANDFLOW_PARTS_SECRET are both set.

Never text: prompt text lives in memory for the length of one callback; what is sent and what is logged are token counts,
hashes, the model's name and the request id. The callback never raises into LiteLLM and never delays a response (it runs
after it, and the counting and the post run on the callback's own small thread pool with a bounded queue: a slow Landflow
or Ollama can fill it, and then calls are dropped, never queued without limit).
"""

import concurrent.futures
import hashlib
import hmac
import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request

try:  # LiteLLM's own base class; tests that import this file without the image still see the module.
    from litellm.integrations.custom_logger import CustomLogger
except Exception:  # pragma: no cover

    class CustomLogger:  # type: ignore[no-redef]
        pass


log = logging.getLogger("landflow.parts")

PARTS = (
    "instructions",
    "projectBlock",
    "practices",
    "memory",
    "toolNote",
    "toolDefinitions",
    "history",
    "toolResults",
    "knowledge",
    "userMessage",
    "images",
    "formatting",
)
IMAGE_TOKENS = 1600
MAX_STRING = 200
HASH_KEY_PREFIX = b"landflow-parts-hash:"
# The weakest method wins for a call.
METHOD_ORDER = {"provider": 0, "tokenizer": 1, "estimate": 2}

# The qwen2 and llama-bpe (llama 3) pre-tokenizer patterns, as Hugging Face's tokenizers writes them.
PRE_PATTERNS = {
    "qwen2": r"(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+",
    "llama-bpe": r"(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+",
}


# ---------------------------------------------------------------------------------------------------------------------
# Hashes: exactly as apps/web/src/lib/server/ai-usage/parts.ts makes them, under a key derived from the shared secret.


def hash_key(secret):
    return hashlib.sha256(HASH_KEY_PREFIX + secret.encode("utf-8")).digest()


def digest(key, fields):
    mac = hmac.new(key, digestmod=hashlib.sha256)
    for field in fields:
        raw = field.encode("utf-8")
        mac.update(str(len(raw)).encode("ascii") + b":")
        mac.update(raw)
    return mac.hexdigest()[:16]


def hash_segments(segments, images, key, tool_names=()):
    """
    `segments`: [{where, part, text, breakpoint?}] in prompt order (tools, system, messages). Returns the contract's
    prefixHash, promptHash and partHashes (none for `formatting`, `images` or an empty part).
    """

    def fields(s):
        return [s["where"], s["part"], s["text"]]

    last_break = -1
    for i, s in enumerate(segments):
        if s.get("breakpoint"):
            last_break = i
    prefix = segments[: last_break + 1] if last_break >= 0 else [s for s in segments if s["where"] != "messages"]
    by_part = {}
    for s in segments:
        if s["part"] in ("formatting", "images") or not s["text"]:
            continue
        by_part.setdefault(s["part"], []).append(s["text"])
    part_hashes = {part: digest(key, ["".join(by_part[part])]) for part in PARTS if part in by_part}
    out = {
        "prefixHash": digest(key, [f for s in prefix for f in fields(s)]),
        "promptHash": digest(key, [f for s in segments for f in fields(s)] + ["images:%d" % images]),
        "partHashes": part_hashes,
    }
    names = [n for n in tool_names if isinstance(n, str) and 0 < len(n) <= MAX_STRING]
    if names:
        out["toolNames"] = names[:200]
    return out


def sign(secret, body, now=None):
    t = str(int(time.time() if now is None else now))
    mac = hmac.new(secret.encode("utf-8"), t.encode("ascii") + b"." + body, hashlib.sha256).hexdigest()
    return "t=%s,v1=%s" % (t, mac)


# ---------------------------------------------------------------------------------------------------------------------
# Splitting a request into the contract's parts (OpenAI-shaped and Anthropic-shaped requests).


def _as_dict(value):
    if isinstance(value, dict):
        return value
    for name in ("model_dump", "dict"):
        fn = getattr(value, name, None)
        if callable(fn):
            try:
                out = fn()
                if isinstance(out, dict):
                    return out
            except Exception:
                pass
    return {}


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _has_cache_control(value):
    return isinstance(value, dict) and bool(value.get("cache_control"))


def _block_text(block):
    """The text a content block puts in the prompt: text itself, else its compact JSON (tool calls, results)."""
    if isinstance(block, str):
        return block
    if not isinstance(block, dict):
        return ""
    kind = block.get("type")
    if kind == "text":
        return block.get("text") or ""
    if kind == "tool_result":
        content = block.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return "".join(_block_text(b) for b in content)
        return ""
    if kind == "tool_use":
        return _json({"name": block.get("name"), "input": block.get("input")})
    if kind in ("thinking", "redacted_thinking"):
        return block.get("thinking") or ""
    return ""


def _is_image(block):
    return isinstance(block, dict) and block.get("type") in ("image", "image_url", "input_image")


def split_request(kwargs):
    """
    Returns (segments, images, tool_names). A segment is {where, part, text, breakpoint}. System becomes `instructions`,
    tool definitions `toolDefinitions`, the last user message `userMessage`, tool results `toolResults` and every
    other earlier turn `history`.
    """
    optional = kwargs.get("optional_params") if isinstance(kwargs.get("optional_params"), dict) else {}
    params = kwargs.get("litellm_params") if isinstance(kwargs.get("litellm_params"), dict) else {}
    segments, names, images = [], [], 0

    tools = kwargs.get("tools") or optional.get("tools") or []
    for tool in tools if isinstance(tools, list) else []:
        if not isinstance(tool, dict):
            continue
        fn = tool.get("function") if isinstance(tool.get("function"), dict) else tool
        if isinstance(fn.get("name"), str):
            names.append(fn["name"])
        segments.append({"where": "tools", "part": "toolDefinitions", "text": _json(tool), "breakpoint": _has_cache_control(tool)})

    messages = kwargs.get("messages")
    if not isinstance(messages, list):
        messages = []
    system = kwargs.get("system") or optional.get("system") or params.get("system")
    if isinstance(system, str) and system:
        segments.append({"where": "system", "part": "instructions", "text": system, "breakpoint": False})
    elif isinstance(system, list):
        for block in system:
            segments.append({"where": "system", "part": "instructions", "text": _block_text(block), "breakpoint": _has_cache_control(block)})
    # A /v1/messages request routed to a non-Anthropic model is translated by LiteLLM: its system prompt is then only in
    # `kwargs["input"]` (the translated messages), not in `system` nor in `messages`. Read it from there, and only when
    # nothing else carried one, so the native Anthropic path (where `system` is set) never counts it twice.
    has_system = bool(system) or any(isinstance(m, dict) and m.get("role") in ("system", "developer") for m in messages)
    if not has_system and isinstance(kwargs.get("input"), list):
        leading = []
        for message in kwargs["input"]:
            if isinstance(message, dict) and message.get("role") in ("system", "developer"):
                leading.append(message)
            else:
                break
        messages = leading + messages
    body = []
    for message in messages:
        if isinstance(message, dict) and message.get("role") in ("system", "developer"):
            content = message.get("content")
            blocks = content if isinstance(content, list) else [content or ""]
            for block in blocks:
                segments.append({"where": "system", "part": "instructions", "text": _block_text(block), "breakpoint": _has_cache_control(block) or _has_cache_control(message)})
        else:
            body.append(message)

    last = len(body) - 1
    for index, message in enumerate(body):
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        content = message.get("content")
        blocks = content if isinstance(content, list) else ([content] if isinstance(content, str) and content else [])
        is_last_user = index == last and role == "user"
        if role == "tool":
            segments.append({"where": "messages", "part": "toolResults", "text": "".join(_block_text(b) for b in blocks), "breakpoint": False})
            continue
        for block in blocks:
            if _is_image(block):
                images += 1
                continue
            text = _block_text(block)
            if isinstance(block, dict) and block.get("type") == "tool_result":
                part = "toolResults"
            elif is_last_user:
                part = "userMessage"
            else:
                part = "history"
            segments.append({"where": "messages", "part": part, "text": text, "breakpoint": False})
        # OpenAI assistant tool calls ride in `tool_calls`, not in content.
        calls = message.get("tool_calls")
        if isinstance(calls, list) and calls:
            segments.append({"where": "messages", "part": "history", "text": _json(calls), "breakpoint": False})
    return segments, images, names


def part_texts(segments):
    texts = {}
    for s in segments:
        if s["part"] in ("formatting", "images") or not s["text"]:
            continue
        texts[s["part"]] = texts.get(s["part"], "") + s["text"]
    return texts


# ---------------------------------------------------------------------------------------------------------------------
# Counting.


def strip_base(base, suffixes):
    """LiteLLM logs `litellm_params.api_base` as the full request URL (`.../api/chat`, `.../v1/messages`): the provider's
    root is that URL less its path."""
    base = (base or "").strip().rstrip("/")
    for suffix in suffixes:
        if base.endswith(suffix):
            return base[: -len(suffix)].rstrip("/")
    return base


OLLAMA_PATHS = ("/api/chat", "/api/generate", "/api/show")
ANTHROPIC_PATHS = ("/v1/messages/count_tokens", "/v1/messages")
RETRY_AFTER = 300  # seconds a failed counter load is remembered


def estimate_tokens(text):
    return (len(text) + 3) // 4


class BpeCounter:
    """An Ollama model's vocabulary (from /api/show) as a byte-level BPE with the qwen2 or llama-bpe pre-tokenizer."""

    def __init__(self, tokens, merges, pre):
        from tokenizers import Regex, Tokenizer, pre_tokenizers
        from tokenizers.models import BPE

        if pre not in PRE_PATTERNS:
            raise ValueError("pre-tokenizer not supported")
        vocab = {token: i for i, token in enumerate(tokens)}
        pairs = []
        for merge in merges:
            a, b = (merge.split(" ", 1) + [""])[:2] if isinstance(merge, str) else merge
            pairs.append((a, b))
        tokenizer = Tokenizer(BPE(vocab, pairs))
        tokenizer.pre_tokenizer = pre_tokenizers.Sequence(
            [pre_tokenizers.Split(Regex(PRE_PATTERNS[pre]), "isolated", False), pre_tokenizers.ByteLevel(add_prefix_space=False, use_regex=False)]
        )
        self.tokenizer = tokenizer

    def count(self, text):
        return len(self.tokenizer.encode(text, add_special_tokens=False).ids) if text else 0


def bpe_from_show(info):
    """A BpeCounter from Ollama's `/api/show` answer, or None when the model's tokenizer is not one we support."""
    model_info = info.get("model_info") if isinstance(info, dict) else None
    if not isinstance(model_info, dict):
        return None
    tokens = model_info.get("tokenizer.ggml.tokens")
    merges = model_info.get("tokenizer.ggml.merges")
    pre = model_info.get("tokenizer.ggml.pre")
    if not tokens or not merges or pre not in PRE_PATTERNS:
        return None
    return BpeCounter(tokens, merges, pre)


class TiktokenCounter:
    def __init__(self, name):
        # Offline, tiktoken finds only the encodings LiteLLM bundles, through this directory.
        if "TIKTOKEN_CACHE_DIR" not in os.environ:
            try:
                import litellm.litellm_core_utils.tokenizers as bundled

                os.environ.setdefault("TIKTOKEN_CACHE_DIR", os.path.dirname(bundled.__file__))
            except Exception:
                pass
        import tiktoken

        self.encoding = tiktoken.get_encoding(name)

    def count(self, text):
        return len(self.encoding.encode(text, disallowed_special=())) if text else 0


def openai_encoding(model):
    name = (model or "").lower().split("/")[-1]
    if name.startswith(("gpt-4o", "gpt-4.1", "gpt-5", "o1", "o3", "o4", "chatgpt-4o")):
        return "o200k_base"
    return "cl100k_base"


# ---------------------------------------------------------------------------------------------------------------------
# The request body: the contract's keys only.


def balance(counts, input_tokens):
    """Counted parts, never above the reported input: scaled down if over, with `formatting` the remainder otherwise."""
    counts = {part: int(n) for part, n in counts.items() if n and n > 0}
    total = sum(counts.values())
    if total > input_tokens:
        if input_tokens <= 0:
            return {}
        scaled = {part: n * input_tokens // total for part, n in counts.items()}
        rest = input_tokens - sum(scaled.values())
        if rest > 0 and scaled:
            largest = max(scaled, key=lambda p: counts[p])
            scaled[largest] += rest
        return {part: n for part, n in scaled.items() if n > 0}
    if input_tokens > total:
        counts["formatting"] = input_tokens - total
    return counts


def _iso(moment):
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(moment)) + ".%03dZ" % int((moment % 1) * 1000)


def build_body(request_id, model, provider, method, input_tokens, counts, hashes, at=None):
    body = {
        "requestId": request_id[:MAX_STRING],
        "at": _iso(time.time() if at is None else at),
        "model": (model or "unknown")[:MAX_STRING],
        "provider": (provider or "unknown")[:MAX_STRING],
        "method": method,
        "inputTokens": int(input_tokens),
        "parts": balance(counts, int(input_tokens)),
        "prefixHash": hashes["prefixHash"],
        "promptHash": hashes["promptHash"],
        "partHashes": hashes["partHashes"],
    }
    if hashes.get("toolNames"):
        body["toolNames"] = hashes["toolNames"]
    return body


# ---------------------------------------------------------------------------------------------------------------------
# The callback.


def _spend_id(kwargs, response_obj):
    """LiteLLM's own request id for the spend log row (called, not copied)."""
    from litellm.proxy.spend_tracking.spend_tracking_utils import get_spend_logs_id

    call_type = kwargs.get("call_type") or "acompletion"
    # The same metadata LiteLLM's own get_logging_payload passes (a background-cost row's id gets a suffix from it).
    try:
        from litellm.litellm_core_utils.core_helpers import get_litellm_metadata_from_kwargs

        metadata = get_litellm_metadata_from_kwargs(kwargs)
    except Exception:
        return get_spend_logs_id(call_type, _as_dict(response_obj) or response_obj, kwargs)
    return get_spend_logs_id(call_type, _as_dict(response_obj) or response_obj, kwargs, metadata)


def _reported_input(kwargs, response_obj):
    usage = _as_dict(response_obj).get("usage")
    usage = _as_dict(usage) if usage is not None else {}
    value = usage.get("prompt_tokens")
    if value is None:
        value = usage.get("input_tokens")
    if value is None:
        standard = kwargs.get("standard_logging_object")
        value = standard.get("prompt_tokens") if isinstance(standard, dict) else None
    return int(value) if isinstance(value, (int, float)) and value > 0 else 0


class LandflowParts(CustomLogger):
    def __init__(self, url=None, secret=None, post=None, sleep=time.sleep, show=None, anthropic_count=None):
        try:
            super().__init__()
        except Exception:
            pass
        self.url = url
        self.secret = secret
        self._post = post or self._http_post
        self._sleep = sleep
        self._show = show or self._ollama_show
        self._anthropic_count = anthropic_count or self._anthropic_count_http
        self._counters = {}
        self._stubs = {}
        self._lock = threading.Lock()
        self._warned = set()
        self._pool = None
        self._pending = 0
        self._idle = threading.Condition()
        self.max_pending = 64

    # Configuration is read when a call finishes, so a test (or a restart-free env change) takes effect.
    def _settings(self):
        url = self.url or os.environ.get("LANDFLOW_PARTS_URL")
        secret = self.secret or os.environ.get("LANDFLOW_PARTS_SECRET")
        return (url, secret) if url and secret else (None, None)

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        try:
            url, secret = self._settings()
            if not url or not isinstance(kwargs, dict) or kwargs.get("cache_hit"):
                return
            standard = kwargs.get("standard_logging_object")
            if isinstance(standard, dict) and standard.get("cache_hit"):
                return
            request_id = _spend_id(kwargs, response_obj)
            if not request_id:
                return
            segments, images, names = split_request(kwargs)
            if not segments and not images:
                return
            input_tokens = _reported_input(kwargs, response_obj)
            if input_tokens <= 0:
                return
            self._submit(url, secret, kwargs, request_id, segments, images, names, input_tokens)
        except Exception as error:
            self._warn_once("skip:" + type(error).__name__, "landflow parts: skipped a call (%s)" % type(error).__name__)

    def _warn_once(self, key, message):
        with self._lock:
            if key in self._warned:
                return
            self._warned.add(key)
        log.warning(message)

    def _submit(self, *args):
        """Hands the work to the callback's own pool (not LiteLLM's default executor); drops it when the queue is full."""
        with self._idle:
            if self._pending >= self.max_pending:
                full = True
            else:
                full = False
                self._pending += 1
        if full:
            self._warn_once("full", "landflow parts: queue full, dropping splits until it drains")
            return
        try:
            if self._pool is None:
                with self._lock:
                    if self._pool is None:
                        self._pool = concurrent.futures.ThreadPoolExecutor(max_workers=4, thread_name_prefix="landflow-parts")
            self._pool.submit(self._run, *args)
        except Exception:
            self._done()

    def _done(self):
        with self._idle:
            self._pending -= 1
            self._idle.notify_all()

    def _run(self, *args):
        try:
            self._count_and_send(*args)
        finally:
            self._done()

    def wait_idle(self, timeout=10):
        """Blocks until every queued split has been sent or dropped (tests, shutdown)."""
        with self._idle:
            return self._idle.wait_for(lambda: self._pending == 0, timeout)

    def _count_and_send(self, url, secret, kwargs, request_id, segments, images, names, input_tokens):
        try:
            model, provider = self._model_of(kwargs)
            texts = part_texts(segments)
            counts, method = self._count(kwargs, model, provider, texts, images)
            hashes = hash_segments(segments, images, hash_key(secret), names)
            body = build_body(request_id, model, provider, method, input_tokens, counts, hashes)
            self.send(url, secret, body)
        except Exception as error:
            self._warn_once("split:" + type(error).__name__, "landflow parts: could not split a call (%s)" % type(error).__name__)

    def _model_of(self, kwargs):
        params = kwargs.get("litellm_params") if isinstance(kwargs.get("litellm_params"), dict) else {}
        provider = params.get("custom_llm_provider") or kwargs.get("custom_llm_provider") or ""
        model = kwargs.get("model") or ""
        if "/" in model and not provider:
            provider, model = model.split("/", 1)
        elif provider and model.startswith(provider + "/"):
            model = model[len(provider) + 1 :]
        return model, provider

    def _count(self, kwargs, model, provider, texts, images):
        """({part: tokens}, method). Falls back to an estimate for the whole call when the model's counter is missing."""
        params = kwargs.get("litellm_params") if isinstance(kwargs.get("litellm_params"), dict) else {}
        counter = None
        method = "estimate"
        try:
            if provider.startswith("ollama"):
                counter = self._ollama_counter(params.get("api_base"), model)
                method = "tokenizer"
            elif provider in ("openai", "azure", "text-completion-openai"):
                counter = self._cached("tiktoken:" + openai_encoding(model), lambda: TiktokenCounter(openai_encoding(model)))
                method = "tokenizer"
            elif provider == "anthropic":
                counted = self._anthropic_counts(params, model, texts)
                if counted is not None:
                    if images:
                        counted["images"] = images * IMAGE_TOKENS
                    # The count endpoint is asked for each part as user-message text, so tool definitions (which it
                    # would count in its own `tools` format) are only approximate: the call is then an estimate.
                    exact = not images and "toolDefinitions" not in texts
                    return counted, "provider" if exact else "estimate"
        except Exception as error:
            self._warn_once("count:%s:%s" % (provider, type(error).__name__), "landflow parts: no counter for %s (%s)" % (provider or "unknown", type(error).__name__))
            counter = None
        if counter is None:
            counts = {part: estimate_tokens(text) for part, text in texts.items()}
            method = "estimate"
        else:
            counts = {part: counter.count(text) for part, text in texts.items()}
        if images:
            counts["images"] = images * IMAGE_TOKENS
            method = "estimate"
        return counts, method

    def _cached(self, key, make):
        """A loaded counter by key. A failed load is remembered (for RETRY_AFTER seconds) so a broken model is not asked for
        again on every call; the first failure raises (and is warned once), later ones answer None."""
        now = time.time()
        with self._lock:
            entry = self._counters.get(key)
            if entry is not None and (entry[0] is not None or entry[1] > now):
                return entry[0]
        try:
            counter = make()
        except Exception:
            with self._lock:
                self._counters[key] = (None, now + RETRY_AFTER)
            raise
        with self._lock:
            self._counters[key] = (counter, 0)
        return counter

    def _ollama_counter(self, api_base, model):
        base = strip_base(api_base or os.environ.get("OLLAMA_API_BASE") or "http://host.docker.internal:11434", OLLAMA_PATHS)
        return self._cached("ollama:%s:%s" % (base, model), lambda: self._load_ollama(base, model))

    def _load_ollama(self, base, model):
        counter = bpe_from_show(self._show(base, model))
        if counter is None:
            raise ValueError("model tokenizer not supported")
        return counter

    @staticmethod
    def _ollama_show(base, model):
        request = urllib.request.Request(base + "/api/show", data=json.dumps({"model": model, "verbose": True}).encode("utf-8"), headers={"content-type": "application/json"}, method="POST")
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read())

    def _anthropic_counts(self, params, model, texts):
        key = params.get("api_key") or os.environ.get("ANTHROPIC_API_KEY")
        if not key:
            return None
        base = strip_base(params.get("api_base") or os.environ.get("ANTHROPIC_API_BASE") or "https://api.anthropic.com", ANTHROPIC_PATHS)
        # One request per part: the part alone as a user message, less the count of the stub message every request needs
        # (asked once per model; a failure is remembered for a while).
        stub = self._cached("anthropic-stub:%s:%s" % (base, model), lambda: self._anthropic_count(base, key, model, "x"))
        if stub is None:
            return None
        counts = {}
        for part, text in texts.items():
            counts[part] = max(0, self._anthropic_count(base, key, model, text) - stub)
        return counts

    @staticmethod
    def _anthropic_count_http(base, key, model, text):
        body = json.dumps({"model": model, "messages": [{"role": "user", "content": text or "x"}]}).encode("utf-8")
        request = urllib.request.Request(
            base + "/v1/messages/count_tokens", data=body, headers={"content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01"}, method="POST"
        )
        with urllib.request.urlopen(request, timeout=20) as response:
            return int(json.loads(response.read())["input_tokens"])

    # Sending: signed, two retries with backoff, then dropped. Never raises.
    def send(self, url, secret, body):
        raw = json.dumps(body, separators=(",", ":")).encode("utf-8")
        for attempt in range(3):
            try:
                self._post(url, raw, {"content-type": "application/json", "x-landflow-signature": sign(secret, raw)})
                return True
            except urllib.error.HTTPError as error:
                if 400 <= error.code < 500:  # a refusal (wrong secret, off, bad body) does not change on retry
                    self._warn_once("http:%d" % error.code, "landflow parts: Landflow answered %d; dropping splits (check LANDFLOW_PARTS_SECRET and that the host has LANDFLOW_LLM_GATEWAY_PARTS_SECRET)" % error.code)
                    return False
                if attempt == 2:
                    self._warn_once("drop:http", "landflow parts: dropped a split after 3 tries (HTTP %d)" % error.code)
                    return False
                try:
                    self._sleep(0.5 * (attempt + 1))
                except Exception:
                    return False
            except Exception as error:
                if attempt == 2:
                    self._warn_once("drop:" + type(error).__name__, "landflow parts: dropped a split after 3 tries (%s)" % type(error).__name__)
                    return False
                try:
                    self._sleep(0.5 * (attempt + 1))
                except Exception:
                    return False
        return False

    @staticmethod
    def _http_post(url, raw, headers):
        request = urllib.request.Request(url, data=raw, headers=headers, method="POST")
        with urllib.request.urlopen(request, timeout=10) as response:
            if response.status >= 300:
                raise RuntimeError("status %d" % response.status)


proxy_handler_instance = LandflowParts()
