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

from . import agent, db as D, embeddings as E, llm, rag, security as S
from .config import ALLOW_ORG_SIGNUP, ALLOWED_EXT, CORS, MAX_UPLOAD_MB


@asynccontextmanager
async def lifespan(_app: FastAPI):
    D.init()          # create/migrate schema on startup (both SQLite and Postgres)
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
            "SELECT u.id,u.username,u.role,u.tenant_id,u.department,u.employee_id,t.name AS tenant_name "
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
    return {"llm": llm.available(), "embeddings": E.available()}


# ── Documents (admin writes; reads are ACL- and department-filtered) ────────
def visible_doc_ids(u) -> list[str]:
    """Tenant + department + per-document ACL isolation.

    * admins see everything inside their own organization;
    * members see org-wide docs, their own department's docs, docs they
      uploaded, and docs explicitly shared with them.
    """
    with D.db() as c:
        if u["role"] == "admin":
            rows = c.execute("SELECT id FROM documents WHERE tenant_id=?", (u["tenant_id"],)).fetchall()
        else:
            rows = c.execute(
                """SELECT id FROM documents
                   WHERE tenant_id=?
                     AND (visibility='org'
                          OR (visibility='department' AND department=?)
                          OR uploaded_by=?
                          OR id IN (SELECT doc_id FROM doc_acl WHERE user_id=?))""",
                (u["tenant_id"], u.get("department") or "", u["id"], u["id"]),
            ).fetchall()
    return [r["id"] for r in rows]


@app.get("/api/documents")
def list_docs(u=Depends(S.current_user)):
    ids = visible_doc_ids(u)
    if not ids:
        return []
    with D.db() as c:
        docs = [dict(r) for r in c.execute(
            f"""SELECT d.id,d.filename,d.visibility,d.department,d.chunks,d.created,
                       COALESCE(us.username,'removed user') AS uploaded_by
                FROM documents d LEFT JOIN users us ON us.id=d.uploaded_by
                WHERE d.id IN ({','.join('?' * len(ids))})
                ORDER BY d.created DESC""", ids)]
        if u["role"] == "admin":
            for d in docs:
                d["allowed_user_ids"] = [r["user_id"] for r in
                                         c.execute("SELECT user_id FROM doc_acl WHERE doc_id=?", (d["id"],))]
    return docs


@app.get("/api/documents/{doc_id}/download")
def download_doc(doc_id: str, u=Depends(S.current_user)):
    if doc_id not in visible_doc_ids(u):
        raise HTTPException(404, "Document not found")
    with D.db() as c:
        r = c.execute("SELECT filename,content FROM documents WHERE id=? AND tenant_id=?",
                      (doc_id, u["tenant_id"])).fetchone()
    if not r or r["content"] is None:
        raise HTTPException(404, "File content not stored for this document")
    data = bytes(r["content"])
    media = mimetypes.guess_type(r["filename"])[0] or "application/octet-stream"
    return Response(data, media_type=media, headers={
        "Content-Disposition": f'attachment; filename="{r["filename"]}"'})


def _set_acl(c, doc_id, tenant_id, user_ids):
    c.execute("DELETE FROM doc_acl WHERE doc_id=?", (doc_id,))
    for uid in user_ids:
        # only same-org users may be granted access
        if not c.execute("SELECT 1 FROM users WHERE id=? AND tenant_id=?", (uid, tenant_id)).fetchone():
            continue
        if not c.execute("SELECT 1 FROM doc_acl WHERE doc_id=? AND user_id=?", (doc_id, uid)).fetchone():
            c.execute("INSERT INTO doc_acl(doc_id,user_id) VALUES(?,?)", (doc_id, uid))


VISIBILITIES = ("org", "department", "restricted")


