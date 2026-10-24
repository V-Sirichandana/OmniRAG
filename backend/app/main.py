"""OmniRAG FastAPI application.

All endpoints are tenant-scoped: every query filters by the caller's
`tenant_id`, so one organization can never read, modify or delete another
organization's documents, conversations or users. Department visibility is
enforced here (server-side), never only in the UI.
"""
import json, mimetypes, os, secrets, string, time, csv, io
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

from . import agent, authz, db as D, embeddings as E, llm, rag, security as S
from .config import ALLOW_ORG_SIGNUP, ALLOWED_EXT, CORS, DATABASE_URL, MAX_UPLOAD_MB


@asynccontextmanager
async def lifespan(_app: FastAPI):
    D.init()          # create/migrate schema on startup (both SQLite and Postgres)
    # Production safety: never let the ephemeral /tmp SQLite fallback pass
    # silently for a live deployment — data would vanish on every cold start.
    if os.getenv("VERCEL") and not DATABASE_URL:
        print("WARNING: running on Vercel without DATABASE_URL — using ephemeral "
              "/tmp storage, ALL data is lost on every cold start. Set DATABASE_URL "
              "(Postgres, e.g. Neon) in the project environment variables.", flush=True)
    yield


app = FastAPI(title="OmniRAG API", version="2.1", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=CORS, allow_methods=["*"], allow_headers=["*"])


# ── Auth ────────────────────────────────────────────────────────────────────
class Login(BaseModel):
    # `username` is the login identifier: an existing account name, or (Stage A)
    # the account's work email — same field name, so old clients stay valid.
    username: str
    password: str

class Register(BaseModel):
    username: str = Field(min_length=3, max_length=40)
    password: str = Field(min_length=8, max_length=100)
    invite_code: str

class OrgSignup(BaseModel):
    org_name: str = Field(min_length=2, max_length=80)
    username: str = Field(min_length=3, max_length=40)
    password: str = Field(min_length=8, max_length=100)
    # Optional work email for the creating admin; never required (old clients).
    email: str | None = None


def _norm_email(v) -> str | None:
    """Normalize a work email for storage: trim + lowercase, or None if empty.

    Stage A identity only — no delivery, no verification. Emails are stored
    normalized so the partial UNIQUE index in db.py is a plain column
    comparison on both SQLite and PostgreSQL; malformed values are rejected
    with 400 before anything is written.
    """
    if v is None:
        return None
    e = str(v).strip().lower()
    if not e:
        return None
    if len(e) > 254 or e.count("@") != 1 or any(ch.isspace() for ch in e):
        raise HTTPException(400, "Invalid email address")
    local, domain = e.split("@")
    if not local or not domain:
        raise HTTPException(400, "Invalid email address")
    return e


def _norm_date(v) -> str | None:
    """Normalize an agreement date to ISO YYYY-MM-DD, or None if empty.

    Raises 400 on malformed values. Uses datetime.date.fromisoformat (Python 3.7+).
    """
    if v is None:
        return None
    s = str(v).strip()
    if not s:
        return None
    try:
        from datetime import date
        d = date.fromisoformat(s)
    except ValueError:
        raise HTTPException(400, "Invalid date (expected YYYY-MM-DD)")
    return d.isoformat()


def _agreement_status(emp_type, start, end) -> str:
    """Derive Active / Expiring Soon / Expired from agreement_end (if any)."""
    if not end:
        return "Active"
    try:
        from datetime import date, timedelta
        e = date.fromisoformat(end)
    except ValueError:
        return "Active"
    today = date.today()
    if e < today:
        return "Expired"
    if e <= today + timedelta(days=30):
        return "Expiring Soon"
    return "Active"


def _norm_username(v) -> str:
    """Normalize a NEW username on both username-write paths (signup, register).

    Keeps the pre-existing rules — trim, lowercase, 3-40 characters — and adds
    the cross-column race fix: usernames may not contain '@'. Every work email
    must contain exactly one '@' (see _norm_email), so the two identifier kinds
    can never be equal: no check against other rows is needed, hence nothing to
    race against on either database. Existing accounts with '@'-usernames are
    untouched — this never runs on login/session/read paths, and no
    username-update path exists. Limitation: application-level only — raw SQL
    can still insert an '@'-username (no DB trigger in this pass).
    """
    name = str(v).strip().lower()
    if "@" in name:
        raise HTTPException(400, "Username must not contain '@'")
    if not 3 <= len(name) <= 40:
        raise HTTPException(400, "Username must be 3-40 characters")
    return name


def _assert_email_available(c, email: str | None, user_id: str | None = None):
    """R1: an email may never equal ANOTHER account's identifier.

    Beyond email-vs-email uniqueness, an email equal to someone else's username
    (e.g. 'bob@corp') would let login's email-first resolution shadow that
    account, so it is rejected with a distinct message. `user_id` excludes the
    caller, so an account may keep (or re-normalize) its own values. Used by
    both email write paths and by the race classifier in the IntegrityError
    handlers below.
    """
    if not email:
        return
    excl, args = ("", (email,)) if not user_id else (" AND id<>?", (email, user_id))
    if c.execute(f"SELECT 1 FROM users WHERE email=?{excl}", args).fetchone():
        raise HTTPException(409, "Email already in use")
    if c.execute(f"SELECT 1 FROM users WHERE username=?{excl}", args).fetchone():
        raise HTTPException(409, "Email conflicts with an existing username")


def _session(user_id):
    with D.db() as c:
        r = c.execute(
            "SELECT u.id,u.username,u.email,u.role,u.tenant_id,u.department,"
            "u.employee_id,u.is_manager,t.name AS tenant_name "
            "FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.id=?", (user_id,)).fetchone()
    return {"token": S.make_token(user_id), "user": dict(r)}


@app.post("/api/auth/login")
def login(b: Login):
    name = b.username.strip().lower(); S.check_lock(name)
    with D.db() as c:
        r = None
        if "@" in name:
            # Work-email login: the normalized email wins over any legacy
            # username that happens to look like one; plain usernames keep
            # the exact pre-Stage-A query (unknown emails fall back to it).
            r = c.execute("SELECT * FROM users WHERE email=?", (name,)).fetchone()
        if r is None:
            r = c.execute("SELECT * FROM users WHERE username=?", (name,)).fetchone()
    if not r or not S.check_pw(b.password, r["pw_hash"]):
        S.record_fail(name); raise HTTPException(401, "Invalid username or password")
    S.clear_fail(name); D.audit(r["tenant_id"], r["id"], "login")
    return _session(r["id"])


