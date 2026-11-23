"""
The gateway's callback (custom_callbacks.py), run inside the pinned LiteLLM image with no network:

  docker --context orbstack run --rm --network none -e LITELLM_LOCAL_MODEL_COST_MAP=True \
    -v "$PWD/deploy/llm-gateway:/w" -w /w --entrypoint python \
    ghcr.io/berriai/litellm:v1.108.2-lts@sha256:d8b4ac356743d647a13bb93f45b941fcd5f5354122cfd205948a1b192790389d \
    -m unittest discover -s tests

Nothing here reaches a vendor: the post, the Ollama /api/show and Anthropic's count endpoint are fakes.
"""

import asyncio
import hashlib
import hmac
import http.server
import json
import os
import threading
import time
import unittest
import urllib.error

os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")
import custom_callbacks as cc  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "bpe-fixture.json"), encoding="utf-8") as f:
    FIXTURE = json.load(f)

SECRET = "landflow-dev-parts-only"
KEY = cc.hash_key(SECRET)

# The same segments and key the TypeScript side pins in apps/web/test/gateway-parts.test.ts (made once from hashParts).
VECTOR_SEGMENTS = [
    {"where": "tools", "part": "toolDefinitions", "text": '{"name":"read_file","description":"Reads a file — naïve","input_schema":{"type":"object"}}'},
    {"where": "tools", "part": "toolDefinitions", "text": '{"name":"bash"}', "breakpoint": True},
    {"where": "system", "part": "instructions", "text": "You are a careful agent. "},
    {"where": "system", "part": "instructions", "text": "Today is 2026-11-16 — café ☕", "breakpoint": True},
    # The agent prompt's date stamp: in no part hash and not in promptHash (the expected hashes are the same without it).
    {"where": "messages", "part": "formatting", "text": "Current date and time: 2026-11-16T10:11:12.345Z"},
    {"where": "messages", "part": "history", "text": "earlier turn"},
    {"where": "messages", "part": "toolResults", "text": "file contents\n"},
    {"where": "messages", "part": "userMessage", "text": "Now fix the bug."},
]
VECTOR_1 = {
    "prefixHash": "3ca81d153c6b8cfb",
    "promptHash": "783fe2f5271ffa6d",
    "partHashes": {"instructions": "a6f5d5f3fca80a8f", "toolDefinitions": "e3c01feeea3ae75d", "history": "eedfdfa8630e1552", "toolResults": "430453728465355e", "userMessage": "c93d0ad86faa1754"},
    "toolNames": ["read_file", "bash"],
}
VECTOR_2_PROMPT = "663eb1a8f06db518"


def run(coro):
    return asyncio.run(coro)


class Sent:
    def __init__(self, fail=0):
        self.calls = []
        self.fail = fail

    def __call__(self, url, raw, headers):
        self.calls.append((url, raw, headers))
        if len(self.calls) <= self.fail:
            raise OSError("down")


def callback(post=None, **kw):
    return cc.LandflowParts(url="http://landflow.test/api/gateway-parts", secret=SECRET, post=post or Sent(), sleep=lambda s: None, **kw)


def finish(cb, kwargs, response):
    """Run the callback and wait for its worker thread (the real one never blocks LiteLLM)."""

    async def go():
        await cb.async_log_success_event(kwargs, response, 0, 1)

    run(go())
    cb.wait_idle()