@app.post("/api/documents")
async def upload(
    file: UploadFile = File(...),
    visibility: str = Form("org"),
    department: str = Form(""),
    allowed_user_ids: str = Form(""),
    u=Depends(S.admin_user),
):
    name = os.path.basename(file.filename or "file")
    if os.path.splitext(name)[1].lower() not in ALLOWED_EXT:
        raise HTTPException(400, f"Unsupported type. Allowed: {', '.join(sorted(ALLOWED_EXT))}")
    if visibility not in VISIBILITIES:
        raise HTTPException(400, f"visibility must be one of {', '.join(VISIBILITIES)}")
    if visibility == "department" and not department.strip():
        raise HTTPException(400, "department is required for department visibility")
    data = await file.read()
    if len(data) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, f"File exceeds {MAX_UPLOAD_MB} MB")

    with D.db() as c:  # re-uploading the same filename replaces it (no duplicates)
        for old in c.execute("SELECT id FROM documents WHERE tenant_id=? AND filename=?",
                             (u["tenant_id"], name)).fetchall():
            rag.delete_doc(u["tenant_id"], old["id"])
            c.execute("DELETE FROM documents WHERE id=?", (old["id"],))

    doc_id = D.uid()
    try:
        n = rag.ingest(u["tenant_id"], doc_id, name, data)
    except Exception as e:
        raise HTTPException(422, f"Could not read file: {e}")
    if n == 0:
        raise HTTPException(422, "No extractable text found (scanned PDFs need OCR)")

    with D.db() as c:
        c.execute(
            "INSERT INTO documents(id,tenant_id,filename,visibility,department,uploaded_by,chunks,content) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (doc_id, u["tenant_id"], name, visibility, department.strip(), u["id"], n, data))
        if visibility == "restricted":
            _set_acl(c, doc_id, u["tenant_id"], [x for x in allowed_user_ids.split(",") if x])
    D.audit(u["tenant_id"], u["id"], "doc_uploaded", f"{name} ({visibility})")
    return {"id": doc_id, "filename": name, "chunks": n, "visibility": visibility,
            "department": department.strip()}


class Acl(BaseModel):
    visibility: str
    allowed_user_ids: list[str] = []


@app.patch("/api/documents/{doc_id}/access")
def set_access(doc_id: str, b: Acl, u=Depends(S.admin_user)):
    if b.visibility not in VISIBILITIES:
        raise HTTPException(400, f"visibility must be one of {', '.join(VISIBILITIES)}")
    with D.db() as c:
        if not c.execute("SELECT 1 FROM documents WHERE id=? AND tenant_id=?",
                         (doc_id, u["tenant_id"])).fetchone():
            raise HTTPException(404, "Document not found")
        c.execute("UPDATE documents SET visibility=? WHERE id=?", (b.visibility, doc_id))
        _set_acl(c, doc_id, u["tenant_id"], b.allowed_user_ids if b.visibility == "restricted" else [])
    D.audit(u["tenant_id"], u["id"], "doc_access_changed", f"{doc_id}→{b.visibility}")
    return {"ok": True}


@app.delete("/api/documents/{doc_id}")
def delete_doc(doc_id: str, u=Depends(S.admin_user)):
    with D.db() as c:
        r = c.execute("SELECT filename FROM documents WHERE id=? AND tenant_id=?",
                      (doc_id, u["tenant_id"])).fetchone()
        if not r:
            raise HTTPException(404, "Document not found")   # other tenants get 404, never 403-leak
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
                      (SELECT COUNT(*) FROM documents WHERE tenant_id=d.tenant_id AND department=d.name) AS documents,
                      (SELECT COUNT(*) FROM users WHERE tenant_id=d.tenant_id AND department=d.name) AS members
               FROM departments d WHERE d.tenant_id=? ORDER BY d.name""", (u["tenant_id"],)).fetchall()
    return [dict(r) for r in rows]


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
        if c.execute("SELECT 1 FROM documents WHERE tenant_id=? AND department=?",
                     (u["tenant_id"], r["name"])).fetchone():
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
        # doc_ids is computed per request → tenant/department isolation inside retrieval
        res = agent.run(query_text, u["tenant_id"], visible_doc_ids(u), hist, b.provider)
    except RuntimeError as e:
        raise HTTPException(503, str(e))

    if "couldn't find this" in res.get("answer", "").lower():
        localized = {
            "spanish": "No pude encontrar esta información en los documentos a los que tiene acceso en su departamento. Intente reformular su pregunta o consulte con un administrador.",
            "hindi": "मुझे उन दस्तावेज़ों में यह जानकारी नहीं मिली जिन तक आपके विभाग की पहुंच है। कृपया अपना प्रश्न दोबारा पूछें या अपने व्यवस्थापक से संपर्क करें।",
            "french": "Je n'ai pas trouvé ces informations dans les documents auxquels vous avez accès dans votre département.",
        }
        for key, text in localized.items():
            if key in lang.lower():
                res["answer"] = text

    res["latency_ms"] = int((time.time() - t0) * 1000)
    with D.db() as c:
        if cid is None:
            cid = D.uid()
            c.execute("INSERT INTO conversations(id,user_id,tenant_id,title) VALUES(?,?,?,?)",
                      (cid, u["id"], u["tenant_id"], b.question[:60]))
        c.execute("INSERT INTO messages(conv_id,role,content) VALUES(?,?,?)", (cid, "user", b.question))
        c.execute("INSERT INTO messages(conv_id,role,content,meta) VALUES(?,?,?,?)",
                  (cid, "assistant", res["answer"],
                   json.dumps({k: res[k] for k in ("citations", "grounded", "confidence", "provider",
                                                   "trace", "latency_ms")})))
    D.audit(u["tenant_id"], u["id"], "query", b.question)
    return {**res, "conversation_id": cid}


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
        return [{"role": r["role"], "content": r["content"],
                 **(json.loads(r["meta"]) if r["meta"] else {})}
                for r in c.execute("SELECT * FROM messages WHERE conv_id=? ORDER BY id", (cid,))]


@app.delete("/api/conversations/{cid}")
def del_conv(cid: str, u=Depends(S.current_user)):
    with D.db() as c:
        c.execute("DELETE FROM conversations WHERE id=? AND user_id=?", (cid, u["id"]))
    return {"ok": True}


# ── Admin (always scoped to the admin's own organization) ───────────────────
@app.get("/api/admin/users")
def users(u=Depends(S.admin_user)):
    with D.db() as c:
        return [dict(r) for r in c.execute(
            "SELECT id,username,role,department,employee_id,created FROM users "
            "WHERE tenant_id=? ORDER BY created", (u["tenant_id"],))]


class UserUpdate(BaseModel):
    role: str | None = None
    department: str | None = None


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
        if b.role is not None:
            c.execute("UPDATE users SET role=? WHERE id=? AND tenant_id=?",
                      (b.role, user_id, u["tenant_id"]))
    D.audit(u["tenant_id"], u["id"], "user_updated",
            f"{user_id} role={b.role} dept={b.department}")
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
        }


@app.get("/api/health")
def health():
    return {"ok": True, "database": "postgres" if D.PG else "sqlite",
            "embeddings": E.available(), "llm": llm.available()}