@app.post("/api/auth/signup-org")
def signup_org(b: OrgSignup):
    if not ALLOW_ORG_SIGNUP:
        raise HTTPException(403, "Organization sign-up is disabled")
    name, email = _norm_username(b.username), _norm_email(b.email)
    tid, uid = D.uid(), D.uid()
    try:
        with D.db() as c:
            if c.execute("SELECT 1 FROM users WHERE username=?", (name,)).fetchone():
                raise HTTPException(409, "Username already taken")
            # R1: emails are globally unique AND may not shadow any username.
            _assert_email_available(c, email)
            c.execute("INSERT INTO tenants(id,name) VALUES(?,?)", (tid, b.org_name.strip()))
            c.execute(
                "INSERT INTO users(id,username,email,pw_hash,tenant_id,role,department,employee_id) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (uid, name, email, S.hash_pw(b.password), tid, "admin", "General", "ORG-ADMIN"))
            D.seed_departments(c, tid)      # standard five departments for the new org
    except D.IntegrityError as e:
        # R3: lost a uniqueness race. Classify in a FRESH transaction (a failed
        # statement poisons the current one on PostgreSQL) and answer 409 with
        # the precise reason — never a 500. The rollback above already removed
        # the half-created tenant, so nothing partial survives.
        with D.db() as c:
            _assert_email_available(c, email)      # -> 409 (email or username clash)
            if c.execute("SELECT 1 FROM users WHERE username=?", (name,)).fetchone():
                raise HTTPException(409, "Username already taken")
        raise e                                     # not a uniqueness race: surface it
    D.audit(tid, uid, "org_created", b.org_name)
    return _session(uid)


@app.post("/api/auth/register")
def register(b: Register):
    """Join an existing organization with a company-issued Employee ID."""
    name, uid = _norm_username(b.username), D.uid()
    code = b.invite_code.strip()
    try:
        with D.db() as c:
            inv = c.execute("SELECT * FROM invites WHERE code=?", (code,)).fetchone()
            if not inv or inv["used_by"] or inv["expires"] < datetime.now(timezone.utc).isoformat():
                raise HTTPException(400, "Employee ID is invalid or expired")
            if c.execute("SELECT 1 FROM users WHERE username=?", (name,)).fetchone():
                raise HTTPException(409, "Username already taken")
            dept = inv["department"] or "General"
            # Claim the code first: the UPDATE only succeeds while it is still
            # unused, so one Employee ID can never create two accounts even
            # under concurrent registrations (raising here rolls the claim back).
            if c.execute("UPDATE invites SET used_by=? WHERE code=? AND used_by IS NULL",
                         (uid, code)).rowcount != 1:
                raise HTTPException(400, "Employee ID is invalid or expired")
            c.execute(
                "INSERT INTO users(id,username,pw_hash,tenant_id,role,department,employee_id,"
                "full_name,email,employment_type,agreement_start,agreement_end) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (uid, name, S.hash_pw(b.password), inv["tenant_id"], inv["role"], dept, code,
                 inv["full_name"], inv["email"], inv["employment_type"] or "full_time",
                 inv["agreement_start"], inv["agreement_end"]))
    except D.IntegrityError:
        # Lost a uniqueness race on username: classify as 409, never a raw 500.
        with D.db() as c:
            if c.execute("SELECT 1 FROM users WHERE username=?", (name,)).fetchone():
                raise HTTPException(409, "Username already taken")
        raise
    D.audit(inv["tenant_id"], uid, "user_joined", f"{name} ({dept})")
    return _session(uid)


@app.get("/api/auth/me")
def me(u=Depends(S.current_user)):
    return u


@app.get("/api/providers")
def providers(u=Depends(S.current_user)):
    # vectors_stored: do ANY chunks actually have vectors? embeddings=true only
    # means a key is configured — it says nothing about indexed vectors (docs
    # uploaded before the key was set are BM25-only until backfilled via
    # rag.backfill_embeddings). Authenticated-only: avoids an unauthenticated
    # scan and never exposes counts, just a boolean per caller's own tenant.
    with D.db() as c:
        has_vectors = c.execute(
            "SELECT 1 FROM chunks WHERE tenant_id=? AND embedding IS NOT NULL LIMIT 1",
            (u["tenant_id"],)).fetchone() is not None
    return {"llm": llm.available(), "embeddings": E.available(),
            "vectors_stored": has_vectors}


# ── Documents (admin writes; reads are scope- and ACL-filtered via authz) ───
# The authorization rules live in app/authz.py — one consistent service used
# by listing, retrieval, chat context, citations, download, delete and ACL
# changes alike.


@app.get("/api/documents")
def list_docs(u=Depends(S.current_user)):
    ids = authz.visible_doc_ids(u)
    if not ids:
        return []
    with D.db() as c:
        docs = [dict(r) for r in c.execute(
            f"""SELECT d.id,d.filename,d.visibility,d.department,d.chunks,d.created,
                       d.download_allowed,
                       COALESCE(us.username,'removed user') AS uploaded_by
                FROM documents d LEFT JOIN users us ON us.id=d.uploaded_by
                WHERE d.id IN ({','.join('?' * len(ids))})
                ORDER BY d.created DESC""", ids)]
        for d in docs:
            d["download_allowed"] = bool(d["download_allowed"])
        # selected-department targets, resolved to real names for display
        sel = [d["id"] for d in docs if d["visibility"] == "selected_departments"]
        if sel:
            targets: dict[str, list] = {i: [] for i in sel}
            for r in c.execute(
                    f"""SELECT dd.doc_id,dp.id,dp.name FROM doc_departments dd
                        JOIN departments dp ON dp.id=dd.dept_id
                        WHERE dd.doc_id IN ({','.join('?' * len(sel))})""", sel):
                targets[r["doc_id"]].append({"id": r["id"], "name": r["name"]})
            for d in docs:
                if d["visibility"] == "selected_departments":
                    d["departments"] = targets.get(d["id"], [])
        if u["role"] == "admin":
            for d in docs:
                d["allowed_user_ids"] = [r["user_id"] for r in
                                         c.execute("SELECT user_id FROM doc_acl WHERE doc_id=?", (d["id"],))]
    return docs


@app.get("/api/documents/{doc_id}/download")
def download_doc(doc_id: str, u=Depends(S.current_user)):
    if doc_id not in authz.visible_doc_ids(u):
        raise HTTPException(404, "Document not found")
    if not authz.can_download(u, doc_id):
        raise HTTPException(403, "Downloads are not permitted for this document")
    with D.db() as c:
        r = c.execute("SELECT filename,content FROM documents WHERE id=? AND tenant_id=?",
                      (doc_id, u["tenant_id"])).fetchone()
    if not r or r["content"] is None:
        raise HTTPException(404, "File content not stored for this document")
    D.audit(u["tenant_id"], u["id"], "doc_downloaded", r["filename"])
    data = bytes(r["content"])
    media = mimetypes.guess_type(r["filename"])[0] or "application/octet-stream"
    # stored filenames are user-supplied: quotes/CRLF would corrupt (or inject
    # into) the header, so neutralize them before building the response
    safe = (r["filename"].replace('"', "_").replace("\r", "").replace("\n", "").strip()
            or "download")
    return Response(data, media_type=media, headers={
        "Content-Disposition": f'attachment; filename="{safe}"'})


