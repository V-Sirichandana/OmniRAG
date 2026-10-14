"""Portable database layer.

Production (Vercel) uses PostgreSQL via DATABASE_URL — persistent across
deployments. Local development falls back to a SQLite file so the app runs
with zero external services. All SQL is written in the common subset of both
dialects; only the connection setup and the `messages.id` primary key differ.
"""
import hashlib, json, sqlite3, uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from .config import DB_PATH, DATABASE_URL, DEFAULT_DEPARTMENTS

PG = DATABASE_URL.startswith(("postgres://", "postgresql://"))

# ---------------------------------------------------------------------------
# Connections
# ---------------------------------------------------------------------------
if PG:
    import psycopg

    def _connect():
        conn = psycopg.connect(DATABASE_URL, connect_timeout=10)
        conn.autocommit = False
        return conn
else:
    def _connect():
        c = sqlite3.connect(DB_PATH)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys=ON")
        return c


class _Cursor:
    """Tiny wrapper so the rest of the code can use `?` placeholders everywhere.

    SQLite understands `?` natively; psycopg uses `%s`, so we translate here
    (our statements never contain a literal `?`). Rows behave like sqlite3.Row:
    index by column name, `.keys()`, and `dict(row)` all work.
    """

    def __init__(self, cur, pg: bool):
        self._cur, self._pg = cur, pg

    def execute(self, sql, params=()):
        if self._pg:
            sql = sql.replace("?", "%s")
        self._cur.execute(sql, tuple(params))
        return self

    def executemany(self, sql, seq):
        if self._pg:
            sql = sql.replace("?", "%s")
        self._cur.executemany(sql, [tuple(p) for p in seq])
        return self

    def fetchone(self):
        return self._cur.fetchone()

    def fetchall(self):
        return self._cur.fetchall()

    def __iter__(self):
        """Iterate rows directly (matches sqlite3.Cursor behaviour)."""
        return iter(self._cur.fetchall())

    @property
    def rowcount(self):
        return self._cur.rowcount


@contextmanager
def db():
    """One transaction per call: commit on success, rollback on error."""
    conn = _connect()
    cur = _Cursor(conn.cursor(), PG)
    try:
        yield cur
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------
_M_ID = "BIGSERIAL PRIMARY KEY" if PG else "INTEGER PRIMARY KEY AUTOINCREMENT"
_BLOB = "BYTEA" if PG else "BLOB"

SCHEMA = f"""
CREATE TABLE IF NOT EXISTS tenants(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, pw_hash TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  department TEXT NOT NULL DEFAULT 'General',
  employee_id TEXT,
  is_manager INTEGER NOT NULL DEFAULT 0,
  created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS invites(
  code TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member', department TEXT NOT NULL DEFAULT '',
  created_by TEXT, expires TEXT NOT NULL, used_by TEXT);
CREATE TABLE IF NOT EXISTS departments(
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL, code TEXT NOT NULL DEFAULT '', created TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(tenant_id, name));
CREATE TABLE IF NOT EXISTS documents(
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  filename TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'org',
  department TEXT NOT NULL DEFAULT '',
  uploaded_by TEXT NOT NULL, chunks INTEGER DEFAULT 0,
  content {_BLOB},
  created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS doc_acl(
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL, PRIMARY KEY(doc_id, user_id));
CREATE TABLE IF NOT EXISTS doc_departments(
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  dept_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  PRIMARY KEY(doc_id, dept_id));
CREATE TABLE IF NOT EXISTS chunks(
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page INTEGER NOT NULL DEFAULT 1, text TEXT NOT NULL, embedding TEXT,
  created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS conversations(
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, tenant_id TEXT NOT NULL, title TEXT,
  created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS messages(
  id {_M_ID}, conv_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL, content TEXT NOT NULL, meta TEXT, created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS audit(
  id {_M_ID}, tenant_id TEXT, user_id TEXT, action TEXT, detail TEXT,
  created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS query_log(
  id TEXT PRIMARY KEY, ts TEXT NOT NULL,
  tenant_id TEXT, user_id TEXT, question_sha256 TEXT,
  n_hits INTEGER, retries INTEGER, sufficiency REAL,
  abstained INTEGER, abstain_reason TEXT,
  grounded INTEGER, score INTEGER,
  provider TEXT, latency_ms INTEGER, trace TEXT);
CREATE INDEX IF NOT EXISTS idx_documents_tenant ON documents(tenant_id);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);
CREATE INDEX IF NOT EXISTS idx_chunks_tenant ON chunks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id);
"""

