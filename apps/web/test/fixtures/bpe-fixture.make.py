"""Makes bpe-fixture.json: a made-up byte-level BPE vocabulary and the token counts the Hugging Face `tokenizers`
library gives for a handful of strings (wave 12, SP22; contract backbone/contracts/s12/bpe-fixture.md).

Run it in the pinned LiteLLM image, offline, from this folder:

  docker --context orbstack run --rm --network none -e LITELLM_LOCAL_MODEL_COST_MAP=True \
    -v "$PWD":/work -w /work --entrypoint python \
    ghcr.io/berriai/litellm:v1.108.2-lts@sha256:d8b4ac356743d647a13bb93f45b941fcd5f5354122cfd205948a1b192790389d \
    bpe-fixture.make.py

The vocabulary is not any real model's: the 256 byte symbols (GPT-2 byte-to-unicode mapping) and merges for a few common
English pieces. The counts are the reference's (qwen2 pre-tokenizer: Split on the qwen2 regex, then ByteLevel without
its own regex).
"""
import json
from tokenizers import Regex, Tokenizer, models, pre_tokenizers

QWEN2 = r"(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+"


def byte_symbols():
    """GPT-2's bytes_to_unicode, in byte order."""
    keep = list(range(ord("!"), ord("~") + 1)) + list(range(ord("¡"), ord("¬") + 1)) + list(range(ord("®"), ord("ÿ") + 1))
    table, extra = {}, 0
    for b in range(256):
        if b in keep:
            table[b] = chr(b)
        else:
            table[b] = chr(256 + extra)
            extra += 1
    return [table[b] for b in range(256)], table


SYMBOLS, TABLE = byte_symbols()
SP = TABLE[ord(" ")]  # the symbol for a space (Ġ)
NL = TABLE[ord("\n")]

# Pieces to build merges for, each as the symbols of the text (a leading space is its symbol).
PIECES = [
    "the", SP + "the", "he", "ll", "llo", "Hello", "ell", SP + "w", "wor", "world", "orld", SP + "world",
    "and", SP + "and", "an", "nd", "ing", "in", "ng", "tion", "ti", "on", SP + "a", SP + "s", SP + "t", "er", "re", "at", "es",
    "digit", "igit", "its", SP + "digits", "two", SP + "two", "spaces", SP + "spaces", "space", "new", "line", SP + "newline",
    "caf", "af", "ca", "na", "ve", "ï", "naï", "naïve", "é", "ün", "ï", "cö", "dé", "é",
    SP + "i", "is", SP + "is", "to", SP + "to", "of", SP + "of", "tok", "ken", "token", "tokens", SP + "tokens",
    "a", "b", "c",
]


def build():
    tokens = list(SYMBOLS)
    merges = []
    seen = set(tokens)
    for piece in PIECES:
        syms = [TABLE[b] for b in piece.encode("utf-8")] if not all(ch in SYMBOLS for ch in piece) else list(piece)
        cur = syms[0]
        for nxt in syms[1:]:
            merged = cur + nxt
            pair = f"{cur} {nxt}"
            if pair not in merges:
                merges.append(pair)
            if merged not in seen:
                seen.add(merged)
                tokens.append(merged)
            cur = merged
    return tokens, merges


CASES = [
    "Hello, world!",
    "  two spaces\nand a newline",
    "12345 digits",
    "naïve café — ünïcödé",
    "",
    "the tokens and the world of tokens",
    "It's what we're doing, isn't it?\r\n\r\nYes.",
    "tabs\tand    runs   of spaces  ",
    "日本語のテキスト 😀",
]


def main():
    tokens, merges = build()
    assert len(tokens) <= 600 and len(merges) <= 400, (len(tokens), len(merges))
    vocab = {t: i for i, t in enumerate(tokens)}
    tok = Tokenizer(models.BPE(vocab=vocab, merges=[tuple(m.split(" ")) for m in merges]))
    tok.pre_tokenizer = pre_tokenizers.Sequence([
        pre_tokenizers.Split(Regex(QWEN2), behavior="isolated", invert=False),
        pre_tokenizers.ByteLevel(add_prefix_space=False, use_regex=False),
    ])
    fixture = {
        "about": "A made-up byte-level BPE vocabulary (GPT-2 byte-to-unicode mapping) for tests. Not any real model's.",
        "pre": "qwen2",
        "tokens": tokens,
        "merges": merges,
        "cases": [{"text": t, "count": len(tok.encode(t).ids)} for t in CASES],
    }
    with open("bpe-fixture.json", "w", encoding="utf-8") as f:
        json.dump(fixture, f, ensure_ascii=False, indent=1)
        f.write("\n")
    print(len(tokens), "tokens", len(merges), "merges")


main()
