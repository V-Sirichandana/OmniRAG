import httpx
from .config import KEYS, MODELS

ORDER = ["groq", "openai", "anthropic", "gemini"]
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
OPENAI_URL = "https://api.openai.com/v1/chat/completions"


def available():
    return [p for p in ORDER if KEYS.get(p)]


def _openai_like(url, key, model, system, prompt, temp):
    r = httpx.post(
        url,
        headers={"Authorization": "Bearer " + key},
        timeout=60,
        json={
            "model": model,
            "temperature": temp,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
        },
    )
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


def _anthropic(system, prompt, temp):
    r = httpx.post(
        "https://api.anthropic.com/v1/messages",
        timeout=60,
        headers={
            "x-api-key": KEYS["anthropic"],
            "anthropic-version": "2023-06-01",
        },
        json={
            "model": MODELS["anthropic"],
            "max_tokens": 1500,
            "temperature": temp,
            "system": system,
            "messages": [{"role": "user", "content": prompt}],
        },
    )
    r.raise_for_status()
    return r.json()["content"][0]["text"]


def _gemini(system, prompt, temp):
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        + MODELS["gemini"]
        + ":generateContent"
    )
    r = httpx.post(
        url,
        params={"key": KEYS["gemini"]},
        timeout=60,
        json={
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": temp},
        },
    )
    r.raise_for_status()
    return r.json()["candidates"][0]["content"]["parts"][0]["text"]


def _why(e):
    r = getattr(e, "response", None)
    if r is None:
        return type(e).__name__ + " " + str(e)[:100]
    return str(r.status_code) + " " + r.text[:150]


def complete(system, prompt, provider=None, temp=0.1):
    """Returns (text, provider_used). Tries the preferred provider, then the rest."""
    order = []
    if provider in available():
        order.append(provider)
    order += [p for p in available() if p != provider]
    if not order:
        raise RuntimeError("No LLM API key configured. Add one to backend/.env")
    errs = []
    for p in order:
        try:
            if p == "groq":
                t = _openai_like(GROQ_URL, KEYS[p], MODELS[p], system, prompt, temp)
            elif p == "openai":
                t = _openai_like(OPENAI_URL, KEYS[p], MODELS[p], system, prompt, temp)
            elif p == "anthropic":
                t = _anthropic(system, prompt, temp)
            else:
                t = _gemini(system, prompt, temp)
            return t, p
        except Exception as e:
            errs.append(p + ": " + _why(e))
    raise RuntimeError("All LLM providers failed (" + "; ".join(errs) + ")")