def _resolve_acl_users(c, tenant_id, user_ids):
    """Validate ACL grant targets against the caller's organization (400 on foreign/unknown)."""
    out = []
    for uid in [x for x in user_ids if x]:
        if not c.execute("SELECT 1 FROM users WHERE id=? AND tenant_id=?", (uid, tenant_id)).fetchone():
            raise HTTPException(400, "Unknown user (must belong to your organization)")
        out.append(uid)
    return out


def _set_acl(c, doc_id, tenant_id, user_ids):
    c.execute("DELETE FROM doc_acl WHERE doc_id=?", (doc_id,))
    for uid in _resolve_acl_users(c, tenant_id, user_ids):
        c.execute("INSERT INTO doc_acl(doc_id,user_id) VALUES(?,?)", (doc_id, uid))


def _assert_dept_targets(c, tenant_id, dept_ids):
    """Every id must be a real department of the caller's organization (400)."""
    for did in dept_ids:
        if not c.execute("SELECT 1 FROM departments WHERE id=? AND tenant_id=?",
                         (did, tenant_id)).fetchone():
            raise HTTPException(400, "Unknown department (must belong to your organization)")


def _set_doc_departments(c, doc_id, tenant_id, dept_ids):
    """Persist selected-department targets; every id must be a real department
    of the caller's own organization."""
    c.execute("DELETE FROM doc_departments WHERE doc_id=?", (doc_id,))
    _assert_dept_targets(c, tenant_id, dept_ids)
    for did in dept_ids:
        c.execute("INSERT INTO doc_departments(doc_id,dept_id) VALUES(?,?)", (doc_id, did))


VISIBILITIES = ("org", "department", "organization", "selected_departments", "restricted")


def _norm_bool(v: str, default=True) -> bool:
    if v is None or str(v).strip() == "":
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "on")


@app.post("/api/documents")
async def upload(
    file: UploadFile = File(...),
    visibility: str = Form("org"),
    department: str = Form(""),
    department_ids: str = Form(""),
    allowed_user_ids: str = Form(""),
    download_allowed: str = Form("true"),
    u=Depends(S.admin_user),
):
    name = os.path.basename(file.filename or "file")
    if os.path.splitext(name)[1].lower() not in ALLOWED_EXT:
        raise HTTPException(400, f"Unsupported type. Allowed: {', '.join(sorted(ALLOWED_EXT))}")
    if visibility not in VISIBILITIES:
        raise HTTPException(400, f"visibility must be one of {', '.join(VISIBILITIES)}")
    # legacy alias: "org" keeps its historical (department-scoped) meaning so
    # existing API callers and old documents are unaffected.
    visibility = "department" if visibility == "org" else visibility
    dept_ids = [x for x in department_ids.split(",") if x.strip()]
    if visibility == "selected_departments" and not dept_ids:
        raise HTTPException(400, "selected_departments requires at least one department id")
    # company-wide and multi-department documents belong to no single department
    if visibility in ("organization", "selected_departments"):
        department = ""
    else:
        department = department.strip() or (u.get("department") or "").strip() or "General"
    # Validate every ACL/department target BEFORE ingesting or replacing
    # anything: an unknown user/department must never cost the previous version
    # of the file or leave a half-ingested document behind.
    with D.db() as c:
        if visibility == "restricted":
            _resolve_acl_users(c, u["tenant_id"],
                               [x for x in allowed_user_ids.split(",") if x])
        if visibility == "selected_departments":
            _assert_dept_targets(c, u["tenant_id"], [x.strip() for x in dept_ids])
    # Read at most one byte past the limit so an oversized upload is rejected
    # with 413 BEFORE the whole body is buffered in memory.
    data = await file.read(MAX_UPLOAD_MB * 1024 * 1024 + 1)
    if len(data) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, f"File exceeds {MAX_UPLOAD_MB} MB")

    doc_id = D.uid()
    # Stage the document row first: chunks reference documents(id) via foreign
    # key, so the parent row must exist before ingestion inserts its chunks.
    with D.db() as c:
        c.execute(
            "INSERT INTO documents(id,tenant_id,filename,visibility,department,uploaded_by,"
            "chunks,content,download_allowed) VALUES(?,?,?,?,?,?,?,?,?)",
            (doc_id, u["tenant_id"], name, visibility, department, u["id"], 0, data,
             1 if _norm_bool(download_allowed) else 0))

    def _unstage():
        """Remove the staged row if extraction/ingestion failed."""
        rag.delete_doc(u["tenant_id"], doc_id)
        with D.db() as c:
            c.execute("DELETE FROM documents WHERE id=?", (doc_id,))

    try:
        n = rag.ingest(u["tenant_id"], doc_id, name, data)
        if n == 0:
            raise ValueError("No extractable text found (scanned PDFs need OCR)")
    except Exception as e:
        _unstage()
        if isinstance(e, ValueError):
            raise HTTPException(422, str(e))
        raise HTTPException(422, f"Could not read file: {e}")

    with D.db() as c:
        c.execute("UPDATE documents SET chunks=? WHERE id=?", (n, doc_id))
        if visibility == "restricted":
            _set_acl(c, doc_id, u["tenant_id"],
                     [x for x in allowed_user_ids.split(",") if x])
        if visibility == "selected_departments":
            _set_doc_departments(c, doc_id, u["tenant_id"], [x.strip() for x in dept_ids])
    # Replacing a same-name predecessor is the LAST step — the new version is
    # fully ingested and its ACL is set by now, so a rejected upload
    # (extraction, validation, size) can never destroy the file it replaces.
    with D.db() as c:
        for old in c.execute("SELECT id FROM documents WHERE tenant_id=? AND filename=?",
                             (u["tenant_id"], name)).fetchall():
            if old["id"] == doc_id:
                continue
            rag.delete_doc(u["tenant_id"], old["id"])
            c.execute("DELETE FROM documents WHERE id=?", (old["id"],))
    D.audit(u["tenant_id"], u["id"], "doc_uploaded",
            f"{name} ({visibility}{':' + department if department else ''})")
    return {"id": doc_id, "filename": name, "chunks": n, "visibility": visibility,
            "department": department,
            "download_allowed": _norm_bool(download_allowed),
            "department_ids": [x.strip() for x in dept_ids] if visibility == "selected_departments" else []}


class Acl(BaseModel):
    visibility: str
    allowed_user_ids: list[str] = []
    department_ids: list[str] = []
    download_allowed: bool = True


