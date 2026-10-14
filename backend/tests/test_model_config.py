"""Focused tests for Groq model configuration and request compatibility.

Run from the backend/ directory:

    python tests/test_model_config.py

Verifies, fully offline (no network, no database, no secrets):

  1. config.MODELS["groq"] defaults to ``openai/gpt-oss-120b`` when the
     GROQ_MODEL env var is unset and backend/.env is neutralised — this is
     how production resolves the model (Vercel sets no GROQ_MODEL var).
  2. The GROQ_MODEL environment override still works (feature preserved).
  3. The payload llm.complete() sends to Groq contains exactly the documented
     parameters {model, temperature, messages} with system+user roles — all
     supported by the Groq Chat Completions API for openai/gpt-oss-120b —
     and the response is parsed from choices[0].message.content.
  4. Provider fallback order (groq -> openai -> ...) is preserved.
  5. The retired llama-3.3-70b-versatile id is gone from config.py and
     .env.example.

The retired model id appears in this file only as the negative assertion in
test 5 (checked as absence in the configuration sources).
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Keep file side effects away from backend/data before the app is imported.
os.environ["OMNIRAG_DATA_DIR"] = tempfile.mkdtemp(prefix="omnirag_model_test_")
os.environ.setdefault("JWT_SECRET", "model-test-0123456789abcdef0123456789abcdef")

import app.llm as llm  # noqa: E402  (path/env must be set first)
from app import config  # noqa: E402

BACKEND = Path(__file__).resolve().parents[1]
RETIRED = "llama-3.3-70b-versatile"  # asserted ABSENT from config sources
NEW_MODEL = "openai/gpt-oss-120b"

# Resolves MODELS in a child interpreter with backend/.env neutralised, so the
# code default (not a local env file) is what gets read.
_SUBPROC = (
    "import json, sys\n"
    "import dotenv\n"
    "dotenv.load_dotenv = lambda *a, **k: None\n"
    "sys.path.insert(0, sys.argv[1])\n"
    "import app.config as c\n"
    "print(json.dumps(c.MODELS['groq']))\n"
)


def _resolve(child_env):
    r = subprocess.run(
        [sys.executable, "-B", "-c", _SUBPROC, str(BACKEND)],
        env=child_env, capture_output=True, text=True, timeout=60,
    )
    if r.returncode != 0:
        raise AssertionError(f"child failed: {r.stderr[-500:]}")
    return json.loads(r.stdout.strip().splitlines()[-1])


def _base_env():
    env = {k: v for k, v in os.environ.items() if k != "GROQ_MODEL"}
    env["OMNIRAG_DATA_DIR"] = tempfile.mkdtemp(prefix="omnirag_model_test_")
    return env


class _FakeResp:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


_FAKE_KEYS = {"groq": "g-test-key", "openai": "o-test-key",
              "anthropic": "", "gemini": ""}


class TestModelConfig(unittest.TestCase):
    def test_groq_default_is_gpt_oss_120b(self):
        """Code default (production resolution) is the new model."""
        self.assertEqual(_resolve(_base_env()), NEW_MODEL)

    def test_groq_env_override_still_works(self):
        """GROQ_MODEL keeps overriding the default (feature preserved)."""
        env = _base_env()
        env["GROQ_MODEL"] = "custom-test-model"
        self.assertEqual(_resolve(env), "custom-test-model")

    def test_groq_request_payload_matches_documented_params(self):
        """Payload carries only {model, temperature, messages}, as documented."""
        captured = {}

        def fake_post(url, **kw):
            captured["url"] = url
            captured.update(kw)
            return _FakeResp({"choices": [{"message": {"content": "stub-answer"}}]})

        with mock.patch.object(llm, "KEYS", _FAKE_KEYS), \
             mock.patch.object(llm.httpx, "post", side_effect=fake_post):
            text, provider = llm.complete(
                "You are terse.", "hello", provider="groq", temp=0.1)

        self.assertEqual(text, "stub-answer")
        self.assertEqual(provider, "groq")
        body = captured["json"]
        self.assertEqual(set(body.keys()), {"model", "temperature", "messages"})
        self.assertEqual(body["model"], llm.MODELS["groq"])
        self.assertEqual(body["temperature"], 0.1)
        self.assertEqual([m["role"] for m in body["messages"]],
                         ["system", "user"])
        self.assertEqual(body["messages"][0]["content"], "You are terse.")
        self.assertEqual(captured["url"],
                         "https://api.groq.com/openai/v1/chat/completions")
        self.assertTrue(
            captured["headers"]["Authorization"].startswith("Bearer "))

    def test_fallback_order_preserved(self):
        """A groq failure still falls through to the next provider."""
        calls = []

        def fake_post(url, **kw):
            calls.append(url)
            if url == llm.GROQ_URL:
                raise RuntimeError("simulated groq outage")
            return _FakeResp({"choices": [{"message": {"content": "fb-answer"}}]})

        with mock.patch.object(llm, "KEYS", _FAKE_KEYS), \
             mock.patch.object(llm.httpx, "post", side_effect=fake_post):
            text, provider = llm.complete(
                "s", "p", provider="groq", temp=0.1)

        self.assertEqual((text, provider), ("fb-answer", "openai"))
        self.assertEqual(calls, [llm.GROQ_URL, llm.OPENAI_URL])

    def test_retired_model_id_removed_from_config_sources(self):
        cfg = (BACKEND / "app" / "config.py").read_text(encoding="utf-8")
        self.assertNotIn(RETIRED, cfg)
        self.assertIn(f'os.getenv("GROQ_MODEL", "{NEW_MODEL}")', cfg)
        example = (BACKEND / ".env.example").read_text(encoding="utf-8")
        self.assertNotIn(RETIRED, example)
        self.assertIn(f"GROQ_MODEL={NEW_MODEL}", example)


if __name__ == "__main__":
    unittest.main(verbosity=2)
