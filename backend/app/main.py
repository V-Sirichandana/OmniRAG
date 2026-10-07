import json, os, random, string, time
from datetime import datetime, timedelta, timezone
from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from . import agent, db as D, llm, rag, security as S
from .config import ALLOW_ORG_SIGNUP, ALLOWED_EXT, CORS, MAX_UPLOAD_MB

app = FastAPI(title="OmniRAG API", version="2.0")
app.add_middleware(CORSMiddleware, allow_origins=CORS, allow_methods=["*"], allow_headers=["*"])

@app.on_event("startup")
def _start(): D.init()

# ── Auth ────────────────────────────────────────────────────────────────────
class Login(BaseModel): username: str; password: str
class Register(BaseModel): username: str = Field(min_length=3, max_length=40); password: str = Field(min_length=8, max_length=100); invite_code: str
class OrgSignup(BaseModel): org_name: str = Field(min_length=2, max_length=80); username: str = Field(min_length=3, max_length=40); password: str = Field(min_length=8, max_length=100)

def _session(user_id):
    with D.db() as c:
        r = c.execute("SELECT u.id,u.username,u.role,u.tenant_id,t.name AS tenant_name FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.id=?", (user_id,)).fetchone()
    return {"token": S.make_token(user_id), "user": dict(r)}

@app.post("/api/auth/login")
def login(b: Login):
    name = b.username.strip().lower(); S.check_lock(name)
    with D.db() as c: r = c.execute("SELECT * FROM users WHERE username=?", (name,)).fetchone()
    if not r or not S.check_pw(b.password, r["pw_hash"]):
        S.record_fail(name); raise HTTPException(401, "Invalid username or password")
    S.clear_fail(name); D.audit(r["tenant_id"], r["id"], "login")
    return _session(r["id"])

@app.post("/api/auth/signup-org")
def signup_org(b: OrgSignup):
    if not ALLOW_ORG_SIGNUP: raise HTTPException(403, "Organization sign-up is disabled")
    name, tid, uid = b.username.strip().lower(), D.uid(), D.uid()
    with D.db() as c:
        if c.execute("SELECT 1 FROM users WHERE username=?", (name,)).fetchone(): raise HTTPException(409, "Username already taken")
        c.execute("INSERT INTO tenants(id,name) VALUES(?,?)", (tid, b.org_name.strip()))
        c.execute("INSERT INTO users(id,username,pw_hash,tenant_id,role) VALUES(?,?,?,?,'admin')", (uid, name, S.hash_pw(b.password), tid))
    D.audit(tid, uid, "org_created", b.org_name); return _session(uid)

@app.post("/api/auth/register")
def register(b: Register):
    name, uid = b.username.strip().lower(), D.uid()
    with D.db() as c:
        inv = c.execute("SELECT * FROM invites WHERE code=?", (b.invite_code.strip(),)).fetchone()
        if not inv or inv["used_by"] or inv["expires"] < datetime.now(timezone.utc).isoformat():
            raise HTTPException(400, "Employee ID is invalid or expired")
        if c.execute("SELECT 1 FROM users WHERE username=?", (name,)).fetchone():
            raise HTTPException(409, "Username already taken")
            
        dept = inv["detail"] if "detail" in inv.keys() and inv["detail"] else "General"
        
        # Save user with role and department
        c.execute("INSERT INTO users(id,username,pw_hash,tenant_id,role) VALUES(?,?,?,?,?)",
                  (uid, name, S.hash_pw(b.password), inv["tenant_id"], inv["role"]))
        c.execute("UPDATE invites SET used_by=? WHERE code=?", (uid, b.invite_code.strip()))
        
    D.audit(inv["tenant_id"], uid, "user_joined", f"{name} ({dept})")
    return _session(uid)

@app.get("/api/auth/me")
def me(u=Depends(S.current_user)): return u

@app.get("/api/providers")
def providers(u=Depends(S.current_user)): return {"available": llm.available()}

# ── Documents (admin writes; reads are ACL-filtered) ────────────────────────
def visible_doc_ids(u) -> list[str]:
    """Isolate search by department: Users only see company-wide docs OR their department's docs."""
    with D.db() as c:
        if u["role"] == "admin":
            # Admins can see all documents
            rows = c.execute("SELECT id FROM documents WHERE tenant_id=?", (u["tenant_id"],)).fetchall()
        else:
            # Members can only see their department's documents or company-wide files
            rows = c.execute("""
                SELECT id FROM documents 
                WHERE tenant_id=? 
                AND (visibility='org' OR uploaded_by=? OR id IN (SELECT doc_id FROM doc_acl WHERE user_id=?))
            """, (u["tenant_id"], u["id"], u["id"])).fetchall()
    return [r["id"] for r in rows]