@app.patch("/api/documents/{doc_id}/access")
def set_access(doc_id: str, b: Acl, u=Depends(S.admin_user)):
    """Organization admin grants/revokes document permissions: visibility
    scope, per-user grants (restricted) and the download permission."""
    if b.visibility not in VISIBILITIES:
        raise HTTPException(400, f"visibility must be one of {', '.join(VISIBILITIES)}")
    visibility = "department" if b.visibility == "org" else b.visibility
    if visibility == "selected_departments" and not b.department_ids:
        raise HTTPException(400, "selected_departments requires at least one department id")
    # admins manage their whole organization, so the scope check covers every
    # org document; other tenants' ids simply 404
    if doc_id not in authz.visible_doc_ids(u):
        raise HTTPException(404, "Document not found")
    with D.db() as c:
        cur = c.execute("SELECT department FROM documents WHERE id=?", (doc_id,)).fetchone()
        dept = (cur["department"] if cur else "") or ""
        if visibility == "department":
            # Members only ever see documents whose stored department matches
            # theirs (authz.py). A document uploaded organization-wide stores
            # no department, so applying "department" scope here would report
            # ok while hiding it from every member — reject instead.
            if not dept:
                raise HTTPException(400, "This document has no department; upload it with a "
                                        "department before scoping it to one")
            if not c.execute("SELECT 1 FROM departments WHERE name=? AND tenant_id=?",
                             (dept, u["tenant_id"])).fetchone():
                raise HTTPException(400, f"Department '{dept}' no longer exists; pick another scope")
        c.execute("UPDATE documents SET visibility=?, download_allowed=? WHERE id=?",
                  (visibility, 1 if b.download_allowed else 0, doc_id))
        _set_acl(c, doc_id, u["tenant_id"], b.allowed_user_ids if visibility == "restricted" else [])
        _set_doc_departments(c, doc_id, u["tenant_id"],
                             b.department_ids if visibility == "selected_departments" else [])
    D.audit(u["tenant_id"], u["id"], "doc_access_changed",
            f"{doc_id}→{visibility} download={'on' if b.download_allowed else 'off'}")
    return {"ok": True}


@app.delete("/api/documents/{doc_id}")
def delete_doc(doc_id: str, u=Depends(S.admin_user)):
    # documents outside the caller's own organization behave exactly like
    # missing documents (404, never a leak)
    if doc_id not in authz.visible_doc_ids(u):
        raise HTTPException(404, "Document not found")
    with D.db() as c:
        r = c.execute("SELECT filename FROM documents WHERE id=? AND tenant_id=?",
                      (doc_id, u["tenant_id"])).fetchone()
        if not r:
            raise HTTPException(404, "Document not found")
        c.execute("DELETE FROM documents WHERE id=?", (doc_id,))
    rag.delete_doc(u["tenant_id"], doc_id)
    D.audit(u["tenant_id"], u["id"], "doc_deleted", r["filename"])
    return {"ok": True}


# ── Departments (tenant-scoped) ─────────────────────────────────────────────
class DeptIn(BaseModel):
    name: str = Field(min_length=2, max_length=60)
    code: str = Field(default="", max_length=10)


@app.get("/api/departments")
def list_departments(u=Depends(S.current_user)):
    with D.db() as c:
        rows = c.execute(
            """SELECT d.id,d.name,d.code,d.created,
                      (SELECT COUNT(*) FROM documents WHERE tenant_id=d.tenant_id
                         AND department=d.name) +
                      (SELECT COUNT(*) FROM doc_departments dd WHERE dd.dept_id=d.id)
                        AS documents,
                      (SELECT COUNT(*) FROM users WHERE tenant_id=d.tenant_id AND department=d.name) AS members
               FROM departments d WHERE d.tenant_id=? ORDER BY d.name""", (u["tenant_id"],)).fetchall()
    out = [dict(r) for r in rows]
    # Members only ever see their own department (admins manage them all).
    if u["role"] != "admin":
        mine = (u.get("department") or "").strip()
        out = [d for d in out if d["name"] == mine]
    return out


@app.post("/api/departments")
def create_department(b: DeptIn, u=Depends(S.admin_user)):
    name = b.name.strip()
    with D.db() as c:
        if c.execute("SELECT 1 FROM departments WHERE tenant_id=? AND name=?",
                     (u["tenant_id"], name)).fetchone():
            raise HTTPException(409, "Department already exists")
        did = D.uid()
        try:
            c.execute("INSERT INTO departments(id,tenant_id,name,code) VALUES(?,?,?,?)",
                      (did, u["tenant_id"], name, (b.code.strip() or name[:3].upper())))
        except D.IntegrityError:
            # lost a uniqueness race on (tenant_id, name) — 409, never a 500
            raise HTTPException(409, "Department already exists")
    D.audit(u["tenant_id"], u["id"], "dept_created", name)
    return {"id": did, "name": name}


@app.delete("/api/departments/{dept_id}")
def delete_department(dept_id: str, u=Depends(S.admin_user)):
    with D.db() as c:
        r = c.execute("SELECT name FROM departments WHERE id=? AND tenant_id=?",
                      (dept_id, u["tenant_id"])).fetchone()
        if not r:
            raise HTTPException(404, "Department not found")
        if c.execute("""SELECT 1 FROM documents WHERE tenant_id=? AND department=?
                        UNION ALL
                        SELECT 1 FROM doc_departments WHERE dept_id=?""",
                     (u["tenant_id"], r["name"], dept_id)).fetchone():
            raise HTTPException(400, "Cannot delete: documents are still assigned to this department")
        c.execute("DELETE FROM departments WHERE id=?", (dept_id,))
    D.audit(u["tenant_id"], u["id"], "dept_deleted", r["name"])
    return {"ok": True}


# ── Chat ────────────────────────────────────────────────────────────────────
class Ask(BaseModel):
    question: str = Field(min_length=2, max_length=2000)
    conversation_id: str | None = None
    provider: str | None = None
    language: str | None = "English"


