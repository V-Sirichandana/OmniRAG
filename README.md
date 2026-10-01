# OmniRAG Platform v2 — Secure Multi-Tenant Agentic RAG

Two independent projects:

| Folder | Stack | Run |
|---|---|---|
| `backend/` | FastAPI, LangGraph, ChromaDB, BM25 + FlashRank | `uvicorn app.main:app --reload --port 8000` |
| `frontend/` | Streamlit | `pip install -r requirements.txt && streamlit run app.py` |

**Quick start:** 1) `cd backend`, create venv, `pip install -r requirements.txt`, copy `.env.example` → `.env` (set `JWT_SECRET` and one LLM key), run `uvicorn app.main:app --reload --port 8000`.
2) In a second terminal: `cd frontend && pip install -r requirements.txt && streamlit run app.py`.
3) Open http://localhost:8501 → *New organization* to create your org and first admin.

## What's new vs. the Streamlit version
- **Auth:** JWT sessions, bcrypt, login lockout, 8+ char passwords, no default admin account.
- **Invite-only membership:** admins issue single-use, expiring codes (no open sign-up into any org).
- **Strict tenant scoping:** every admin action is limited to the caller's own organization; no cross-org deletion.
- **Per-document access control:** "whole organization" or "selected people"; enforced inside retrieval, not just the UI.
- **Agentic pipeline (LangGraph):** plan/decompose → hybrid retrieve (BM25 + dense, RRF) → cross-encoder rerank → answer → LLM fact-check → one grounded retry.
- **Honest "not found":** weak evidence returns a not-found message instead of guessing.
- **Citations:** numbered inline `[1]` links to the exact passages (file, page).
- **Multi-provider failover:** Groq → OpenAI → Anthropic → Gemini, or pick one in the UI.
- **Persistent conversations, activity/audit log, admin stats, replace-on-reupload, file-type and size limits.**

## Notes / next steps
- Web search was left out on purpose so tenant questions never leave the platform; it can be added as an opt-in node.
- For production: use PostgreSQL instead of SQLite, serve over HTTPS, put the API behind a reverse proxy, and move the login-lockout counter to Redis.
- I haven't run the full stack end to end (the backend compiles; ML packages download on first run). If anything errors on first start, send me the traceback.
