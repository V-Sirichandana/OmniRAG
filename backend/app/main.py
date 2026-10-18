"""OmniRAG FastAPI application.

All endpoints are tenant-scoped: every query filters by the caller's
`tenant_id`, so one organization can never read, modify or delete another
organization's documents, conversations or users. Department visibility is
enforced here (server-side), never only in the UI.
"""
import json, mimetypes, os, random, string, time
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


def _session(user_id):
    with D.db() as c:
        r = c.execute(
            "SELECT u.id,u.username,u.role,u.tenant_id,u.department,u.employee_id,"
            "u.is_manager,t.name AS tenant_name "
            "FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.id=?", (user_id,)).fetchone()
    return {"token": S.make_token(user_id), "user": dict(r)}


@app.post("/api/auth/login")
def login(b: Login):
    name = b.username.strip().lower(); S.check_lock(name)
    with D.db() as c:
        r = c.execute("SELECT * FROM users WHERE username=?", (name,)).fetchone()
    if not r or not S.check_pw(b.password, r["pw_hash"]):
        S.record_fail(name); raise HTTPException(401, "Invalid username or password")
    S.clear_fail(name); D.audit(r["tenant_id"], r["id"], "login")
    return _session(r["id"])


@app.post("/api/auth/signup-org")
def signup_org(b: OrgSignup):
    if not ALLOW_ORG_SIGNUP:
        raise HTTPException(403, "Organization sign-up is disabled")
    name, tid, uid = b.username.strip().lower(), D.uid(), D.uid()
    with D.db() as c:
        if c.execute("SELECT 1 FROM users WHERE username=?", (name,)).fetchone():
            raise HTTPException(409, "Username already taken")
        c.execute("INSERT INTO tenants(id,name) VALUES(?,?)", (tid, b.org_name.strip()))
        c.execute(
            "INSERT INTO users(id,username,pw_hash,tenant_id,role,department,employee_id) VALUES(?,?,?,?,?,?,?)",
            (uid, name, S.hash_pw(b.password), tid, "admin", "General", "ORG-ADMIN"))
        D.seed_departments(c, tid)          # standard five departments for the new org
    D.audit(tid, uid, "org_created", b.org_name)
    return _session(uid)


@app.post("/api/auth/register")
def register(b: Register):
    """Join an existing organization with a company-issued Employee ID."""
    name, uid = b.username.strip().lower(), D.uid()
    with D.db() as c:
        inv = c.execute("SELECT * FROM invites WHERE code=?", (b.invite_code.strip(),)).fetchone()
        if not inv or inv["used_by"] or inv["expires"] < datetime.now(timezone.utc).isoformat():
            raise HTTPException(400, "Employee ID is invalid or expired")
        if c.execute("SELECT 1 FROM users WHERE username=?", (name,)).fetchone():
            raise HTTPException(409, "Username already taken")
        dept = inv["department"] or "General"
        c.execute(
            "INSERT INTO users(id,username,pw_hash,tenant_id,role,department,employee_id) VALUES(?,?,?,?,?,?,?)",
            (uid, name, S.hash_pw(b.password), inv["tenant_id"], inv["role"], dept, inv["code"]))
        c.execute("UPDATE invites SET used_by=? WHERE code=?", (uid, b.invite_code.strip()))
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
    return Response(data, media_type=media, headers={
        "Content-Disposition": f'attachment; filename="{r["filename"]}"'})


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


def _set_doc_departments(c, doc_id, tenant_id, dept_ids):
    """Persist selected-department targets; every id must be a real department
    of the caller's own organization."""
    c.execute("DELETE FROM doc_departments WHERE doc_id=?", (doc_id,))
    for did in dept_ids:
        if not c.execute("SELECT 1 FROM departments WHERE id=? AND tenant_id=?",
                         (did, tenant_id)).fetchone():
            raise HTTPException(400, "Unknown department (must belong to your organization)")
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
    data = await file.read()
    if len(data) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, f"File exceeds {MAX_UPLOAD_MB} MB")

    with D.db() as c:  # re-uploading the same filename replaces it (no duplicates)
        for old in c.execute("SELECT id FROM documents WHERE tenant_id=? AND filename=?",
                             (u["tenant_id"], name)).fetchall():
            rag.delete_doc(u["tenant_id"], old["id"])
            c.execute("DELETE FROM documents WHERE id=?", (old["id"],))

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
        c.execute("INSERT INTO departments(id,tenant_id,name,code) VALUES(?,?,?,?)",
                  (did, u["tenant_id"], name, (b.code.strip() or name[:3].upper())))
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
    query_text = f"{b.question} (Answer strictly in {lang})" if lang != "English" else b.question

    try:
        # doc_ids is computed per request → tenant/scope isolation inside retrieval
        res = agent.run(query_text, u["tenant_id"], authz.visible_doc_ids(u), hist, b.provider)
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
            "SELECT id,username,role,department,employee_id,is_manager,created FROM users "
            "WHERE tenant_id=? ORDER BY created", (u["tenant_id"],))]


class UserUpdate(BaseModel):
    role: str | None = None
    department: str | None = None
    is_manager: bool | None = None


@app.patch("/api/admin/users/{user_id}")
def update_user(user_id: str, b: UserUpdate, u=Depends(S.admin_user)):
    if b.role is not None and b.role not in ("admin", "member"):
        raise HTTPException(400, "Invalid role")
    if b.role is not None and user_id == u["id"]:
        raise HTTPException(400, "You cannot change your own role")
    with D.db() as c:
        if not c.execute("SELECT 1 FROM users WHERE id=? AND tenant_id=?", (user_id, u["tenant_id"])).fetchone():
            raise HTTPException(404, "User not found")
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
    D.audit(u["tenant_id"], u["id"], "user_updated",
            f"{user_id} role={b.role} dept={b.department} manager={b.is_manager}")
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


@app.post("/api/admin/invites")
def make_invite(b: Invite, u=Depends(S.admin_user)):
    """Issue a corporate Employee ID (e.g. ENG-482910) for a department."""
    role = b.role if b.role in ("admin", "member") else "member"
    dept = (b.department or "").strip()
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
            code = f"{prefix}-{''.join(random.choices(string.digits, k=6))}"
        exp = (datetime.now(timezone.utc) + timedelta(days=b.days)).isoformat()
        c.execute("INSERT INTO invites(code,tenant_id,role,department,created_by,expires) VALUES(?,?,?,?,?,?)",
                  (code, u["tenant_id"], role, dept, u["id"], exp))
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
