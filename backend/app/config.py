import os, secrets
from pathlib import Path
from dotenv import load_dotenv
load_dotenv()
BASE = Path(__file__).resolve().parent.parent
DATA = BASE / "data"; DATA.mkdir(exist_ok=True)
DB_PATH = DATA / "platform.db"
CHROMA_DIR = str(DATA / "chroma")
JWT_SECRET = os.getenv("JWT_SECRET") or secrets.token_hex(32)  # random per run if unset (sessions reset on restart)
CORS = [o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")]
ALLOW_ORG_SIGNUP = os.getenv("ALLOW_ORG_SIGNUP", "true").lower() == "true"
MIN_RERANK = float(os.getenv("MIN_RERANK_SCORE", "0.05"))
MAX_UPLOAD_MB = 25
ALLOWED_EXT = {".pdf", ".docx", ".pptx", ".txt", ".md", ".csv"}
KEYS = {p: os.getenv(f"{p.upper()}_API_KEY", "") for p in ("groq", "openai", "anthropic", "gemini")}
MODELS = {
    "groq": os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile"),
    "openai": os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
    "anthropic": os.getenv("ANTHROPIC_MODEL", "claude-haiku-4-5-20251001"),
    "gemini": os.getenv("GEMINI_MODEL", "gemini-2.0-flash"),
}