@app.post("/api/chat")
def chat(b: Ask, u=Depends(S.current_user)):
    # Resolve/verify the conversation first, but only persist it once the
    # answer succeeded (no empty conversations left behind on LLM errors).
    with D.db() as c:
        if b.conversation_id:
            if not c.execute("SELECT 1 FROM conversations WHERE id=? AND user_id=?",
                             (b.conversation_id, u["id"])).fetchone():
                raise HTTPException(404, "Conversation not found")
            cid = b.conversation_id
            hist = [dict(r) for r in c.execute(
                "SELECT role,content FROM messages WHERE conv_id=? ORDER BY id DESC LIMIT 6", (cid,))][::-1]
        else:
            cid, hist = None, []

    t0 = time.time()
    lang = b.language or "English"

    try:
        # doc_ids is computed per request → tenant/scope isolation inside retrieval.
        # The language instruction is deliberately NOT appended to the question:
        # it would pollute BM25 ranking, the sufficiency-gate term set and the
        # casual-reply gate ("hi (Answer strictly in Spanish)" is not a
        # greeting). agent.run adds it to the generation prompt only.
        res = agent.run(b.question, u["tenant_id"], authz.visible_doc_ids(u), hist, b.provider,
                        language=lang)
    except RuntimeError as e:
        raise HTTPException(503, str(e))

    a = res.get("answer", "").lower()
    if "couldn't find this" in a or "don't contain enough support" in a:
        localized = {
            "spanish": "No pude encontrar esta información en los documentos a los que tiene acceso. Intente reformular su pregunta o consulte con un administrador.",
            "hindi": "मुझे उन दस्तावेज़ों में यह जानकारी नहीं मिली जिन तक आपकी पहुंच है। कृपया अपना प्रश्न दोबारा पूछें या अपने व्यवस्थापक से संपर्क करें।",
            "french": "Je n'ai pas trouvé ces informations dans les documents auxquels vous avez accès.",
        }
        for key, text in localized.items():
            if key in lang.lower():
                res["answer"] = text

    res["latency_ms"] = int((time.time() - t0) * 1000)

    # Research telemetry: outcome statistics only (question stored as SHA-256;
    # no chunk text, no answers, no credentials). Never affects the response.
    try:
        D.log_query(u["tenant_id"], u["id"], b.question, {
            "n_hits": len(res.get("evidence", [])),
            "retries": res.get("retries", 0),
            "sufficiency": (res.get("sufficiency") or {}).get("coverage"),
            "abstained": res.get("abstained", False),
            "abstain_reason": res.get("abstain_reason", ""),
            "grounded": res.get("grounded"),
            "score": res.get("confidence"),
            "provider": res.get("providers", ""),
            "trace": res.get("trace", []),
        }, res["latency_ms"])
    except Exception as e:
        print("query_log write failed:", type(e).__name__)

    with D.db() as c:
        if cid is None:
            cid = D.uid()
            c.execute("INSERT INTO conversations(id,user_id,tenant_id,title) VALUES(?,?,?,?)",
                      (cid, u["id"], u["tenant_id"], b.question[:60]))
        c.execute("INSERT INTO messages(conv_id,role,content) VALUES(?,?,?)", (cid, "user", b.question))
        c.execute("INSERT INTO messages(conv_id,role,content,meta) VALUES(?,?,?,?)",
                  (cid, "assistant", res["answer"],
                   json.dumps({k: res.get(k) for k in ("grounded", "confidence", "abstained",
                                                       "retries", "trace", "latency_ms")})))
    D.audit(u["tenant_id"], u["id"], "query", b.question)
    # intentionally minimal: no source list, no model name, no confidence shown
    return {"answer": res["answer"], "conversation_id": cid, "latency_ms": res["latency_ms"]}


@app.get("/api/conversations")
def conversations(u=Depends(S.current_user)):
    with D.db() as c:
        return [dict(r) for r in c.execute(
            "SELECT id,title,created FROM conversations WHERE user_id=? ORDER BY created DESC LIMIT 50",
            (u["id"],))]


@app.get("/api/conversations/{cid}")
def conversation(cid: str, u=Depends(S.current_user)):
    with D.db() as c:
        if not c.execute("SELECT 1 FROM conversations WHERE id=? AND user_id=?",
                         (cid, u["id"])).fetchone():
            raise HTTPException(404, "Not found")
        # only role + content are served; assistant text is scrubbed of any
        # citation markers older answers may still contain
        return [{"role": r["role"],
                 "content": agent.clean_markers(r["content"]) if r["role"] == "assistant" else r["content"]}
                for r in c.execute("SELECT * FROM messages WHERE conv_id=? ORDER BY id", (cid,))]


@app.delete("/api/conversations/{cid}")
def del_conv(cid: str, u=Depends(S.current_user)):
    with D.db() as c:
        # 404 (not a silent 200) for conversations the caller doesn't own
        if not c.execute("SELECT 1 FROM conversations WHERE id=? AND user_id=?",
                         (cid, u["id"])).fetchone():
            raise HTTPException(404, "Not found")
        c.execute("DELETE FROM conversations WHERE id=? AND user_id=?", (cid, u["id"]))
    return {"ok": True}


# ── Search (retrieval with citations, no LLM) ───────────────────────────────
class SearchIn(BaseModel):
    query: str = Field(min_length=2, max_length=2000)
    k: int = Field(8, ge=1, le=20)


@app.post("/api/search")
def search_docs(b: SearchIn, u=Depends(S.current_user)):
    """Hybrid retrieval over the caller's visible documents only.

    Citations point at real stored metadata (filename, page, doc_id). The
    document scope comes from the verified token — client-supplied ids are
    never accepted, so retrieval filters always run before any content leaves
    the server.
    """
    hits = rag.search(u["tenant_id"], authz.visible_doc_ids(u), b.query, b.k)
    hits = rag.rerank(b.query, hits, b.k)
    D.audit(u["tenant_id"], u["id"], "search", b.query)
    return {"query": b.query, "results": [
        {"rank": i + 1, "filename": h["meta"]["filename"], "doc_id": h["meta"]["doc_id"],
         "page": h["meta"]["page"], "score": h["score"], "text": h["text"]}
        for i, h in enumerate(hits)]}


@app.get("/api/team/overview")
def team_overview(u=Depends(S.current_user)):
    """Department workspace data for designated managers (users.is_manager=1).

    Enforced server-side: callers without the manager designation get 403, and
    the designation can only be granted by an admin of the same organization.
    The payload contains ONLY data the caller can already read through the
    normal authorization paths — it grants no new document or user privileges.
    """
    if not u.get("is_manager"):
        raise HTTPException(403, "Manager designation required")
    ids = authz.visible_doc_ids(u)
    with D.db() as c:
        dept = c.execute("SELECT id FROM departments WHERE tenant_id=? AND name=?",
                         (u["tenant_id"], u["department"])).fetchone()
        members = (c.execute("SELECT COUNT(*) FROM users WHERE tenant_id=? AND department=?",
                             (u["tenant_id"], u["department"])).fetchone()[0]
                   if u["department"] else 0)
        docs = []
        if ids:
            ph = ",".join("?" * len(ids))
            for r in c.execute(
                    f"""SELECT d.id,d.filename,d.visibility,d.department,d.chunks,d.created,
                               d.download_allowed,
                               COALESCE(us.username,'removed user') AS uploaded_by
                        FROM documents d LEFT JOIN users us ON us.id=d.uploaded_by
                        WHERE d.id IN ({ph}) AND (
                              d.department=? OR
                              (d.visibility='selected_departments' AND EXISTS (
                                  SELECT 1 FROM doc_departments dd
                                  WHERE dd.doc_id=d.id AND dd.dept_id=?)))
                        ORDER BY d.created DESC""",
                    [*ids, u["department"], dept["id"] if dept else ""]).fetchall():
                d = dict(r)
                d["download_allowed"] = bool(d["download_allowed"])
                docs.append(d)
    return {"department": u["department"], "member_count": members,
            "document_count": len(docs), "documents": docs}


