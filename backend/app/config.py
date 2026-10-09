import os, secrets
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()  # local dev reads backend/.env; on Vercel env vars come from the dashboard

BASE = Path(__file__).resolve().parent.parent  # backend/

# Where local (SQLite) data lives. On Vercel the filesystem is read-only except
# /tmp, so we fall back to a temp directory there. Production MUST use
# DATABASE_URL (Postgres) — see README.
def _local_data_dir() -> Path:
    override = os.getenv("OMNIRAG_DATA_DIR")
    if override:
        p = Path(override); p.mkdir(parents=True, exist_ok=True); return p
    p = BASE / "data"
    try:
        p.mkdir(exist_ok=True)
        probe = p / ".write_test"
        probe.write_text("ok"); probe.unlink()
        return p
    except OSError:
        tmp = Path(os.getenv("TMPDIR") or "/tmp") / "omnirag"
        tmp.mkdir(parents=True, exist_ok=True)
        return tmp

DATA = _local_data_dir()
DB_PATH = DATA / "platform.db"          # used only when DATABASE_URL is unset
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()  # postgres://… or postgresql://…

JWT_SECRET = os.getenv("JWT_SECRET") or secrets.token_hex(32)  # random per run if unset (sessions reset on restart)
CORS = [o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",") if o.strip()]
ALLOW_ORG_SIGNUP = os.getenv("ALLOW_ORG_SIGNUP", "true").lower() == "true"
MIN_RERANK = float(os.getenv("MIN_RERANK_SCORE", "0.05"))

# Vercel Functions accept at most ~4.5 MB per request body.
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "4"))
ALLOWED_EXT = {".pdf", ".docx", ".pptx", ".txt", ".md", ".csv", ".json"}

KEYS = {p: os.getenv(f"{p.upper()}_API_KEY", "") for p in ("groq", "openai", "anthropic", "gemini")}
MODELS = {
    "groq": os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile"),
    "openai": os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
    "anthropic": os.getenv("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001"),
    "gemini": os.getenv("GEMINI_MODEL", "gemini-2.0-flash"),
}

# Embeddings (optional). With no embedding key the platform still works using
# BM25-only hybrid retrieval — see app/embeddings.py.
EMBED_PROVIDER = os.getenv("EMBED_PROVIDER", "auto").lower()   # auto | openai | gemini | none
EMBED_MODELS = {
    "openai": os.getenv("OPENAI_EMBED_MODEL", "text-embedding-3-small"),
    "gemini": os.getenv("GEMINI_EMBED_MODEL", "text-embedding-004"),
}

DEFAULT_DEPARTMENTS = [
    ("Engineering & Tech", "ENG"),
    ("Finance & Operations", "FIN"),
    ("Human Resources", "HR"),
    ("Legal & Compliance", "LEG"),
    ("Marketing & Sales", "MKT"),
]