OPENAI = {
    "model": "gpt-4o",
    "call_type": "acompletion",
    "litellm_call_id": "call-1",
    "litellm_params": {"custom_llm_provider": "openai"},
    "messages": [
        {"role": "system", "content": "You are a careful agent."},
        {"role": "user", "content": "first question"},
        {"role": "assistant", "content": "first answer", "tool_calls": [{"id": "t1", "type": "function", "function": {"name": "bash", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "t1", "content": "ls output"},
        {"role": "user", "content": [{"type": "text", "text": "Now fix the bug."}, {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}]},
    ],
    "optional_params": {"tools": [{"type": "function", "function": {"name": "bash", "description": "Run a command", "parameters": {"type": "object"}}}]},
}
RESPONSE = {"id": "chatcmpl-abc123", "usage": {"prompt_tokens": 400, "completion_tokens": 20}}

ANTHROPIC = {
    "model": "claude-sonnet-4-6",
    "call_type": "anthropic_messages",
    "litellm_params": {"custom_llm_provider": "anthropic"},
    "system": [{"type": "text", "text": "Persona."}, {"type": "text", "text": "More persona.", "cache_control": {"type": "ephemeral"}}],
    "tools": [{"name": "read_file", "description": "Reads", "input_schema": {"type": "object"}, "cache_control": {"type": "ephemeral"}}, {"name": "bash", "input_schema": {"type": "object"}}],
    "messages": [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": [{"type": "text", "text": "I will read."}, {"type": "tool_use", "id": "u1", "name": "read_file", "input": {"path": "a"}}]},
        {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "u1", "content": "the file"}]},
        {"role": "user", "content": [{"type": "text", "text": "thanks, now continue"}]},
    ],
}


class Split(unittest.TestCase):
    def test_openai_shape(self):
        segments, images, names = cc.split_request(OPENAI)
        self.assertEqual(images, 1)
        self.assertEqual(names, ["bash"])
        by = [(s["where"], s["part"]) for s in segments]
        self.assertEqual(by[0], ("tools", "toolDefinitions"))
        self.assertIn(("system", "instructions"), by)
        self.assertIn(("messages", "toolResults"), by)
        self.assertEqual(cc.part_texts(segments)["userMessage"], "Now fix the bug.")
        self.assertIn("first answer", cc.part_texts(segments)["history"])
        self.assertEqual(cc.part_texts(segments)["toolResults"], "ls output")

    def test_anthropic_shape(self):
        segments, images, names = cc.split_request(ANTHROPIC)
        self.assertEqual(images, 0)
        self.assertEqual(names, ["read_file", "bash"])
        texts = cc.part_texts(segments)
        self.assertEqual(texts["instructions"], "Persona.More persona.")
        self.assertEqual(texts["toolResults"], "the file")
        self.assertEqual(texts["userMessage"], "thanks, now continue")
        self.assertIn("hello", texts["history"])
        self.assertIn("read_file", texts["history"])
        # cache_control on a tool and on the last system block: the prefix ends at the system block.
        self.assertEqual([i for i, s in enumerate(segments) if s.get("breakpoint")], [0, 3])


class Counting(unittest.TestCase):
    def test_fixture_counts(self):
        counter = cc.BpeCounter(FIXTURE["tokens"], FIXTURE["merges"], FIXTURE["pre"])
        self.assertTrue(FIXTURE["cases"])
        for case in FIXTURE["cases"]:
            self.assertEqual(counter.count(case["text"]), case["count"], case["text"])

    def test_bpe_from_show(self):
        info = {"model_info": {"tokenizer.ggml.tokens": FIXTURE["tokens"], "tokenizer.ggml.merges": FIXTURE["merges"], "tokenizer.ggml.pre": FIXTURE["pre"]}}
        self.assertIsNotNone(cc.bpe_from_show(info))
        info["model_info"]["tokenizer.ggml.pre"] = "gpt-2"
        self.assertIsNone(cc.bpe_from_show(info))

    def test_tiktoken_loads_offline(self):
        for name in ("cl100k_base", "o200k_base"):
            self.assertGreater(cc.TiktokenCounter(name).count("Hello, world!"), 0)

    def test_balance(self):
        self.assertEqual(cc.balance({"history": 10, "userMessage": 5}, 20), {"history": 10, "userMessage": 5, "formatting": 5})
        scaled = cc.balance({"history": 30, "userMessage": 10}, 20)
        self.assertEqual(sum(scaled.values()), 20)
        self.assertNotIn("formatting", scaled)
        self.assertEqual(cc.balance({"history": 3}, 0), {})


class Hashes(unittest.TestCase):
    def test_vectors(self):
        out = cc.hash_segments(VECTOR_SEGMENTS, 1, KEY, ["read_file", "bash"])
        self.assertEqual(out, VECTOR_1)
        plain = cc.hash_segments([{**s, "breakpoint": False} for s in VECTOR_SEGMENTS], 0, KEY)
        self.assertEqual(plain["promptHash"], VECTOR_2_PROMPT)
        self.assertEqual(plain["prefixHash"], VECTOR_1["prefixHash"])
        self.assertNotIn("toolNames", plain)

    def test_message_cache_control_is_left_out(self):
        segs = [{"where": "system", "part": "instructions", "text": "a"}, {"where": "messages", "part": "history", "text": "b", "breakpoint": False}]
        self.assertEqual(cc.hash_segments(segs, 0, KEY)["prefixHash"], cc.hash_segments(segs[:1], 0, KEY)["prefixHash"])

    def test_signature_format(self):
        header = cc.sign(SECRET, b'{"a":1}', now=1_700_000_000)
        t, v1 = header.split(",")
        self.assertEqual(t, "t=1700000000")
        self.assertEqual(v1, "v1=" + hmac.new(SECRET.encode(), b'1700000000.{"a":1}', hashlib.sha256).hexdigest())


class Fake:
    """A loopback server standing in for Ollama and Anthropic (works under --network none). Records the paths asked."""

    def __init__(self):
        self.paths = []
        fake = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
                fake.paths.append(self.path)
                if self.path == "/api/show":
                    out = {"model_info": {"tokenizer.ggml.tokens": FIXTURE["tokens"], "tokenizer.ggml.merges": FIXTURE["merges"], "tokenizer.ggml.pre": FIXTURE["pre"]}}
                elif self.path == "/api/chat":
                    out = {"model": "m", "created_at": "2026-01-01T00:00:00Z", "message": {"role": "assistant", "content": "hi"}, "done": True, "prompt_eval_count": 40, "eval_count": 2}
                elif self.path == "/v1/messages/count_tokens":
                    fake.counts.append({"key": self.headers.get("x-api-key"), "tools": request.get("tools"), "system": request.get("system")})
                    out = {"input_tokens": 5 + len(json.dumps([request.get("messages"), request.get("tools"), request.get("system")])) // 4}
                elif self.path == "/v1/messages":
                    out = {"id": "msg_1", "type": "message", "role": "assistant", "model": "claude-x", "content": [{"type": "text", "text": "hi"}], "stop_reason": "end_turn", "usage": {"input_tokens": 40, "output_tokens": 1}}
                else:
                    self.send_response(404)
                    self.end_headers()
                    return
                raw = json.dumps(out).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        self.counts = []
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = "http://127.0.0.1:%d" % self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()


class RealLiteLLM(unittest.TestCase):
    """The callback driven by LiteLLM itself (real kwargs, real api_base shapes) against a loopback fake provider."""

    # LiteLLM registers one logger per class for the life of the process, so one instance serves every test here.
    @classmethod
    def setUpClass(cls):
        import litellm

        cls.litellm = litellm
        cls.loop = asyncio.new_event_loop()  # LiteLLM's logging worker binds to the first loop it sees
        cls.cb = callback(Sent())
        litellm.callbacks = [cls.cb]

    @classmethod
    def tearDownClass(cls):
        cls.litellm.callbacks = []
        cls.loop.close()

    def setUp(self):
        self.fake = Fake()
        self.sent = Sent()
        self.cb._post = self.sent
        self.cb._counters = {}

    def tearDown(self):
        self.fake.close()

    def drive(self, coro):
        async def go():
            await coro
            for _ in range(100):  # LiteLLM logs after the response, on a task of its own
                await asyncio.sleep(0.05)
                if self.sent.calls:
                    break

        self.loop.run_until_complete(go())
        self.cb.wait_idle()
        self.assertEqual(len(self.sent.calls), 1, "the callback posted nothing")
        return json.loads(self.sent.calls[0][1])

    def test_ollama_chat_uses_the_tokenizer(self):
        body = self.drive(self.litellm.acompletion(model="ollama_chat/m", api_base=self.fake.base, messages=[{"role": "system", "content": "SYS prompt"}, {"role": "user", "content": "hello"}]))
        self.assertIn("/api/show", self.fake.paths)
        self.assertNotIn("/api/chat/api/show", self.fake.paths)
        self.assertEqual(body["method"], "tokenizer")
        self.assertIn("instructions", body["parts"])

    def test_ollama_base_from_the_environment(self):
        os.environ["OLLAMA_API_BASE"] = self.fake.base
        try:
            body = self.drive(self.litellm.acompletion(model="ollama_chat/m", messages=[{"role": "user", "content": "hello"}]))
        finally:
            os.environ.pop("OLLAMA_API_BASE", None)
        self.assertEqual(body["method"], "tokenizer")
        self.assertEqual(set(p for p in self.fake.paths if p != "/api/chat"), {"/api/show"})

    def test_anthropic_shaped_request_to_an_ollama_model_keeps_its_system_prompt(self):
        body = self.drive(
            self.litellm.anthropic_messages(model="ollama_chat/m", api_base=self.fake.base, system="You are Claude Code, a careful agent.", messages=[{"role": "user", "content": "hello"}], max_tokens=5)
        )
        self.assertIn("instructions", body["parts"])
        self.assertIn("instructions", body["partHashes"])
        self.assertEqual(body["method"], "tokenizer")

    def test_native_anthropic_counts_through_the_endpoint_and_system_once(self):
        os.environ.pop("ANTHROPIC_API_KEY", None)
        body = self.drive(
            self.litellm.anthropic_messages(model="claude-x", custom_llm_provider="anthropic", api_base=self.fake.base, api_key="k", system="You are Claude Code.", messages=[{"role": "user", "content": "hello"}], max_tokens=5)
        )
        self.assertIn("/v1/messages/count_tokens", self.fake.paths)
        self.assertNotIn("/v1/messages/v1/messages/count_tokens", self.fake.paths)
        self.assertEqual(body["method"], "provider")
        self.assertIn("instructions", body["parts"])

    def test_router_deployment_key_is_used_on_the_messages_path(self):
        from litellm import Router
        from litellm.proxy import proxy_server

        os.environ["ANTHROPIC_API_KEY"] = "env-key"
        router = Router(model_list=[{"model_name": "claude-x", "litellm_params": {"model": "anthropic/claude-x", "api_key": "deployment-key", "api_base": self.fake.base}}])
        previous = getattr(proxy_server, "llm_router", None)
        proxy_server.llm_router = router
        try:
            body = self.drive(
                router.aanthropic_messages(
                    model="claude-x", system="You are Claude Code.", tools=[{"name": "bash", "description": "run", "input_schema": {"type": "object"}}], messages=[{"role": "user", "content": "hello"}], max_tokens=5
                )
            )
        finally:
            proxy_server.llm_router = previous
            os.environ.pop("ANTHROPIC_API_KEY", None)
        self.assertEqual(body["method"], "provider")
        self.assertTrue(self.fake.counts)
        self.assertEqual({c["key"] for c in self.fake.counts}, {"deployment-key"})
        self.assertTrue(any(c["tools"] for c in self.fake.counts))

    def test_system_is_not_counted_twice_on_the_native_path(self):
        kwargs = {"model": "claude-x", "system": "SYS", "messages": [{"role": "user", "content": "hi"}], "input": [{"role": "system", "content": "SYS"}, {"role": "user", "content": "hi"}]}
        segments, _, _ = cc.split_request(kwargs)
        self.assertEqual([s["text"] for s in segments if s["part"] == "instructions"], ["SYS"])


class Resilience(unittest.TestCase):
    def test_strip_base(self):
        self.assertEqual(cc.strip_base("http://h:11434/api/chat", cc.OLLAMA_PATHS), "http://h:11434")
        self.assertEqual(cc.strip_base("http://h:11434/", cc.OLLAMA_PATHS), "http://h:11434")
        self.assertEqual(cc.strip_base("https://x/v1/messages", cc.ANTHROPIC_PATHS), "https://x")

    def test_a_failed_vocabulary_load_is_not_repeated(self):
        sent = Sent()
        shown = []

        def show(base, model):
            shown.append(model)
            raise urllib.error.URLError("down")

        kwargs = {**OPENAI, "model": "q", "litellm_params": {"custom_llm_provider": "ollama_chat", "api_base": "http://h:11434/api/chat"}, "messages": [{"role": "user", "content": "Hello"}]}
        cb = callback(sent, show=show)
        for n in range(3):
            finish(cb, kwargs, {"id": "c%d" % n, "usage": {"prompt_tokens": 20}})
        self.assertEqual(shown, ["q"])
        self.assertEqual(len(sent.calls), 3)
        self.assertEqual(json.loads(sent.calls[2][1])["method"], "estimate")

    def test_client_errors_are_not_retried(self):
        calls = []

        def post(url, raw, headers):
            calls.append(1)
            raise urllib.error.HTTPError(url, 404, "nf", {}, None)

        cb = callback(post)
        finish(cb, OPENAI, RESPONSE)
        finish(cb, OPENAI, RESPONSE)
        self.assertEqual(len(calls), 2)

    def test_a_429_waits_retry_after_capped_at_five_seconds(self):
        calls = []
        sleeps = []

        def post(url, raw, headers):
            calls.append(1)
            raise urllib.error.HTTPError(url, 429, "slow down", {"Retry-After": "30" if len(calls) == 1 else "2"}, None)

        cb = cc.LandflowParts(url="http://landflow.test/api/gateway-parts", secret=SECRET, post=post, sleep=sleeps.append)
        self.assertFalse(cb.send(cb.url, SECRET, {"a": 1}))
        self.assertEqual(len(calls), 3)
        self.assertEqual(sleeps, [5.0, 2.0])

    def test_a_429_then_success_is_sent(self):
        calls = []
        sleeps = []

        def post(url, raw, headers):
            calls.append(1)
            if len(calls) == 1:
                raise urllib.error.HTTPError(url, 429, "slow down", {"Retry-After": "1"}, None)

        cb = cc.LandflowParts(url="http://landflow.test/api/gateway-parts", secret=SECRET, post=post, sleep=sleeps.append)
        self.assertTrue(cb.send(cb.url, SECRET, {"a": 1}))
        self.assertEqual(len(calls), 2)
        self.assertEqual(sleeps, [1.0])

    def test_a_full_queue_drops(self):
        gate = threading.Event()
        calls = []

        def post(url, raw, headers):
            gate.wait(5)
            calls.append(1)

        cb = callback(post)
        cb.max_pending = 2

        async def go():
            for n in range(5):
                await cb.async_log_success_event(OPENAI, {**RESPONSE, "id": "c%d" % n}, 0, 1)

        run(go())
        gate.set()
        cb.wait_idle()
        self.assertEqual(len(calls), 2)

    def test_anthropic_tools_go_through_the_tools_field_and_stay_exact(self):
        sent = Sent()
        asked = []

        def count(base, key, model, text, tools=None, system=None):
            asked.append({"tools": tools, "system": system})
            return 10

        kwargs = {**ANTHROPIC, "litellm_params": {"custom_llm_provider": "anthropic", "api_key": "k"}}
        finish(callback(sent, anthropic_count=count), kwargs, {"id": "msg_9", "usage": {"prompt_tokens": 900}})
        self.assertEqual(json.loads(sent.calls[0][1])["method"], "provider")
        self.assertTrue(any(a["tools"] and [t["name"] for t in a["tools"]] == ["read_file", "bash"] for a in asked))
        self.assertTrue(any(a["system"] for a in asked))

    def test_env_key_is_not_sent_to_a_custom_base(self):
        sent = Sent()
        keys = []
        os.environ["ANTHROPIC_API_KEY"] = "env-key"
        try:
            kwargs = {**ANTHROPIC, "litellm_params": {"custom_llm_provider": "anthropic", "api_base": "http://other.test/v1/messages"}}
            finish(callback(sent, anthropic_count=lambda b, k, m, t, **kw: keys.append(k) or 10), kwargs, {"id": "msg_8", "usage": {"prompt_tokens": 900}})
        finally:
            os.environ.pop("ANTHROPIC_API_KEY", None)
        self.assertEqual(keys, [])
        self.assertEqual(json.loads(sent.calls[0][1])["method"], "estimate")


class Callback(unittest.TestCase):
    def posted(self, sent):
        self.assertEqual(len(sent.calls), 1)
        url, raw, headers = sent.calls[0]
        return url, json.loads(raw), raw, headers

    def check_body(self, body, raw):
        allowed = {"requestId", "at", "model", "provider", "method", "inputTokens", "parts", "prefixHash", "promptHash", "partHashes", "toolNames"}
        self.assertLessEqual(set(body), allowed)

        def walk(value):
            if isinstance(value, str):
                self.assertLessEqual(len(value), 200)
            elif isinstance(value, dict):
                for v in value.values():
                    walk(v)
            elif isinstance(value, list):
                for v in value:
                    walk(v)

        walk(body)
        for text in ("careful agent", "Now fix the bug", "ls output", "first answer", "Persona"):
            self.assertNotIn(text, raw.decode())
        self.assertEqual(sum(body["parts"].values()), body["inputTokens"])

    def test_openai_call_posts_numbers_and_hashes(self):
        sent = Sent()
        finish(callback(sent), OPENAI, RESPONSE)
        url, body, raw, headers = self.posted(sent)
        self.assertEqual(url, "http://landflow.test/api/gateway-parts")
        self.assertEqual(body["requestId"], "chatcmpl-abc123")
        self.assertEqual(body["method"], "estimate")  # an image is in the call: its tokens are estimated
        self.assertEqual(body["inputTokens"], 400)
        self.assertEqual(body["provider"], "openai")
        self.assertIn("images", body["parts"])
        self.assertEqual(body["toolNames"], ["bash"])
        self.check_body(body, raw)
        t, v1 = headers["x-landflow-signature"].split(",")
        self.assertEqual(v1, "v1=" + hmac.new(SECRET.encode(), t[2:].encode() + b"." + raw, hashlib.sha256).hexdigest())

    def test_tokenizer_method_without_images(self):
        sent = Sent()
        no_image = {**OPENAI, "messages": OPENAI["messages"][:-1] + [{"role": "user", "content": "Now fix the bug."}]}
        finish(callback(sent), no_image, RESPONSE)
        _, body, raw, _ = self.posted(sent)
        self.assertEqual(body["method"], "tokenizer")
        self.assertIn("formatting", body["parts"])
        self.check_body(body, raw)

    def test_anthropic_without_key_estimates(self):
        sent = Sent()
        os.environ.pop("ANTHROPIC_API_KEY", None)
        finish(callback(sent), ANTHROPIC, {"id": "msg_01", "usage": {"prompt_tokens": 900}})
        _, body, raw, _ = self.posted(sent)
        self.assertEqual(body["method"], "estimate")
        self.assertEqual(body["requestId"], "msg_01")
        self.assertEqual(body["toolNames"], ["read_file", "bash"])
        self.check_body(body, raw)

    def test_anthropic_with_the_count_endpoint(self):
        sent = Sent()
        asked = []

        def count(base, key, model, text, **kw):
            asked.append((base, key, model))
            return 10 + len(text) // 4

        kwargs = {**ANTHROPIC, "tools": None, "litellm_params": {"custom_llm_provider": "anthropic", "api_key": "sk-ant-test"}}
        finish(callback(sent, anthropic_count=count), kwargs, {"id": "msg_02", "usage": {"prompt_tokens": 900}})
        _, body, raw, _ = self.posted(sent)
        self.assertEqual(body["method"], "provider")
        self.assertEqual({k for _, k, _ in asked}, {"sk-ant-test"})
        self.check_body(body, raw)

    def test_ollama_vocabulary_loaded_once_per_model(self):
        sent = Sent()
        shown = []

        def show(base, model):
            shown.append((base, model))
            return {"model_info": {"tokenizer.ggml.tokens": FIXTURE["tokens"], "tokenizer.ggml.merges": FIXTURE["merges"], "tokenizer.ggml.pre": FIXTURE["pre"]}}

        kwargs = {**OPENAI, "model": "qwen3-coder:30b", "litellm_params": {"custom_llm_provider": "ollama_chat", "api_base": "http://host.docker.internal:11434"}, "optional_params": {}, "messages": [{"role": "user", "content": "Hello, world!"}]}
        cb = callback(sent, show=show)
        finish(cb, kwargs, {"id": "chatcmpl-1", "usage": {"prompt_tokens": 20}})
        finish(cb, kwargs, {"id": "chatcmpl-2", "usage": {"prompt_tokens": 20}})
        self.assertEqual(shown, [("http://host.docker.internal:11434", "qwen3-coder:30b")])
        self.assertEqual(len(sent.calls), 2)
        body = json.loads(sent.calls[0][1])
        self.assertEqual(body["method"], "tokenizer")
        expected = cc.BpeCounter(FIXTURE["tokens"], FIXTURE["merges"], FIXTURE["pre"]).count("Hello, world!")
        self.assertGreater(expected, 0)
        self.assertEqual(body["parts"]["userMessage"], expected)
        self.assertEqual(body["parts"]["formatting"], 20 - expected)

    def test_request_id_is_the_spend_logs_id(self):
        from litellm.proxy.spend_tracking.spend_tracking_utils import get_spend_logs_id

        for kwargs, response in (
            ({**OPENAI}, {"id": "chatcmpl-x"}),
            ({**OPENAI, "standard_logging_object": {"id": "slo-1"}}, {}),
            ({**OPENAI}, {}),
        ):
            sent = Sent()
            finish(callback(sent), kwargs, {**response, "usage": {"prompt_tokens": 400}})
            self.assertEqual(json.loads(sent.calls[0][1])["requestId"], get_spend_logs_id("acompletion", response, kwargs))
        self.assertEqual(json.loads(sent.calls[0][1])["requestId"], "call-1")

    def test_cache_hit_sends_nothing(self):
        sent = Sent()
        finish(callback(sent), {**OPENAI, "cache_hit": True}, RESPONSE)
        finish(callback(sent), {**OPENAI, "standard_logging_object": {"cache_hit": True}}, RESPONSE)
        self.assertEqual(sent.calls, [])

    def test_off_without_env(self):
        sent = Sent()
        saved = {k: os.environ.pop(k, None) for k in ("LANDFLOW_PARTS_URL", "LANDFLOW_PARTS_SECRET")}
        try:
            cb = cc.LandflowParts(post=sent, sleep=lambda s: None)
            finish(cb, OPENAI, RESPONSE)
            os.environ["LANDFLOW_PARTS_URL"] = "http://x/api/gateway-parts"
            finish(cb, OPENAI, RESPONSE)  # the secret alone or the URL alone is still off
            self.assertEqual(sent.calls, [])
            os.environ["LANDFLOW_PARTS_SECRET"] = SECRET
            finish(cb, OPENAI, RESPONSE)
            self.assertEqual(len(sent.calls), 1)
        finally:
            for k in ("LANDFLOW_PARTS_URL", "LANDFLOW_PARTS_SECRET"):
                os.environ.pop(k, None)
                if saved[k] is not None:
                    os.environ[k] = saved[k]

    def test_retries_twice_then_drops_and_never_raises(self):
        sent = Sent(fail=2)
        finish(callback(sent), OPENAI, RESPONSE)
        self.assertEqual(len(sent.calls), 3)
        sent = Sent(fail=99)
        finish(callback(sent), OPENAI, RESPONSE)
        self.assertEqual(len(sent.calls), 3)

    def test_garbage_never_raises(self):
        sent = Sent()
        cb = callback(sent)
        for kwargs, response in ((None, None), ({}, {}), ({"messages": "x"}, {"id": "a"}), ({"messages": [None, 3]}, {"id": "a", "usage": {"prompt_tokens": 5}})):
            finish(cb, kwargs, response)
        self.assertEqual(sent.calls, [])

    def test_module_instance(self):
        self.assertIsInstance(cc.proxy_handler_instance, cc.LandflowParts)


if __name__ == "__main__":
    unittest.main()