# ── Admin (always scoped to the admin's own organization) ───────────────────
@app.get("/api/admin/users")
def users(u=Depends(S.admin_user)):
    with D.db() as c:
        return [dict(r) for r in c.execute(
            "SELECT id,username,email,role,department,employee_id,is_manager,created,"
            "full_name,employment_type,agreement_start,agreement_end FROM users "
            "WHERE tenant_id=? ORDER BY created", (u["tenant_id"],))]


class UserUpdate(BaseModel):
    role: str | None = None
    department: str | None = None
    is_manager: bool | None = None
    # Work email. Absent (old PATCH bodies) means "no change"; an explicit
    # null (or "") clears — distinguished via b.model_fields_set below.
    email: str | None = None
    # Employment agreement tracking (additive).
    full_name: str | None = None
    employment_type: str | None = None
    agreement_start: str | None = None
    agreement_end: str | None = None


@app.patch("/api/admin/users/{user_id}")
def update_user(user_id: str, b: UserUpdate, u=Depends(S.admin_user)):
    if b.role is not None and b.role not in ("admin", "member"):
        raise HTTPException(400, "Invalid role")
    if b.role is not None and user_id == u["id"]:
        raise HTTPException(400, "You cannot change your own role")
    email, email_note, email_conflict = None, "", False
    with D.db() as c:
        # Own-tenant existence check FIRST: another tenant's user is a 404,
        # never a 409 that could confirm an email exists elsewhere.
        if not c.execute("SELECT 1 FROM users WHERE id=? AND tenant_id=?", (user_id, u["tenant_id"])).fetchone():
            raise HTTPException(404, "User not found")
        if "email" in b.model_fields_set:
            email = _norm_email(b.email)
            # R1: global identifier rules — email-vs-email and (the shadowing
            # case) email-vs-username; self excluded so an account may keep its
            # own username-shaped email.
            _assert_email_available(c, email, user_id)
            try:
                c.execute("UPDATE users SET email=? WHERE id=? AND tenant_id=?",
                          (email, user_id, u["tenant_id"]))
            except D.IntegrityError:
                # R3: the pre-check lost a race — the CI index just fired.
                # The failed statement rolls back by itself; skip the remaining
                # field updates so a rejected PATCH commits NOTHING, and
                # classify after this transaction has closed (a failed statement
                # poisons the transaction on PostgreSQL).
                email_conflict = True
            else:
                email_note = f" email={email or 'cleared'}"
        if not email_conflict:
            if b.department is not None:
                if b.department not in ("", "General") and not c.execute(
                        "SELECT 1 FROM departments WHERE tenant_id=? AND name=?",
                        (u["tenant_id"], b.department)).fetchone():
                    raise HTTPException(400, "Unknown department")
                c.execute("UPDATE users SET department=? WHERE id=? AND tenant_id=?",
                          (b.department or "General", user_id, u["tenant_id"]))
            if b.is_manager is not None:
                # Manager designation: workspace gate only. Changing it never
                # touches role, department, or any document permission.
                c.execute("UPDATE users SET is_manager=? WHERE id=? AND tenant_id=?",
                          (1 if b.is_manager else 0, user_id, u["tenant_id"]))
            if b.role is not None:
                c.execute("UPDATE users SET role=? WHERE id=? AND tenant_id=?",
                          (b.role, user_id, u["tenant_id"]))
            # Employment agreement tracking (additive fields).
            if "full_name" in b.model_fields_set:
                c.execute("UPDATE users SET full_name=? WHERE id=? AND tenant_id=?",
                          ((b.full_name or "").strip() or None, user_id, u["tenant_id"]))
            if b.employment_type is not None:
                if b.employment_type not in ("full_time", "contract", "intern", "fixed_term"):
                    raise HTTPException(400, "Invalid employment type")
                c.execute("UPDATE users SET employment_type=? WHERE id=? AND tenant_id=?",
                          (b.employment_type, user_id, u["tenant_id"]))
            if "agreement_start" in b.model_fields_set:
                v = _norm_date(b.agreement_start)
                c.execute("UPDATE users SET agreement_start=? WHERE id=? AND tenant_id=?",
                          (v, user_id, u["tenant_id"]))
            if "agreement_end" in b.model_fields_set:
                v = _norm_date(b.agreement_end)
                c.execute("UPDATE users SET agreement_end=? WHERE id=? AND tenant_id=?",
                          (v, user_id, u["tenant_id"]))
    if email_conflict:
        with D.db() as c:                      # fresh transaction (PG-safe)
            _assert_email_available(c, email, user_id)   # -> 409, precise reason
        raise HTTPException(409, "Email already in use")  # race vanished: still a conflict
    D.audit(u["tenant_id"], u["id"], "user_updated",
            f"{user_id} role={b.role} dept={b.department} "
            f"manager={b.is_manager}{email_note}")
    return {"ok": True}


@app.delete("/api/admin/users/{user_id}")
def del_user(user_id: str, u=Depends(S.admin_user)):
    if user_id == u["id"]:
        raise HTTPException(400, "You cannot delete yourself")
    with D.db() as c:
        if not c.execute("DELETE FROM users WHERE id=? AND tenant_id=?",
                         (user_id, u["tenant_id"])).rowcount:
            raise HTTPException(404, "User not found")
    D.audit(u["tenant_id"], u["id"], "user_deleted", user_id)
    return {"ok": True}


# ── Employee IDs (invitations) ──────────────────────────────────────────────
DEPT_PREFIXES = {
    "Engineering & Tech": "ENG",
    "Human Resources": "HR",
    "Finance & Operations": "FIN",
    "Legal & Compliance": "LEG",
    "Marketing & Sales": "MKT",
}


class Invite(BaseModel):
    role: str = "member"
    department: str = "Engineering & Tech"
    days: int = Field(7, ge=1, le=30)
    code: str | None = None
    # Optional bulk-onboarding metadata (copied to the user on registration).
    full_name: str | None = None
    email: str | None = None
    employment_type: str = "full_time"
    agreement_start: str | None = None
    agreement_end: str | None = None


