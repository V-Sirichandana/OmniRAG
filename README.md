# OmniRAG — Secure Multi-Tenant RAG Platform

Enterprise knowledge retrieval with **cross-department access control, strict
citations, and backend-enforced multi-tenancy**. Upload PDF/DOCX/PPTX/TXT
documents, index them, and ask questions — answers come back grounded with
numbered source citations, or a clear "not found" when the information isn't
in the documents you can access.

**Frontend:** Next.js 16 + TypeScript + Tailwind CSS 4 (`web/`)
**Backend:** FastAPI + LangGraph agentic RAG (`backend/`)
**Deploy:** Vercel Services (two services, one project) + persistent Postgres

---

## Features

- **Multi-tenant by design** — every organization has its own users,
  departments, documents, chats and audit trail. Isolation is enforced in
  SQL-level scoping on *every* backend endpoint, not just in the UI.
- **Roles & departments** — `admin` / `member` roles, five default departments
  seeded per org, plus custom departments.
- **Three document visibilities** — organization-wide, department-scoped, or
  restricted to an explicit user allowlist.
- **Full document lifecycle** — upload, extract, chunk, embed, index, list,
  download and delete for `.pdf .docx .pptx .txt .md .csv .json`.
- **Hybrid retrieval** — dense vectors (OpenAI/Gemini, when keyed) + BM25,
  fused with Reciprocal Rank Fusion; optional `flashrank` re-ranker for local
  runs. Degrades gracefully to BM25-only when no embedding key is present.
- **Agentic answering (LangGraph)** — plan → retrieve → answer → verify, with
  one grounded retry. Answers cite sources inline `[1]`, `[2]`, and say
  plainly when the sources don't contain the answer.
- **LLM failover** — Groq → OpenAI → Anthropic → Gemini.
- **Admin console** — employee directory, live role/department changes,
  Company Employee ID issuance (invitations), onboarding register, stats and
  audit trail.
- **Responsive premium dark UI** — centered login card, sidebar with per-user
  chat history, works on desktop and mobile.

## Architecture

```
browser ──► Next.js (web/)  ──/api rewrite──►  FastAPI (backend/)
   │              │                                  │
   │         React pages                      JWT auth · tenant scoping
   │         Tailwind UI                      extract · chunk · embed
   │                                          hybrid retrieve · rerank
   │                                          LangGraph plan/answer/verify
   │                                                  │
   └──────────────────────────────────────►   SQLite (local)
                                              Postgres (Vercel, DATABASE_URL)
                                              • users, departments, invites
                                              • documents (original bytes)
                                              • chunks (+ embeddings as JSON)
                                              • conversations, messages, audit
```

- **Local dev:** `next dev` proxies `/api/*` → `http://127.0.0.1:8000`
  (configurable via `API_ORIGIN`).
- **On Vercel:** `vercel.json` declares two services (`web` at `web/`,
  `api` at `backend/`) and rewrites `/api/(.*)` to the Python service, which
  receives the original path — so backend routes are plain `/api/...`.
- **No local state in production** — no SQLite, no upload folders, no
  in-memory stores. Document bytes and vectors live in the database.

## Repository structure

```
├── vercel.json           # Vercel Services config (web + api + rewrites)
├── web/                  # Next.js frontend
│   ├── app/              # routes: /login, /ask, /departments, /library, /admin
│   ├── components/       # sidebar, shared UI primitives
│   └── lib/              # typed API client, auth context, types
├── backend/              # FastAPI backend
│   ├── app/
│   │   ├── main.py       # all API endpoints
│   │   ├── security.py   # JWT, bcrypt, lockout, current_user
│   │   ├── db.py         # portable SQLite/Postgres layer + migrations
│   │   ├── rag.py        # extract/chunk/embed/hybrid-search
│   │   ├── embeddings.py # optional OpenAI/Gemini embeddings
│   │   ├── agent.py      # LangGraph planner/retriever/answerer/verifier
│   │   ├── llm.py        # provider failover
│   │   └── config.py     # env-driven configuration
│   ├── tests/test_api.py # 27 end-to-end API checks (no network needed)
│   ├── requirements.txt
│   └── .env.example      # copy to .env and fill in
└── legacy/               # original Vite prototype (superseded, kept for reference)
```

## Prerequisites

| Need | Why | Where to get it |
|------|-----|-----------------|
| Node.js 20+ & npm | frontend | https://nodejs.org |
| Python 3.10+ (3.12 on Vercel) | backend | https://python.org |
| **At least one LLM API key** | answer generation | https://console.groq.com (free tier) / OpenAI / Anthropic / Google AI |
| *(optional)* OpenAI or Gemini key | dense embeddings (hybrid retrieval) | same consoles — without it the app runs BM25-only |
| Vercel account | hosting | https://vercel.com |
| Postgres database | production persistence | Vercel Marketplace (Neon, Supabase, …) — *not* needed locally |
| *(optional)* `flashrank` | cross-encoder re-ranking, local only | `pip install flashrank` |

## Environment variables