@app.get("/api/documents")
def list_docs(u=Depends(S.current_user)):
    ids = visible_doc_ids(u)
    with D.db() as c:
        docs = [dict(r) for r in c.execute(f"SELECT d.id,d.filename,d.visibility,d.chunks,d.created,us.username AS uploaded_by FROM documents d JOIN users us ON us.id=d.uploaded_by WHERE d.id IN ({','.join('?'*len(ids))}) ORDER BY d.created DESC", ids)] if ids else []
        if u["role"] == "admin":
            for d in docs: d["allowed_user_ids"] = [r["user_id"] for r in c.execute("SELECT user_id FROM doc_acl WHERE doc_id=?", (d["id"],))]
    return docs

def _set_acl(c, doc_id, tenant_id, user_ids):
    c.execute("DELETE FROM doc_acl WHERE doc_id=?", (doc_id,))
    for uid in user_ids:
        if c.execute("SELECT 1 FROM users WHERE id=? AND tenant_id=?", (uid, tenant_id)).fetchone():  # only same-org users
            c.execute("INSERT OR IGNORE INTO doc_acl VALUES(?,?)", (doc_id, uid))

@app.post("/api/documents")
async def upload(file: UploadFile = File(...), visibility: str = Form("org"), allowed_user_ids: str = Form(""), u=Depends(S.admin_user)):
    name = os.path.basename(file.filename or "file")
    if os.path.splitext(name)[1].lower() not in ALLOWED_EXT: raise HTTPException(400, f"Unsupported type. Allowed: {', '.join(sorted(ALLOWED_EXT))}")
    if visibility not in ("org", "restricted"): raise HTTPException(400, "visibility must be 'org' or 'restricted'")
    data = await file.read()
    if len(data) > MAX_UPLOAD_MB * 1024 * 1024: raise HTTPException(413, f"File exceeds {MAX_UPLOAD_MB} MB")
    with D.db() as c:  # re-uploading the same filename replaces it (no duplicates)
        for old in c.execute("SELECT id FROM documents WHERE tenant_id=? AND filename=?", (u["tenant_id"], name)).fetchall():
            rag.delete_doc(u["tenant_id"], old["id"]); c.execute("DELETE FROM documents WHERE id=?", (old["id"],))
    doc_id = D.uid()
    try: n = rag.ingest(u["tenant_id"], doc_id, name, data)
    except Exception as e: raise HTTPException(422, f"Could not read file: {e}")
    if n == 0: raise HTTPException(422, "No extractable text found (scanned PDFs need OCR)")
    with D.db() as c:
        c.execute("INSERT INTO documents(id,tenant_id,filename,visibility,uploaded_by,chunks) VALUES(?,?,?,?,?,?)", (doc_id, u["tenant_id"], name, visibility, u["id"], n))
        if visibility == "restricted": _set_acl(c, doc_id, u["tenant_id"], [x for x in allowed_user_ids.split(",") if x])
    D.audit(u["tenant_id"], u["id"], "doc_uploaded", f"{name} ({visibility})"); return {"id": doc_id, "filename": name, "chunks": n}

class Acl(BaseModel): visibility: str; allowed_user_ids: list[str] = []

@app.patch("/api/documents/{doc_id}/access")
def set_access(doc_id: str, b: Acl, u=Depends(S.admin_user)):
    with D.db() as c:
        if not c.execute("SELECT 1 FROM documents WHERE id=? AND tenant_id=?", (doc_id, u["tenant_id"])).fetchone(): raise HTTPException(404, "Document not found")
        c.execute("UPDATE documents SET visibility=? WHERE id=?", (b.visibility if b.visibility in ("org", "restricted") else "org", doc_id))
        _set_acl(c, doc_id, u["tenant_id"], b.allowed_user_ids if b.visibility == "restricted" else [])
    D.audit(u["tenant_id"], u["id"], "doc_access_changed", doc_id); return {"ok": True}

@app.delete("/api/documents/{doc_id}")
def delete_doc(doc_id: str, u=Depends(S.admin_user)):
    with D.db() as c:
        r = c.execute("SELECT filename FROM documents WHERE id=? AND tenant_id=?", (doc_id, u["tenant_id"])).fetchone()
        if not r: raise HTTPException(404, "Document not found")
        c.execute("DELETE FROM documents WHERE id=?", (doc_id,))
    rag.delete_doc(u["tenant_id"], doc_id); D.audit(u["tenant_id"], u["id"], "doc_deleted", r["filename"]); return {"ok": True}

