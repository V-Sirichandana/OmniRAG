"""Optional embedding provider.

Embeddings are produced by a hosted API (OpenAI or Gemini) so no local ML
model is ever bundled — this is what makes the platform deployable on
Vercel's Python runtime. When no embedding key is configured, every function
here returns None and the retriever degrades gracefully to BM25-only hybrid
search (see app/rag.py), keeping answers and citations working.
"""
import httpx
from .config import EMBED_MODELS, EMBED_PROVIDER, KEYS

_TIMEOUT = 30


def provider() -> str | None:
    """Which embedding provider would be used right now ('' if none)."""
    if EMBED_PROVIDER in ("openai", "gemini"):
        return EMBED_PROVIDER if KEYS.get(EMBED_PROVIDER) else None
    if EMBED_PROVIDER == "none":
        return None
    if KEYS.get("openai"):
        return "openai"
    if KEYS.get("gemini"):
        return "gemini"
    return None


def available() -> bool:
    return provider() is not None


def _openai(texts: list[str]) -> list[list[float]]:
    r = httpx.post(
        "https://api.openai.com/v1/embeddings",
        headers={"Authorization": "Bearer " + KEYS["openai"]},
        timeout=_TIMEOUT,
        json={"model": EMBED_MODELS["openai"], "input": texts},
    )
    r.raise_for_status()
    data = sorted(r.json()["data"], key=lambda d: d["index"])
    return [d["embedding"] for d in data]


def _gemini(texts: list[str]) -> list[list[float]]:
    model = EMBED_MODELS["gemini"]
    r = httpx.post(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:batchEmbedContents",
        params={"key": KEYS["gemini"]},
        timeout=_TIMEOUT,
        json={
            "requests": [
                {"model": f"models/{model}", "content": {"parts": [{"text": t}]}}
                for t in texts
            ]
        },
    )
    r.raise_for_status()
    return [e["embedding"] for e in r.json()["embeddings"]]


def embed(texts: list[str]) -> list[list[float]] | None:
    """Embed a list of texts, or return None when embeddings are unavailable.

    None means "no dense vectors" — callers must treat that as a normal,
    supported mode rather than an error (BM25 still runs).
    """
    p = provider()
    if p is None or not texts:
        return None
    try:
        out: list[list[float]] = []
        for i in range(0, len(texts), 64):          # keep request bodies small
            batch = texts[i:i + 64]
            out.extend(_openai(batch) if p == "openai" else _gemini(batch))
        return out
    except Exception as e:                           # degrade instead of failing the upload
        print(f"embeddings unavailable ({type(e).__name__}); continuing without vectors")
        return None