@app.post("/api/admin/invites")
def make_invite(b: Invite, u=Depends(S.admin_user)):
    """Issue a corporate Employee ID (e.g. ENG-482910) for a department."""
    role = b.role if b.role in ("admin", "member") else "member"
    dept = (b.department or "").strip()
    emp_type = b.employment_type if b.employment_type in ("full_time", "contract", "intern", "fixed_term") else "full_time"
    ag_start = _norm_date(b.agreement_start)
    ag_end = _norm_date(b.agreement_end)
    full_name = (b.full_name or "").strip() or None
    email = _norm_email(b.email) if (b.email is not None and str(b.email).strip() != "") else None
    with D.db() as c:
        if dept and not c.execute("SELECT 1 FROM departments WHERE tenant_id=? AND name=?",
                                  (u["tenant_id"], dept)).fetchone():
            raise HTTPException(400, "Unknown department")
        if b.code and b.code.strip():
            code = b.code.strip()[:32]
            if c.execute("SELECT 1 FROM invites WHERE code=?", (code,)).fetchone():
                raise HTTPException(409, "Employee ID already exists")
        else:
            prefix = DEPT_PREFIXES.get(dept, "EMP")
            # secrets, not random: invite codes are bearer credentials for
            # joining the organization and must not be predictable
            code = f"{prefix}-{''.join(secrets.choice(string.digits) for _ in range(6))}"
        exp = (datetime.now(timezone.utc) + timedelta(days=b.days)).isoformat()
        try:
            c.execute(
                "INSERT INTO invites(code,tenant_id,role,department,created_by,expires,"
                "full_name,email,employment_type,agreement_start,agreement_end) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (code, u["tenant_id"], role, dept, u["id"], exp,
                 full_name, email, emp_type, ag_start, ag_end))
        except D.IntegrityError:
            # lost a code-collision race (custom or generated code) — 409, never a 500
            raise HTTPException(409, "Employee ID already exists")
    D.audit(u["tenant_id"], u["id"], "invite_created", f"{code} ({dept})")
    return {"code": code, "expires": exp, "department": dept, "role": role}


@app.get("/api/admin/invites")
def invites(u=Depends(S.admin_user)):
    with D.db() as c:
        return [dict(r) for r in c.execute(
            """SELECT i.code,i.role,i.department,i.expires,i.used_by,
                      u.username AS joined_by
               FROM invites i LEFT JOIN users u ON u.id=i.used_by
               WHERE i.tenant_id=? ORDER BY i.expires DESC LIMIT 30""", (u["tenant_id"],))]


# ── Bulk employee onboarding (CSV) ──────────────────────────────────────────
_CSV_TEMPLATE = "employee_id,full_name,work_email,department,role,employment_type,agreement_start,agreement_end\n"
_CSV_HEADERS = ["employee_id", "full_name", "work_email", "department", "role",
                "employment_type", "agreement_start", "agreement_end"]
_VALID_EMP_TYPES = ("full_time", "contract", "intern", "fixed_term")


def _parse_csv_bytes(data: bytes):
    text = data.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    if reader.fieldnames is None:
        return None, "Empty or unreadable CSV file"
    alias = {"employee id": "employee_id", "employeeid": "employee_id",
             "name": "full_name", "employee_name": "full_name", "email": "work_email",
             "work email": "work_email", "emp_type": "employment_type",
             "start": "agreement_start", "end": "agreement_end",
             "agreement end": "agreement_end", "agreement start": "agreement_start"}
    header_map = {}
    for orig in reader.fieldnames:
        n = (orig or "").strip().lower().replace(" ", "_")
        header_map[orig] = alias.get(n, n)
    rows = []
    for raw in reader:
        row = {}
        for k, v in raw.items():
            nk = header_map.get(k, (k or "").strip().lower().replace(" ", "_"))
            row[nk] = (v or "").strip()
        rows.append(row)
    header_keys = set(header_map.values())
    if "employee_id" not in header_keys or "department" not in header_keys:
        return None, "CSV must include 'employee_id' and 'department' columns"
    return rows, None


def _validate_csv_row(row, tenant_id, seen_ids, seen_emails, depts):
    errors = []
    eid = (row.get("employee_id") or "").strip()
    if not eid:
        errors.append("employee_id is required")
    elif len(eid) > 32:
        errors.append("employee_id too long (max 32)")
    name = (row.get("full_name") or "").strip() or None
    email_raw = (row.get("work_email") or "").strip()
    email = None
    if email_raw:
        try:
            email = _norm_email(email_raw)
        except HTTPException as e:
            errors.append("invalid email: %s" % e.detail)
    dept = (row.get("department") or "").strip()
    if not dept:
        errors.append("department is required")
    elif dept not in depts:
        errors.append("unknown department: %s" % dept)
    role = (row.get("role") or "member").strip().lower() or "member"
    if role not in ("admin", "member"):
        errors.append("role must be 'admin' or 'member'")
        role = "member"
    emp_type = (row.get("employment_type") or "full_time").strip().lower() or "full_time"
    if emp_type not in _VALID_EMP_TYPES:
        errors.append("employment_type must be full_time/contract/intern/fixed_term")
        emp_type = "full_time"
    ag_start = None
    ag_end = None
    if (row.get("agreement_start") or "").strip():
        try:
            ag_start = _norm_date(row.get("agreement_start"))
        except HTTPException as e:
            errors.append("invalid agreement_start: %s" % e.detail)
    if (row.get("agreement_end") or "").strip():
        try:
            ag_end = _norm_date(row.get("agreement_end"))
        except HTTPException as e:
            errors.append("invalid agreement_end: %s" % e.detail)
    if ag_start and ag_end and ag_start > ag_end:
        errors.append("agreement_start must be <= agreement_end")

    status = "valid"
    if eid:
        if eid in seen_ids:
            status = "duplicate"
            errors.append("duplicate employee_id in file")
        seen_ids.add(eid)
    if email:
        if email in seen_emails:
            status = "duplicate"
            errors.append("duplicate email in file")
        seen_emails.add(email)
    if not errors and eid:
        with D.db() as c:
            if c.execute("SELECT 1 FROM invites WHERE code=? AND tenant_id=?", (eid, tenant_id)).fetchone():
                status = "existing"
                errors.append("employee_id already issued")
            if c.execute("SELECT 1 FROM users WHERE employee_id=? AND tenant_id=?", (eid, tenant_id)).fetchone():
                status = "existing"
                errors.append("employee already has an account")
            if email and c.execute("SELECT 1 FROM users WHERE email=? AND tenant_id=?", (email, tenant_id)).fetchone():
                status = "existing"
                errors.append("email already registered")
    if errors and status == "valid":
        status = "invalid"
    return {
        "employee_id": eid,
        "full_name": name,
        "work_email": email,
        "department": dept,
        "role": role,
        "employment_type": emp_type,
        "agreement_start": ag_start,
        "agreement_end": ag_end,
    }, status, errors