# Columns added after the first release (idempotent migration for old local DBs).
_MIGRATIONS = [
    ("users", "department", "TEXT NOT NULL DEFAULT 'General'"),
    ("users", "employee_id", "TEXT"),
    ("invites", "department", "TEXT NOT NULL DEFAULT ''"),
    ("documents", "department", "TEXT NOT NULL DEFAULT ''"),
    ("documents", "content", "BYTEA" if PG else "BLOB"),
    ("documents", "download_allowed", "INTEGER NOT NULL DEFAULT 1"),
    # Manager designation: a UI/workspace gate only — grants no extra data,
    # document or user-management privileges (default 0 for existing users).
    ("users", "is_manager", "INTEGER NOT NULL DEFAULT 0"),
]


def _has_column(cur, table, column) -> bool:
    if PG:
        row = cur.execute(
            "SELECT 1 FROM information_schema.columns WHERE table_name=? AND column_name=?",
            (table, column),
        ).fetchone()
        return row is not None
    rows = cur.execute(f"PRAGMA table_info({table})").fetchall()
    return any(r[1] == column for r in rows)


def init():
    with db() as c:
        # Run the schema statement-by-statement (works on both dialects).
        for stmt in [s.strip() for s in SCHEMA.split(";") if s.strip()]:
            c.execute(stmt)
        for table, column, decl in _MIGRATIONS:
            if not _has_column(c, table, column):
                c.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
        # Existing tenants (from older local databases) get default departments too.
        for r in c.execute("SELECT id FROM tenants").fetchall():
            seed_departments(c, r["id"])


def uid(): return uuid.uuid4().hex


def seed_departments(cur, tenant_id: str):
    """Give a tenant the standard five departments (idempotent)."""
    for name, code in DEFAULT_DEPARTMENTS:
        if not cur.execute("SELECT 1 FROM departments WHERE tenant_id=? AND name=?",
                           (tenant_id, name)).fetchone():
            cur.execute("INSERT INTO departments(id,tenant_id,name,code) VALUES(?,?,?,?)",
                        (uid(), tenant_id, name, code))


def audit(tenant_id, user_id, action, detail=""):
    with db() as c:
        c.execute(
            "INSERT INTO audit(tenant_id,user_id,action,detail) VALUES(?,?,?,?)",
            (tenant_id, user_id, action, detail[:300]),
        )


def log_query(tenant_id, user_id, question, outcome: dict, latency_ms: int) -> str:
    """Privacy-preserving retrieval telemetry (research evaluation).

    Only outcome statistics are stored: the question is recorded as a SHA-256
    digest (never raw text), and no chunk text, answers, API keys or document
    contents ever reach this table. Used to measure retries, abstentions,
    verification outcomes and latency.
    """
    qid = uid()
    with db() as c:
        c.execute(
            "INSERT INTO query_log(id,ts,tenant_id,user_id,question_sha256,n_hits,retries,"
            "sufficiency,abstained,abstain_reason,grounded,score,provider,latency_ms,trace)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (qid, datetime.now(timezone.utc).isoformat(timespec="seconds"),
             tenant_id, user_id,
             hashlib.sha256(question.encode("utf-8")).hexdigest(),
             outcome.get("n_hits"), outcome.get("retries"), outcome.get("sufficiency"),
             1 if outcome.get("abstained") else 0, outcome.get("abstain_reason") or "",
             None if outcome.get("grounded") is None else int(outcome["grounded"]),
             outcome.get("score"), outcome.get("provider") or "", latency_ms,
             json.dumps(outcome.get("trace") or [])[:2000]),
        )
    return qid
