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
import json
import os
import unittest

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
        await asyncio.sleep(0)
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, lambda: None)

    run(go())


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

        def count(base, key, model, text):
            asked.append((base, key, model))
            return 10 + len(text) // 4

        kwargs = {**ANTHROPIC, "litellm_params": {"custom_llm_provider": "anthropic", "api_key": "sk-ant-test"}}
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
        self.assertEqual(body["parts"]["userMessage"], 4)
        self.assertEqual(body["parts"]["formatting"], 16)

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