@app.get("/api/admin/onboarding/template")
def onboarding_template(u=Depends(S.admin_user)):
    return Response(
        content=_CSV_TEMPLATE,
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="employee_onboarding_template.csv"'})


@app.post("/api/admin/onboarding/preview")
async def onboarding_preview(file: UploadFile = File(...), u=Depends(S.admin_user)):
    data = await file.read()
    if len(data) > 2 * 1024 * 1024:
        raise HTTPException(413, "File too large")
    rows, err = _parse_csv_bytes(data)
    if err:
        raise HTTPException(400, err)
    with D.db() as c:
        depts = {r["name"] for r in c.execute(
            "SELECT name FROM departments WHERE tenant_id=?", (u["tenant_id"],))}
    seen_ids, seen_emails = set(), set()
    results = []
    for i, row in enumerate(rows, start=2):
        data_row, status, errors = _validate_csv_row(row, u["tenant_id"], seen_ids, seen_emails, depts)
        results.append({"row": i, "status": status, "errors": errors, "data": data_row})
    summary = {
        "total": len(results),
        "valid": sum(1 for r in results if r["status"] == "valid"),
        "invalid": sum(1 for r in results if r["status"] == "invalid"),
        "duplicate": sum(1 for r in results if r["status"] == "duplicate"),
        "existing": sum(1 for r in results if r["status"] == "existing"),
    }
    return {"rows": results, "summary": summary}


@app.post("/api/admin/onboarding/import")
async def onboarding_import(file: UploadFile = File(...), u=Depends(S.admin_user)):
    data = await file.read()
    if len(data) > 2 * 1024 * 1024:
        raise HTTPException(413, "File too large")
    rows, err = _parse_csv_bytes(data)
    if err:
        raise HTTPException(400, err)
    with D.db() as c:
        depts = {r["name"] for r in c.execute(
            "SELECT name FROM departments WHERE tenant_id=?", (u["tenant_id"],))}
    seen_ids, seen_emails = set(), set()
    results = []
    created = 0
    for i, row in enumerate(rows, start=2):
        data_row, status, errors = _validate_csv_row(row, u["tenant_id"], seen_ids, seen_emails, depts)
        code = None
        if status == "valid":
            code = data_row["employee_id"] or None
            if not code:
                prefix = DEPT_PREFIXES.get(data_row["department"], "EMP")
                code = "%s-%s" % (prefix, "".join(secrets.choice(string.digits) for _ in range(6)))
            with D.db() as c:
                if c.execute("SELECT 1 FROM invites WHERE code=?", (code,)).fetchone():
                    code = "%s-%s" % (DEPT_PREFIXES.get(data_row["department"], "EMP"),
                                       "".join(secrets.choice(string.digits) for _ in range(6)))
                try:
                    c.execute(
                        "INSERT INTO invites(code,tenant_id,role,department,created_by,expires,"
                        "full_name,email,employment_type,agreement_start,agreement_end) "
                        "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                        (code, u["tenant_id"], data_row["role"], data_row["department"], u["id"],
                         (datetime.now(timezone.utc) + timedelta(days=7)).isoformat(),
                         data_row["full_name"], data_row["work_email"], data_row["employment_type"],
                         data_row["agreement_start"], data_row["agreement_end"]))
                    created += 1
                except D.IntegrityError:
                    status = "existing"
                    errors = ["employee_id already issued"]
                    code = None
        results.append({"row": i, "status": status, "errors": errors,
                        "employee_id": data_row["employee_id"], "code": code})
    summary = {
        "total": len(results),
        "created": created,
        "valid": sum(1 for r in results if r["status"] == "valid"),
        "invalid": sum(1 for r in results if r["status"] == "invalid"),
        "duplicate": sum(1 for r in results if r["status"] == "duplicate"),
        "existing": sum(1 for r in results if r["status"] == "existing"),
    }
    D.audit(u["tenant_id"], u["id"], "bulk_onboard", "created=%d total=%d" % (created, len(results)))
    return {"rows": results, "summary": summary}

@app.get("/api/admin/audit")
def audit_log(u=Depends(S.admin_user)):
    with D.db() as c:
        return [dict(r) for r in c.execute(
            """SELECT a.created,a.action,a.detail,COALESCE(us.username,'system') AS username
               FROM audit a LEFT JOIN users us ON us.id=a.user_id
               WHERE a.tenant_id=? ORDER BY a.id DESC LIMIT 100""", (u["tenant_id"],))]


@app.get("/api/admin/stats")
def stats(u=Depends(S.admin_user)):
    with D.db() as c:
        def q(s):
            return c.execute(s, (u["tenant_id"],)).fetchone()[0]
        return {
            "users": q("SELECT COUNT(*) FROM users WHERE tenant_id=?"),
            "documents": q("SELECT COUNT(*) FROM documents WHERE tenant_id=?"),
            "queries": q("SELECT COUNT(*) FROM audit WHERE tenant_id=? AND action='query'"),
            "chunks": q("SELECT COALESCE(SUM(chunks),0) FROM documents WHERE tenant_id=?"),
            # stored bytes (real, tenant-scoped): SUM of indexed file content
            "storage": q("SELECT COALESCE(SUM(LENGTH(content)),0) FROM documents WHERE tenant_id=?"),
        }


@app.post("/api/admin/backfill-embeddings")
def backfill(u=Depends(S.admin_user)):
    """Vectorize this tenant's chunks that were ingested WITHOUT embeddings.

    Documents uploaded while no embedding key was configured are BM25-only
    forever — setting the key later does not create their vectors. Admin-only
    and hard-scoped to the caller's own tenant. Bounded per call (default 200
    chunks) so it stays inside the serverless function timeout; call again
    until `pending` is 0. Idempotent: only NULL-embedding chunks are touched.
    """
    if not E.available():
        raise HTTPException(409, "No embedding provider configured "
                                 "(set OPENAI_API_KEY or GEMINI_API_KEY first).")
    stats = rag.backfill_embeddings(tid=u["tenant_id"], batch=64, limit=200)
    D.audit(u["tenant_id"], u["id"], "embeddings_backfilled",
            f"{stats['embedded']}/{stats['pending']} via {stats['provider'] or 'none'}")
    with D.db() as c:  # true remaining count for this tenant (not just this batch)
        remaining = c.execute(
            "SELECT COUNT(*) FROM chunks WHERE tenant_id=? AND embedding IS NULL",
            (u["tenant_id"],)).fetchone()[0]
    return {"provider": stats["provider"], "embedded": stats["embedded"],
            "pending_backfill": remaining, "done": remaining == 0}


@app.get("/api/health")
def health():
    return {"ok": True, "database": "postgres" if D.PG else "sqlite",
            "embeddings": E.available(), "llm": llm.available()}