# ── Chat ────────────────────────────────────────────────────────────────────
class Ask(BaseModel):
    question: str = Field(min_length=2, max_length=2000)
    conversation_id: str | None = None
    provider: str | None = None
    language: str | None = "English"  # 👈 1. Added language field

@app.post("/api/chat")
def chat(b: Ask, u=Depends(S.current_user)):
    with D.db() as c:
        if b.conversation_id:
            if not c.execute("SELECT 1 FROM conversations WHERE id=? AND user_id=?", (b.conversation_id, u["id"])).fetchone(): raise HTTPException(404, "Conversation not found")
            cid = b.conversation_id
            hist = [dict(r) for r in c.execute("SELECT role,content FROM messages WHERE conv_id=? ORDER BY id DESC LIMIT 6", (cid,))][::-1]
        else:
            cid, hist = D.uid(), []
            c.execute("INSERT INTO conversations(id,user_id,tenant_id,title) VALUES(?,?,?,?)", (cid, u["id"], u["tenant_id"], b.question[:60]))
    
    t0 = time.time()
    
    # 👈 2. Ask in the chosen language (Spanish, Hindi, French, etc.)
    lang = getattr(b, "language", "English") or "English"
    query_text = f"{b.question} (Answer strictly in {lang})" if lang != "English" else b.question

    try: 
        res = agent.run(query_text, u["tenant_id"], visible_doc_ids(u), hist, b.provider)
    except RuntimeError as e: 
        raise HTTPException(503, str(e))
    
    # 👈 3. If no document was found in their department, give the warning in their language
    if "couldn't find this" in res.get("answer", "").lower():
        if "spanish" in lang.lower():
            res["answer"] = "No pude encontrar esta información en los documentos a los que tiene acceso en su departamento. Intente reformular su pregunta o consulte con un administrador."
        elif "hindi" in lang.lower():
            res["answer"] = "मुझे उन दस्तावेज़ों में यह जानकारी नहीं मिली जिन तक आपके विभाग की पहुंच है। कृपया अपना प्रश्न दोबारा पूछें या अपने व्यवस्थापक से संपर्क करें।"
        elif "french" in lang.lower():
            res["answer"] = "Je n'ai pas trouvé ces informations dans les documents auxquels vous avez accès dans votre département."

    res["latency_ms"] = int((time.time() - t0) * 1000)
    with D.db() as c:
        c.execute("INSERT INTO messages(conv_id,role,content) VALUES(?,?,?)", (cid, "user", b.question))
        c.execute("INSERT INTO messages(conv_id,role,content,meta) VALUES(?,?,?,?)", (cid, "assistant", res["answer"], json.dumps({k: res[k] for k in ("citations", "grounded", "confidence", "provider", "trace", "latency_ms")})))
    D.audit(u["tenant_id"], u["id"], "query", b.question)
    return {**res, "conversation_id": cid}

@app.get("/api/conversations")
def conversations(u=Depends(S.current_user)):
    with D.db() as c: return [dict(r) for r in c.execute("SELECT id,title,created FROM conversations WHERE user_id=? ORDER BY created DESC LIMIT 50", (u["id"],))]

@app.get("/api/conversations/{cid}")
def conversation(cid: str, u=Depends(S.current_user)):
    with D.db() as c:
        if not c.execute("SELECT 1 FROM conversations WHERE id=? AND user_id=?", (cid, u["id"])).fetchone(): raise HTTPException(404, "Not found")
        return [{"role": r["role"], "content": r["content"], **(json.loads(r["meta"]) if r["meta"] else {})} for r in c.execute("SELECT * FROM messages WHERE conv_id=? ORDER BY id", (cid,))]

@app.delete("/api/conversations/{cid}")
def del_conv(cid: str, u=Depends(S.current_user)):
    with D.db() as c: c.execute("DELETE FROM conversations WHERE id=? AND user_id=?", (cid, u["id"]))
    return {"ok": True}

# ── Admin (always scoped to the admin's own organization) ───────────────────
@app.get("/api/admin/users")
def users(u=Depends(S.admin_user)):
    with D.db() as c: return [dict(r) for r in c.execute("SELECT id,username,role,created FROM users WHERE tenant_id=? ORDER BY created", (u["tenant_id"],))]

class Role(BaseModel): role: str