Copy `backend/.env.example` → `backend/.env` and fill in. **Never commit
`.env`** (it is gitignored; the only secrets are on your machine / in Vercel's
encrypted dashboard).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `JWT_SECRET` | **yes (prod)** | dev fallback | HS256 signing key. Generate: `python -c "import secrets;print(secrets.token_hex(32))"` |
| `GROQ_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` | one of them | — | LLM providers, tried in that order |
| `GROQ_MODEL` `OPENAI_MODEL` `ANTHROPIC_MODEL` `GEMINI_MODEL` | no | sensible current models | Override provider models |
| `EMBED_PROVIDER` | no | `auto` | `auto` \| `openai` \| `gemini` \| `none` |
| `OPENAI_EMBED_MODEL` / `GEMINI_EMBED_MODEL` | no | `text-embedding-3-small` / `text-embedding-004` | Embedding models |
| `DATABASE_URL` | **yes (prod)** | — | `postgresql://…` — local dev falls back to SQLite in `backend/data/` |
| `CORS_ORIGINS` | prod | `http://localhost:3000` | Comma-separated allowed origins |
| `ALLOW_ORG_SIGNUP` | no | `true` | Set `false` to stop new organizations from self-registering |
| `MAX_UPLOAD_MB` | no | `4` | Vercel bodies cap at ~4.5 MB |
| `MIN_RERANK_SCORE` | no | `0.05` | Rerank keep-threshold (only when `flashrank` installed) |
| `API_ORIGIN` (web) | no | `http://127.0.0.1:8000` | Dev-only: where `next dev` proxies `/api` |
| `NEXT_PUBLIC_API_BASE` (web) | no | same-origin | Set only if API is hosted on a different origin |

## Local development

**Terminal 1 — backend:**

```powershell
cd backend
python -m venv .venv
.venv\Scripts\activate          # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env          # then add at least one LLM key
python -m uvicorn app.main:app --reload --port 8000
```

**Terminal 2 — frontend:**

```powershell
cd web
npm install
npm run dev
```

Open **http://localhost:3000** → *Create Organization* tab → create your org
(admin account) → upload a document in **Document Library** → ask questions in
**Ask Documents**.

Run the API test suite (isolated temp DB, no network, no keys needed):

```powershell
cd backend
python tests/test_api.py        # 27/27: auth, tenant isolation, ACL, retrieval, admin…
```

## Deploying to Vercel

1. **Push this repo to GitHub** (this machine has local commits only — push
   yourself if you want).
2. **Import** the repo in the Vercel dashboard (or `vercel link`). The root
   `vercel.json` already declares both services; no settings needed.
3. **Provision Postgres** — Vercel Marketplace → Neon/Supabase/etc. Copy the
   connection string.
4. **Set environment variables** for the project (Project → Settings →
   Environment Variables):
   - `DATABASE_URL` (from step 3)
   - `JWT_SECRET` (long random hex)
   - `CORS_ORIGINS=https://<your-project>.vercel.app`
   - your LLM key(s); embedding key if you want dense retrieval
5. **Deploy:** `vercel --prod` (or the dashboard's Deploy button).

> The Python service uses Python 3.12 and a 60s max function duration.
> SQLite is used only locally — the deployed app reads/writes Postgres
> through `DATABASE_URL`.

## Security model

- Passwords hashed with bcrypt; JWT (HS256) bearer tokens; account lockout
  after repeated failed logins.
- **Every** list/get/delete/search/conversation endpoint filters by the
  caller's `tenant_id` from the (verified) token — cross-tenant access returns
  404 or empty, never data.
- Document visibility (`org` / `department` / `restricted` allowlist) is
  applied inside the retrieval query itself, so answers can never cite a
  document the asker can't access.
- Admin endpoints re-check `role == "admin"` server-side; admins can't
  demote/delete themselves.
- No demo/hardcoded credentials anywhere; organizations self-serve. Secrets
  live only in environment variables.

## API overview

| Area | Endpoints |
|------|-----------|
| Auth | `POST /api/auth/signup-org`, `POST /api/auth/login`, `POST /api/auth/register` (employee ID), `GET /api/auth/me` |
| Departments | `GET/POST /api/departments`, `DELETE /api/departments/{id}` |
| Documents | `GET/POST /api/documents` (multipart), `GET /api/documents/{id}/download`, `DELETE /api/documents/{id}` |
| Chat | `POST /api/chat`, `GET /api/conversations`, `GET /api/conversations/{id}` |
| Search | `POST /api/search` (retrieval with citations, no LLM) |
| Admin | `GET /api/admin/stats`, `GET /api/admin/users`, `PATCH/DELETE /api/admin/users/{id}`, `POST/GET /api/admin/invites`, `GET /api/admin/audit` |
| Meta | `GET /api/health`, `GET /api/providers`, `GET /api/docs` |

## Known limits

- Uploads are capped at **4 MB** (`MAX_UPLOAD_MB`) because of Vercel's ~4.5 MB
  request-body limit.
- No OCR — scanned image-only PDFs are rejected with a clear message.
- `flashrank` re-ranking is opt-in (`pip install flashrank`) since it
  downloads ML models at runtime, which serverless can't do.

## Legacy prototype

`legacy/` contains the original Vite + React prototype (including the first
static UI mockup). It is **not** used by the current app — kept only for
reference.