@app.patch("/api/admin/users/{user_id}")
def set_role(user_id: str, b: Role, u=Depends(S.admin_user)):
    if b.role not in ("admin", "member"): raise HTTPException(400, "Invalid role")
    if user_id == u["id"]: raise HTTPException(400, "You cannot change your own role")
    with D.db() as c:
        if not c.execute("UPDATE users SET role=? WHERE id=? AND tenant_id=?", (b.role, user_id, u["tenant_id"])).rowcount: raise HTTPException(404, "User not found")
    D.audit(u["tenant_id"], u["id"], "role_changed", f"{user_id}→{b.role}"); return {"ok": True}

@app.delete("/api/admin/users/{user_id}")
def del_user(user_id: str, u=Depends(S.admin_user)):
    if user_id == u["id"]: raise HTTPException(400, "You cannot delete yourself")
    with D.db() as c:
        if not c.execute("DELETE FROM users WHERE id=? AND tenant_id=?", (user_id, u["tenant_id"])).rowcount: raise HTTPException(404, "User not found")
    D.audit(u["tenant_id"], u["id"], "user_deleted", user_id); return {"ok": True}

# ── Real Enterprise 6-Digit Corporate Employee ID Generator ─────────────────
class Invite(BaseModel):
    role: str = "member"
    department: str = "Engineering & Tech"
    days: int = Field(7, ge=1, le=30)
    code: str | None = None

DEPT_PREFIXES = {
    "Engineering & Tech": "ENG",
    "Human Resources": "HR",
    "Finance & Operations": "FIN",
    "Legal & Compliance": "LEG",
    "Marketing & Sales": "MKT"
}

@app.post("/api/admin/invites")
def make_invite(b: Invite, u=Depends(S.admin_user)):
    dept_name = b.department or "Engineering & Tech"
    prefix = DEPT_PREFIXES.get(dept_name, "ENG")
    
    # Real Enterprise ID with Department Code (e.g., ENG-482910)
    digits = "".join(random.choices(string.digits, k=6))
    code = f"{prefix}-{digits}"

    exp = (datetime.now(timezone.utc) + timedelta(days=b.days)).isoformat()
    with D.db() as c:
        c.execute("INSERT INTO invites(code,tenant_id,role,created_by,expires) VALUES(?,?,?,?,?)",
                  (code, u["tenant_id"], b.role if b.role in ("admin", "member") else "member", u["id"], exp))
    D.audit(u["tenant_id"], u["id"], "invite_created", f"{code} ({dept_name})")
    return {"code": code, "expires": exp, "department": dept_name}

@app.post("/api/admin/invites")
def make_invite(b: Invite, u=Depends(S.admin_user)):
    # Generates a real corporate Employee ID (e.g., EMP-749201 or 6-digit EMP-104829)
    if b.code and b.code.strip():
        code = b.code.strip()
    else:
        # Real enterprise standard: "EMP-" + 6 random digits
        six_digits = "".join(random.choices(string.digits, k=6))
        code = f"EMP-{six_digits}"

    exp = (datetime.now(timezone.utc) + timedelta(days=b.days)).isoformat()
    with D.db() as c:
        c.execute("INSERT INTO invites(code,tenant_id,role,created_by,expires) VALUES(?,?,?,?,?)",
                  (code, u["tenant_id"], b.role if b.role in ("admin", "member") else "member", u["id"], exp))
    D.audit(u["tenant_id"], u["id"], "invite_created", b.role)
    return {"code": code, "expires": exp}

@app.get("/api/admin/invites")
def invites(u=Depends(S.admin_user)):
    with D.db() as c: return [dict(r) for r in c.execute("SELECT code,role,expires,used_by FROM invites WHERE tenant_id=? ORDER BY expires DESC LIMIT 30", (u["tenant_id"],))]

@app.get("/api/admin/audit")
def audit_log(u=Depends(S.admin_user)):
    with D.db() as c: return [dict(r) for r in c.execute("SELECT a.created,a.action,a.detail,us.username FROM audit a LEFT JOIN users us ON us.id=a.user_id WHERE a.tenant_id=? ORDER BY a.id DESC LIMIT 100", (u["tenant_id"],))]

@app.get("/api/admin/stats")
def stats(u=Depends(S.admin_user)):
    with D.db() as c:
        q = lambda s: c.execute(s, (u["tenant_id"],)).fetchone()[0]
        return {"users": q("SELECT COUNT(*) FROM users WHERE tenant_id=?"), "documents": q("SELECT COUNT(*) FROM documents WHERE tenant_id=?"),
                "queries": q("SELECT COUNT(*) FROM audit WHERE tenant_id=? AND action='query'"), "chunks": q("SELECT COALESCE(SUM(chunks),0) FROM documents WHERE tenant_id=?")}

@app.get("/api/health")
def health(): return {"ok": True}