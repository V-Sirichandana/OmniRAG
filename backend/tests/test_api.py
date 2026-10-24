"""End-to-end API tests for the OmniRAG backend.

Run from the backend/ directory:

    python tests/test_api.py

The suite uses a fresh temporary SQLite database per run and disables all LLM
and embedding keys, so it is fully deterministic and makes no external API
calls. It covers authentication, tenant isolation, department + per-document
ACLs, upload/extraction/indexing, retrieval, deletion, invitations, admin
endpoints and error handling.
"""
import io
import json
import os
import sys
import tempfile
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# --- environment must be set BEFORE importing the app -----------------------
_TMP = tempfile.mkdtemp(prefix="omnirag_test_")
os.environ["OMNIRAG_DATA_DIR"] = _TMP
os.environ["DATABASE_URL"] = ""          # sqlite for tests
os.environ["JWT_SECRET"] = "test-secret-0123456789abcdef0123456789abcdef"
os.environ["ALLOW_ORG_SIGNUP"] = "true"
os.environ["CORS_ORIGINS"] = "http://localhost:3000"
os.environ["MAX_UPLOAD_MB"] = "4"
# no external calls during tests:
os.environ["GROQ_API_KEY"] = ""
os.environ["OPENAI_API_KEY"] = ""
os.environ["ANTHROPIC_API_KEY"] = ""
os.environ["GEMINI_API_KEY"] = ""

from fastapi.testclient import TestClient  # noqa: E402

from app import rag  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app).__enter__()   # triggers lifespan -> D.init()

# --- shared state across tests ------------------------------------------------
STATE = {}


def auth(tok):
    return {"Authorization": f"Bearer {tok}"}


def signup(org, user, pw):
    r = client.post("/api/auth/signup-org",
                    json={"org_name": org, "username": user, "password": pw})
    assert r.status_code == 200, r.text
    return r.json()


def upload(tok, name, text, visibility="org", department="", allowed="",
           dept_ids="", download="true"):
    return client.post(
        "/api/documents",
        headers=auth(tok),
        files={"file": (name, text.encode(), "application/octet-stream")},
        data={"visibility": visibility, "department": department,
              "allowed_user_ids": allowed, "department_ids": dept_ids,
              "download_allowed": download})


# ---------------------------------------------------------------------------
TESTS = []


def test(fn):
    TESTS.append(fn)
    return fn


@test
def test_health():
    r = client.get("/api/health").json()
    assert r["ok"] and r["database"] == "sqlite"
    assert r["embeddings"] is False      # no embedding keys in tests
    assert r["llm"] == []                # no LLM keys in tests


@test
def test_signup_org_a():
    s = signup("Acme Corporation", "acme_admin", "password123!")
    STATE["acme"] = s
    u = s["user"]
    assert u["role"] == "admin"
    assert u["tenant_name"] == "Acme Corporation"
    assert u["employee_id"] == "ORG-ADMIN"
    assert u["department"] == "General"
    # Strict department isolation: everyone only ever sees their own
    # department, so the admin works inside Human Resources for this suite.
    r = client.patch(f"/api/admin/users/{u['id']}", headers=auth(s["token"]),
                     json={"department": "Human Resources"})
    assert r.status_code == 200
    assert client.get("/api/auth/me", headers=auth(s["token"])) \
                  .json()["department"] == "Human Resources"


@test
def test_login_and_bad_password():
    bad = client.post("/api/auth/login",
                      json={"username": "acme_admin", "password": "wrong-pass"})
    assert bad.status_code == 401
    ok = client.post("/api/auth/login",
                     json={"username": "acme_admin", "password": "password123!"})
    assert ok.status_code == 200
    me = client.get("/api/auth/me", headers=auth(ok.json()["token"]))
    assert me.status_code == 200 and me.json()["username"] == "acme_admin"


@test
def test_departments_seeded():
    r = client.get("/api/departments", headers=auth(STATE["acme"]["token"]))
    assert r.status_code == 200
    names = [d["name"] for d in r.json()]
    assert len(names) == 5
    assert "Engineering & Tech" in names and "Human Resources" in names


@test
def test_upload_txt_document():
    txt = ("Employee Handbook\n\nParental leave allowance is twenty-four weeks "
           "for all full-time employees. Casual leave is twelve days per year.\n")
    r = upload(STATE["acme"]["token"], "Handbook.txt", txt,
               visibility="org", department="Human Resources")
    assert r.status_code == 200, r.text
    doc = r.json()
    assert doc["chunks"] > 0 and doc["visibility"] == "department"
    # "org" visibility is an alias: it never crosses department lines
    STATE["handbook"] = doc

    docs = client.get("/api/documents", headers=auth(STATE["acme"]["token"])).json()
    assert len(docs) == 1
    assert docs[0]["filename"] == "Handbook.txt"
    assert docs[0]["uploaded_by"] == "acme_admin"
    assert docs[0]["department"] == "Human Resources"


@test
def test_upload_docx():
    import docx
    d = docx.Document()
    d.add_paragraph("Security standard: all production deploys require two approvals.")
    buf = io.BytesIO()
    d.save(buf)
    r = client.post(
        "/api/documents", headers=auth(STATE["acme"]["token"]),
        files={"file": ("Standard.docx", buf.getvalue(),
                        "application/vnd.openxmlformats-officedocument.wordprocessingml.document")},
        data={"visibility": "org", "department": "Engineering & Tech"})
    assert r.status_code == 200, r.text
    assert r.json()["chunks"] > 0
    STATE["standard"] = r.json()


@test
def test_unsupported_type_rejected():
    r = upload(STATE["acme"]["token"], "malware.exe", "boom")
    assert r.status_code == 400
    r = upload(STATE["acme"]["token"], "empty.txt", "")
    assert r.status_code == 422           # no extractable text


@test
def test_invite_and_register_hr_member():
    r = client.post("/api/admin/invites", headers=auth(STATE["acme"]["token"]),
                    json={"role": "member", "department": "Human Resources", "days": 7})
    assert r.status_code == 200, r.text
    code = r.json()["code"]
    assert code.startswith("HR-")
    STATE["hr_code"] = code

    reg = client.post("/api/auth/register",
                      json={"username": "hana_hr", "password": "hrpass1234",
                            "invite_code": code})
    assert reg.status_code == 200, reg.text
    STATE["hr"] = reg.json()
    assert reg.json()["user"]["department"] == "Human Resources"
    assert reg.json()["user"]["employee_id"] == code
    assert reg.json()["user"]["role"] == "member"
    # a member's department list contains ONLY their own department
    depts = client.get("/api/departments", headers=auth(reg.json()["token"])).json()
    assert [d["name"] for d in depts] == ["Human Resources"]


@test
def test_invite_reuse_rejected():
    r = client.post("/api/auth/register",
                    json={"username": "another_one", "password": "pass12345",
                          "invite_code": STATE["hr_code"]})
    assert r.status_code == 400           # already used


@test
def test_member_sees_only_own_department_docs():
    docs = client.get("/api/documents", headers=auth(STATE["hr"]["token"])).json()
    names = {d["filename"] for d in docs}
    assert "Handbook.txt" in names           # own department (Human Resources)
    assert "Standard.docx" not in names      # never Engineering & Tech
    # members must NOT see admin-only fields like allowed_user_ids
    assert all("allowed_user_ids" not in d for d in docs)


@test
def test_department_visibility_isolation():
    # upload a Finance-only document as admin
    r = upload(STATE["acme"]["token"], "Payroll.txt",
               "Salary revision cycle happens every April. Bonus pool is 8 percent.",
               visibility="department", department="Finance & Operations")
    assert r.status_code == 200, r.text
    STATE["payroll"] = r.json()

    # HR member must NOT see it
    docs = client.get("/api/documents", headers=auth(STATE["hr"]["token"])).json()
    assert "Payroll.txt" not in {d["filename"] for d in docs}

    # a Finance member WOULD see it
    inv = client.post("/api/admin/invites", headers=auth(STATE["acme"]["token"]),
                      json={"role": "member", "department": "Finance & Operations"})
    fin = client.post("/api/auth/register",
                      json={"username": "fin_user", "password": "finpass123",
                            "invite_code": inv.json()["code"]}).json()
    STATE["fin"] = fin
    docs = client.get("/api/documents", headers=auth(fin["token"])).json()
    assert "Payroll.txt" in {d["filename"] for d in docs}
    # an HR document never crosses over to Finance, no matter its visibility
    assert "Handbook.txt" not in {d["filename"] for d in docs}

    # the organization admin manages every document of their own organization
    docs = client.get("/api/documents", headers=auth(STATE["acme"]["token"])).json()
    assert "Payroll.txt" in {d["filename"] for d in docs}


@test
def test_restricted_visibility_acl():
    t = auth(STATE["acme"]["token"])
    # two Legal & Compliance members: one granted, one not
    codes = []
    for who in ("lena_leg", "leo_leg"):
        inv = client.post("/api/admin/invites", headers=t,
                          json={"role": "member", "department": "Legal & Compliance"})
        reg = client.post("/api/auth/register",
                          json={"username": who, "password": "legpass123",
                                "invite_code": inv.json()["code"]})
        assert reg.status_code == 200, reg.text
        codes.append(reg.json())
    lena, leo = codes
    STATE["lena"], STATE["leo"] = lena, leo

    r = upload(STATE["acme"]["token"], "BoardSecrets.txt",
               "The acquisition target is Globex. Offer ceiling is 400 million.",
               visibility="restricted", department="Legal & Compliance",
               allowed=lena["user"]["id"])
    assert r.status_code == 200, r.text
    STATE["secrets"] = r.json()

    def names(tok):
        return {d["filename"] for d in
                client.get("/api/documents", headers=auth(tok)).json()}

    assert "BoardSecrets.txt" in names(lena["token"])     # granted, same dept
    assert "BoardSecrets.txt" not in names(leo["token"])  # same dept, NOT granted
    assert "BoardSecrets.txt" not in names(STATE["hr"]["token"])   # other dept
    assert "BoardSecrets.txt" not in names(STATE["fin"]["token"])  # other dept


@test
def test_cross_tenant_isolation():
    other = signup("Apex Global", "apex_admin", "apexpass123!")
    STATE["apex"] = other
    tid = other["user"]["tenant_id"]

    # different tenant sees none of Acme's documents
    docs = client.get("/api/documents", headers=auth(other["token"])).json()
    assert docs == []

    # listing/deleting/downloading another tenant's doc -> 404 (no existence leak)
    doc_id = STATE["handbook"]["id"]
    assert client.delete(f"/api/documents/{doc_id}",
                         headers=auth(other["token"])).status_code == 404
    assert client.get(f"/api/documents/{doc_id}/download",
                      headers=auth(other["token"])).status_code == 404
    # and retrieval scoped to the wrong tenant returns nothing
    assert rag.search(tid, [doc_id], "parental leave weeks") == []


@test
def test_cross_tenant_username_conflict():
    r = client.post("/api/auth/signup-org",
                    json={"org_name": "CloneCorp", "username": "acme_admin",
                          "password": "whatever123"})
    assert r.status_code == 409           # usernames are globally unique


@test
def test_retrieval_returns_citations_metadata():
    hits = rag.search(STATE["acme"]["user"]["tenant_id"],
                      [STATE["handbook"]["id"], STATE["standard"]["id"]],
                      "how many weeks of parental leave")
    assert hits, "expected BM25 hits"
    top = hits[0]
    assert top["meta"]["filename"] == "Handbook.txt"
    assert top["meta"]["page"] >= 1
    assert "twenty-four weeks" in top["text"]


@test
def test_chat_returns_503_without_llm_key():
    r = client.post("/api/chat", headers=auth(STATE["acme"]["token"]),
                    json={"question": "How many weeks of parental leave?"})
    assert r.status_code == 503
    assert "key" in r.json()["detail"].lower()


@test
def test_no_orphan_conversations_after_failure():
    r = client.get("/api/conversations", headers=auth(STATE["acme"]["token"]))
    assert r.status_code == 200 and r.json() == []


@test
def test_download_roundtrip():
    original = "Employee Handbook content for download check."
    r = upload(STATE["acme"]["token"], "Down.txt", original)
    did = r.json()["id"]
    dl = client.get(f"/api/documents/{did}/download",
                    headers=auth(STATE["acme"]["token"]))
    assert dl.status_code == 200
    assert dl.content == original.encode()
    assert "Down.txt" in dl.headers.get("content-disposition", "")
    # a member of the same department can download it too
    dl2 = client.get(f"/api/documents/{did}/download",
                     headers=auth(STATE["hr"]["token"]))
    assert dl2.status_code == 200
    client.delete(f"/api/documents/{did}", headers=auth(STATE["acme"]["token"]))


@test
def test_delete_doc_removes_chunks():
    tid = STATE["acme"]["user"]["tenant_id"]
    # the organization admin manages (and can delete) documents across
    # departments — but never in another organization (404)
    r = client.delete(f"/api/documents/{STATE['payroll']['id']}",
                      headers=auth(STATE["acme"]["token"]))
    assert r.status_code == 200

    # delete a document of the admin's own department
    r = upload(STATE["acme"]["token"], "Scrap.txt",
               "Temporary notes about bonus pool percent changes.")
    assert r.status_code == 200, r.text
    doc_id = r.json()["id"]
    assert rag.search(tid, [doc_id], "bonus pool percent")
    r = client.delete(f"/api/documents/{doc_id}", headers=auth(STATE["acme"]["token"]))
    assert r.status_code == 200
    assert rag.search(tid, [doc_id], "bonus pool percent") == []
    # members can't delete anything
    r = client.delete(f"/api/documents/{STATE['handbook']['id']}",
                      headers=auth(STATE["hr"]["token"]))
    assert r.status_code == 403


@test
def test_invites_list_shows_status():
    r = client.get("/api/admin/invites", headers=auth(STATE["acme"]["token"]))
    assert r.status_code == 200
    rows = r.json()
    hr = next(x for x in rows if x["code"] == STATE["hr_code"])
    assert hr["joined_by"] == "hana_hr" and hr["department"] == "Human Resources"


@test
def test_admin_users_list_and_updates():
    r = client.get("/api/admin/users", headers=auth(STATE["acme"]["token"]))
    assert r.status_code == 200
    users = {u["username"]: u for u in r.json()}
    assert {"acme_admin", "hana_hr", "fin_user"} <= set(users)
    assert users["fin_user"]["department"] == "Finance & Operations"

    fin_id = users["fin_user"]["id"]
    # change department
    r = client.patch(f"/api/admin/users/{fin_id}",
                     headers=auth(STATE["acme"]["token"]),
                     json={"department": "Engineering & Tech"})
    assert r.status_code == 200
    # unknown department rejected
    r = client.patch(f"/api/admin/users/{fin_id}",
                     headers=auth(STATE["acme"]["token"]),
                     json={"department": "Nowhere"})
    assert r.status_code == 400
    # members cannot manage users
    r = client.get("/api/admin/users", headers=auth(STATE["hr"]["token"]))
    assert r.status_code == 403


@test
def test_admin_cannot_demote_self():
    r = client.patch(f"/api/admin/users/{STATE['acme']['user']['id']}",
                     headers=auth(STATE["acme"]["token"]), json={"role": "member"})
    assert r.status_code == 400


@test
def test_member_cannot_use_admin_endpoints():
    t = auth(STATE["hr"]["token"])
    assert client.get("/api/admin/users", headers=t).status_code == 403
    assert client.post("/api/admin/invites", headers=t, json={}).status_code == 403
    assert client.get("/api/admin/stats", headers=t).status_code == 403
    assert client.post("/api/documents", headers=t,
                       files={"file": ("x.txt", b"y", "text/plain")}).status_code == 403


@test
def test_department_crud():
    t = auth(STATE["acme"]["token"])
    r = client.post("/api/departments", headers=t, json={"name": "Research Lab", "code": "RSH"})
    assert r.status_code == 200
    did = r.json()["id"]
    # duplicate rejected
    assert client.post("/api/departments", headers=t,
                       json={"name": "Research Lab"}).status_code == 409
    # member cannot create departments
    assert client.post("/api/departments", headers=auth(STATE["hr"]["token"]),
                       json={"name": "Sneaky Dept"}).status_code == 403
    # delete empty department
    assert client.delete(f"/api/departments/{did}", headers=t).status_code == 200
    # department with documents cannot be deleted
    hr = next(d for d in client.get("/api/departments", headers=t).json()
              if d["name"] == "Human Resources")
    assert hr["documents"] >= 1
    assert client.delete(f"/api/departments/{hr['id']}", headers=t).status_code == 400


@test
def test_admin_stats_and_audit():
    t = auth(STATE["acme"]["token"])
    stats = client.get("/api/admin/stats", headers=t).json()
    assert stats["users"] >= 3 and stats["documents"] >= 3 and stats["queries"] == 0
    audit = client.get("/api/admin/audit", headers=t).json()
    actions = {a["action"] for a in audit}
    assert {"org_created", "login", "doc_uploaded", "invite_created",
            "user_joined", "doc_deleted"} <= actions
    # audit is tenant-scoped: Apex admin sees only their own entries
    apex_audit = client.get("/api/admin/audit",
                            headers=auth(STATE["apex"]["token"])).json()
    assert {a["action"] for a in apex_audit} == {"org_created"}


@test
def test_duplicate_org_username_and_bad_login_lockout():
    # signup with an existing username -> 409
    r = client.post("/api/auth/signup-org",
                    json={"org_name": "X Corp", "username": "apex_admin",
                          "password": "longenough1"})
    assert r.status_code == 409
    # 5 failed logins lock the account for a few minutes
    for _ in range(5):
        client.post("/api/auth/login",
                    json={"username": "apex_admin", "password": "nope"})
    r = client.post("/api/auth/login",
                    json={"username": "apex_admin", "password": "apexpass123!"})
    assert r.status_code == 429


@test
def test_conversation_isolation():
    # apex creates a conversation -> only apex can read it
    apex_tok = STATE["apex"]["token"]
    # (chat fails without LLM, so exercise conversation endpoints directly)
    convs = client.get("/api/conversations", headers=auth(apex_tok)).json()
    assert convs == []
    r = client.get(f"/api/conversations/{uuid.uuid4().hex}", headers=auth(apex_tok))
    assert r.status_code == 404
    assert client.get(f"/api/conversations/{uuid.uuid4().hex}",
                      headers=auth(STATE["acme"]["token"])).status_code == 404


@test
def test_conversation_delete_authorization():
    # a conversation exists only via successful chat, which needs an LLM key
    # the test suite doesn't have — so seed one directly through the db layer
    from app import db as D
    cid = D.uid()
    with D.db() as c:
        c.execute("INSERT INTO conversations(id,user_id,tenant_id,title) VALUES(?,?,?,?)",
                  (cid, STATE["apex"]["user"]["id"], STATE["apex"]["user"]["tenant_id"],
                   "internal notes"))
    # other org / other user -> 404, and the conversation must survive
    assert client.delete(f"/api/conversations/{cid}",
                         headers=auth(STATE["acme"]["token"])).status_code == 404
    assert client.delete(f"/api/conversations/{uuid.uuid4().hex}",
                         headers=auth(STATE["apex"]["token"])).status_code == 404
    assert client.get(f"/api/conversations/{cid}",
                      headers=auth(STATE["apex"]["token"])).status_code == 200
    # the owner can delete it
    assert client.delete(f"/api/conversations/{cid}",
                         headers=auth(STATE["apex"]["token"])).status_code == 200


@test
def test_search_endpoint_citations_and_isolation():
    # unauthenticated -> 401; invalid query -> 422
    assert client.post("/api/search", json={"query": "leave"}).status_code == 401
    h = auth(STATE["acme"]["token"])
    assert client.post("/api/search", headers=h, json={"query": ""}).status_code == 422

    # a Finance document whose content WOULD match the query below
    r = upload(STATE["acme"]["token"], "FinLeak.txt",
               "Parental leave for contractors is six weeks after probation.",
               department="Finance & Operations")
    assert r.status_code == 200, r.text
    fin_leak = r.json()["id"]

    # HR member searches, trying to smuggle the Finance doc id into the body:
    # the backend derives its scope from the token, never from client input
    r = client.post("/api/search", headers=auth(STATE["hr"]["token"]),
                    json={"query": "parental leave weeks",
                          "doc_ids": [fin_leak, STATE["handbook"]["id"]]})
    assert r.status_code == 200, r.text
    results = r.json()["results"]
    assert results, "expected own-department hits"
    top = results[0]
    assert top["filename"] == "Handbook.txt" and top["doc_id"] == STATE["handbook"]["id"]
    assert top["page"] >= 1 and "twenty-four weeks" in top["text"]
    assert fin_leak not in {x["doc_id"] for x in results}
    assert "FinLeak.txt" not in {x["filename"] for x in results}

    # another organization gets nothing
    r = client.post("/api/search", headers=auth(STATE["apex"]["token"]),
                    json={"query": "parental leave weeks"})
    assert r.status_code == 200 and r.json()["results"] == []

    # searches are recorded in the admin audit trail
    audit = client.get("/api/admin/audit", headers=h).json()
    assert "search" in {a["action"] for a in audit}


@test
def test_search_respects_restricted_acl():
    q = "acquisition target offer ceiling"
    r = client.post("/api/search", headers=auth(STATE["lena"]["token"]),
                    json={"query": q})
    assert r.status_code == 200, r.text
    assert STATE["secrets"]["id"] in {x["doc_id"] for x in r.json()["results"]}
    # leo is in the same department but was never granted the ACL
    r = client.post("/api/search", headers=auth(STATE["leo"]["token"]),
                    json={"query": q})
    assert r.status_code == 200
    assert STATE["secrets"]["id"] not in {x["doc_id"] for x in r.json()["results"]}


@test
def test_malformed_and_oversized_files_rejected():
    h = auth(STATE["acme"]["token"])
    before = len(client.get("/api/documents", headers=h).json())
    # corrupt PDF -> 422 with no orphan row left behind
    r = client.post("/api/documents", headers=h,
                    files={"file": ("Corrupt.pdf", b"%PDF-1.4 not really a pdf",
                                    "application/pdf")},
                    data={"department": "Human Resources"})
    assert r.status_code == 422, r.text
    # above MAX_UPLOAD_MB -> 413
    r = upload(STATE["acme"]["token"], "Big.txt", "x" * (4 * 1024 * 1024 + 1024))
    assert r.status_code == 413
    assert len(client.get("/api/documents", headers=h).json()) == before


@test
def test_org_admin_scope_and_cross_org_boundary():
    t = auth(STATE["acme"]["token"])
    # the organization admin sees every document of their own organization,
    # including other departments' and restricted documents (for management)
    names = {d["filename"] for d in client.get("/api/documents", headers=t).json()}
    assert {"Handbook.txt", "Standard.docx", "BoardSecrets.txt"} <= names

    # an admin of another organization manages only their own data
    apex_t = auth(STATE["apex"]["token"])
    r = upload(STATE["apex"]["token"], "ApexOnly.txt", "Apex internal roadmap for 2027.")
    assert r.status_code == 200, r.text
    apex_doc = r.json()["id"]
    assert "ApexOnly.txt" not in {d["filename"] for d in client.get("/api/documents", headers=t).json()}
    assert client.get(f"/api/documents/{apex_doc}/download", headers=t).status_code == 404
    assert client.delete(f"/api/documents/{apex_doc}", headers=t).status_code == 404
    assert client.patch(f"/api/documents/{apex_doc}/access", headers=t,
                        json={"visibility": "organization"}).status_code == 404
    # retrieval never leaks across organizations either
    r = client.post("/api/search", headers=t, json={"query": "internal roadmap 2027"})
    assert r.status_code == 200 and r.json()["results"] == []
    assert client.get("/api/documents", headers=apex_t).json()  # apex keeps its doc
    assert "ApexOnly.txt" in {d["filename"] for d in client.get("/api/documents", headers=apex_t).json()}


@test
def test_organization_wide_document():
    r = upload(STATE["acme"]["token"], "CompanyWide.txt",
               "All-staff town hall is on the first Friday of every month.",
               visibility="organization")
    assert r.status_code == 200, r.text
    doc = r.json()
    assert doc["visibility"] == "organization" and doc["department"] == ""
    STATE["companywide"] = doc

    def names(tok):
        return {d["filename"] for d in client.get("/api/documents", headers=auth(tok)).json()}

    # members of every department of the organization can see and query it
    assert "CompanyWide.txt" in names(STATE["hr"]["token"])
    assert "CompanyWide.txt" in names(STATE["fin"]["token"])
    assert "CompanyWide.txt" in names(STATE["lena"]["token"])
    r = client.post("/api/search", headers=auth(STATE["lena"]["token"]),
                    json={"query": "town hall first Friday"})
    hits = {x["doc_id"] for x in r.json()["results"]}
    assert STATE["companywide"]["id"] in hits
    # but never another organization's documents
    r = client.post("/api/search", headers=auth(STATE["apex"]["token"]),
                    json={"query": "town hall first Friday"})
    assert r.json()["results"] == []


@test
def test_selected_departments_document():
    t = auth(STATE["acme"]["token"])
    depts = {d["name"]: d["id"] for d in client.get("/api/departments", headers=t).json()}
    hr_id, fin_id = depts["Human Resources"], depts["Finance & Operations"]
    apex_dept = client.get("/api/departments",
                           headers=auth(STATE["apex"]["token"])).json()[0]["id"]

    body = "Procurement policy: orders above 5000 need CFO sign-off."
    # validation: at least one target — and only departments of the caller's org
    r = upload(STATE["acme"]["token"], "Multi.txt", body,
               visibility="selected_departments")
    assert r.status_code == 400
    r = upload(STATE["acme"]["token"], "Multi.txt", body,
               visibility="selected_departments", dept_ids=f"{hr_id},{apex_dept}")
    assert r.status_code == 400
    r = upload(STATE["acme"]["token"], "Multi.txt", body,
               visibility="selected_departments", dept_ids=f"{hr_id},{fin_id}")
    assert r.status_code == 200, r.text
    multi = r.json()
    assert multi["visibility"] == "selected_departments" and multi["department"] == ""
    STATE["multi"] = multi

    def names(tok):
        return {d["filename"] for d in client.get("/api/documents", headers=auth(tok)).json()}

    # (fin_user was moved to Engineering by an earlier test — register a
    # fresh Finance member so the positive check is unambiguous)
    inv = client.post("/api/admin/invites", headers=t,
                      json={"role": "member", "department": "Finance & Operations"})
    fin2 = client.post("/api/auth/register",
                       json={"username": "fin_multi", "password": "finpass456",
                             "invite_code": inv.json()["code"]}).json()
    STATE["fin2"] = fin2
    assert "Multi.txt" in names(STATE["hr"]["token"])       # selected
    assert "Multi.txt" in names(fin2["token"])              # selected (Finance)
    assert "Multi.txt" not in names(STATE["leo"]["token"])  # not selected
    assert "Multi.txt" not in names(STATE["apex"]["token"])
    # the list response exposes the resolved department targets
    row = next(d for d in client.get("/api/documents", headers=t).json()
               if d["filename"] == "Multi.txt")
    assert {d["name"] for d in row["departments"]} == {"Human Resources", "Finance & Operations"}
    # a selected-department user can query it; an unselected one cannot
    s = client.post("/api/search", headers=auth(STATE["hr"]["token"]),
                    json={"query": "procurement CFO sign-off"})
    assert STATE["multi"]["id"] in {x["doc_id"] for x in s.json()["results"]}
    s = client.post("/api/search", headers=auth(STATE["leo"]["token"]),
                    json={"query": "procurement CFO sign-off"})
    assert STATE["multi"]["id"] not in {x["doc_id"] for x in s.json()["results"]}


@test
def test_download_permission_separate_from_query():
    r = upload(STATE["acme"]["token"], "NoDown.txt",
               "Quarterly fire drill happens on Friday at noon.",
               visibility="organization", download="false")
    assert r.status_code == 200, r.text
    nid = r.json()["id"]
    assert r.json()["download_allowed"] is False

    # members may still QUERY it …
    s = client.post("/api/search", headers=auth(STATE["hr"]["token"]),
                    json={"query": "fire drill Friday noon"})
    assert nid in {x["doc_id"] for x in s.json()["results"]}
    # … but the download itself is refused
    dl = client.get(f"/api/documents/{nid}/download", headers=auth(STATE["hr"]["token"]))
    assert dl.status_code == 403
    # the organization admin can always download their organization's files
    assert client.get(f"/api/documents/{nid}/download",
                      headers=auth(STATE["acme"]["token"])).status_code == 200
    # explicitly enabling download grants members access
    r = client.patch(f"/api/documents/{nid}/access", headers=auth(STATE["acme"]["token"]),
                     json={"visibility": "organization", "download_allowed": True})
    assert r.status_code == 200
    assert client.get(f"/api/documents/{nid}/download",
                      headers=auth(STATE["hr"]["token"])).status_code == 200


@test
def test_access_endpoint_acl_management():
    t = auth(STATE["acme"]["token"])
    sid = STATE["secrets"]["id"]
    lena_id, leo_id = STATE["lena"]["user"]["id"], STATE["leo"]["user"]["id"]

    # grant leo as well — both Legal members can see it now
    r = client.patch(f"/api/documents/{sid}/access", headers=t,
                     json={"visibility": "restricted", "allowed_user_ids": [lena_id, leo_id]})
    assert r.status_code == 200, r.text
    names = {d["filename"] for d in client.get("/api/documents", headers=auth(STATE["leo"]["token"])).json()}
    assert "BoardSecrets.txt" in names
    # revoke leo — access disappears again
    r = client.patch(f"/api/documents/{sid}/access", headers=t,
                     json={"visibility": "restricted", "allowed_user_ids": [lena_id]})
    assert r.status_code == 200
    names = {d["filename"] for d in client.get("/api/documents", headers=auth(STATE["leo"]["token"])).json()}
    assert "BoardSecrets.txt" not in names
    # users of other organizations can never be granted
    apex_user = client.get("/api/admin/users", headers=auth(STATE["apex"]["token"])).json()[0]["id"]
    r = client.patch(f"/api/documents/{sid}/access", headers=t,
                     json={"visibility": "restricted", "allowed_user_ids": [apex_user]})
    assert r.status_code == 400
    # members cannot manage permissions at all
    r = client.patch(f"/api/documents/{sid}/access", headers=auth(STATE["hr"]["token"]),
                     json={"visibility": "restricted", "allowed_user_ids": []})
    assert r.status_code == 403


@test
def test_selected_departments_via_access_endpoint_and_legacy_rows():
    t = auth(STATE["acme"]["token"])
    depts = {d["name"]: d["id"] for d in client.get("/api/departments", headers=t).json()}
    # retarget the Engineering document to include HR as well
    r = client.patch(f"/api/documents/{STATE['standard']['id']}/access", headers=t,
                     json={"visibility": "selected_departments",
                           "department_ids": [depts["Engineering & Tech"],
                                              depts["Human Resources"]]})
    assert r.status_code == 200, r.text
    names = {d["filename"] for d in client.get("/api/documents", headers=auth(STATE["hr"]["token"])).json()}
    assert "Standard.docx" in names            # HR was selected
    names = {d["filename"] for d in client.get("/api/documents", headers=auth(STATE["leo"]["token"])).json()}
    assert "Standard.docx" not in names        # Legal was not

    # legacy rows (visibility='org' written by older releases) stay
    # department-scoped forever — pre-existing access is preserved
    from app import db as D
    legacy_id = D.uid()
    with D.db() as c:
        c.execute("INSERT INTO documents(id,tenant_id,filename,visibility,department,uploaded_by,chunks)"
                  " VALUES(?,?,?,?,?,?,?)",
                  (legacy_id, STATE["acme"]["user"]["tenant_id"], "Legacy.txt", "org",
                   "Legal & Compliance", STATE["acme"]["user"]["id"], 0))
    names = {d["filename"] for d in client.get("/api/documents", headers=auth(STATE["leo"]["token"])).json()}
    assert "Legacy.txt" in names               # same department → visible
    names = {d["filename"] for d in client.get("/api/documents", headers=auth(STATE["hr"]["token"])).json()}
    assert "Legacy.txt" not in names           # other department → invisible


@test
def test_manager_designation_defaults_and_admin_toggle():
    """users.is_manager: additive flag, default 0, toggled only by an admin
    of the same organization — a workspace gate, not a privilege."""
    t = auth(STATE["acme"]["token"])
    users = {u["username"]: u for u in client.get("/api/admin/users", headers=t).json()}
    assert users["acme_admin"]["is_manager"] in (0, False)   # default for existing users
    assert users["hana_hr"]["is_manager"] in (0, False)

    hr_id = users["hana_hr"]["id"]
    assert client.patch(f"/api/admin/users/{hr_id}", headers=t,
                        json={"is_manager": True}).status_code == 200
    users = {u["username"]: u for u in client.get("/api/admin/users", headers=t).json()}
    assert users["hana_hr"]["is_manager"] in (1, True)
    # the session payload reflects it (server-derived; never client-settable)
    me = client.get("/api/auth/me", headers=auth(STATE["hr"]["token"])).json()
    assert me["is_manager"] in (1, True)
    # role/department untouched by the designation change
    assert me["role"] == "member" and me["department"] == "Human Resources"

    assert client.patch(f"/api/admin/users/{hr_id}", headers=t,
                        json={"is_manager": False}).status_code == 200
    me = client.get("/api/auth/me", headers=auth(STATE["hr"]["token"])).json()
    assert me["is_manager"] in (0, False)


@test
def test_manager_designation_requires_admin_and_stays_in_tenant():
    # a member cannot change designations (admin endpoint, 403)
    r = client.patch(f"/api/admin/users/{STATE['acme']['user']['id']}",
                     headers=auth(STATE["hr"]["token"]), json={"is_manager": True})
    assert r.status_code == 403
    # a foreign tenant's user id is invisible to this admin (404, no cross-tenant write)
    r = client.patch(f"/api/admin/users/{STATE['apex']['user']['id']}",
                     headers=auth(STATE["acme"]["token"]), json={"is_manager": True})
    assert r.status_code == 404
    # ...and the foreign user's designation/session is untouched
    apex_me = client.get("/api/auth/me", headers=auth(STATE["apex"]["token"])).json()
    assert apex_me["is_manager"] in (0, False)


@test
def test_team_overview_gated_with_no_new_privileges():
    t_admin = auth(STATE["acme"]["token"])
    hr_t = auth(STATE["hr"]["token"])

    # (a) designation required: plain member AND plain admin both get 403
    assert client.get("/api/team/overview", headers=hr_t).status_code == 403, \
        "non-manager member must be refused"
    assert client.get("/api/team/overview", headers=t_admin).status_code == 403, \
        "role alone must not open the manager workspace"

    # give the HR member a fresh department document to anchor the assertions
    r = upload(STATE["acme"]["token"], "ManagerGuide.txt",
               "Team guide used by the manager workspace test.", "department",
               "Human Resources")
    assert r.status_code == 200, r.text

    # (b) grant designation → 200, payload stays within the caller's authority
    users = {u["username"]: u for u in client.get("/api/admin/users", headers=t_admin).json()}
    assert client.patch(f"/api/admin/users/{users['hana_hr']['id']}", headers=t_admin,
                        json={"is_manager": True}).status_code == 200
    r = client.get("/api/team/overview", headers=hr_t)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["department"] == "Human Resources" and body["member_count"] >= 1, body
    assert body["document_count"] == len(body["documents"]) >= 1, body
    # every returned document is already visible via the normal listing …
    listed = {d["id"] for d in client.get("/api/documents", headers=hr_t).json()}
    team_ids = {d["id"] for d in body["documents"]}
    assert team_ids <= listed, "team endpoint returned an unauthorized document"
    # … and confined to the caller's own department or explicitly selected for it
    # (no cross-department or cross-tenant reach)
    assert all(d["department"] == "Human Resources"
               or d["visibility"] == "selected_departments"
               for d in body["documents"]), body["documents"]

    # (c) cross-tenant: even a designated admin of another org sees only their own
    apex_t = auth(STATE["apex"]["token"])
    apex_users = {u["username"]: u
                  for u in client.get("/api/admin/users", headers=apex_t).json()}
    apex_admin_id = apex_users[STATE["apex"]["user"]["username"]]["id"]
    assert client.patch(f"/api/admin/users/{apex_admin_id}", headers=apex_t,
                        json={"is_manager": True}).status_code == 200
    r = client.get("/api/team/overview", headers=apex_t)
    assert r.status_code == 200, r.text
    names = {d["filename"] for d in r.json()["documents"]}
    assert "ManagerGuide.txt" not in names      # never leaks into another tenant

    # revoke both designations so later runs start from the default state
    client.patch(f"/api/admin/users/{apex_admin_id}", headers=apex_t,
                 json={"is_manager": False})
    client.patch(f"/api/admin/users/{users['hana_hr']['id']}", headers=t_admin,
                 json={"is_manager": False})


@test
def test_admin_stats_include_storage_bytes():
    stats = client.get("/api/admin/stats", headers=auth(STATE["acme"]["token"])).json()
    assert isinstance(stats.get("storage"), int) and stats["storage"] > 0
    # admin-only, as before
    assert client.get("/api/admin/stats", headers=auth(STATE["hr"]["token"])).status_code == 403


# --- Stage A: work-email identity -------------------------------------------

@test
def test_email_login():
    # Org created WITH a work email (optional field — old clients send none).
    r = client.post("/api/auth/signup-org",
                    json={"org_name": "Mail & Co", "username": "mail_owner",
                          "password": "mailpass123!", "email": "Owner@Mail-Co.Example"})
    assert r.status_code == 200, r.text
    s = r.json()
    STATE["mailco"] = s
    # stored normalized (trim+lowercase) and surfaced in session, me, directory
    assert s["user"]["email"] == "owner@mail-co.example"
    me = client.get("/api/auth/me", headers=auth(s["token"])).json()
    assert me["email"] == "owner@mail-co.example"
    users = {u["username"]: u for u in
             client.get("/api/admin/users", headers=auth(s["token"])).json()}
    assert users["mail_owner"]["email"] == "owner@mail-co.example"

    # login by work email — exact, plus mixed case and surrounding spaces
    for ident in ("owner@mail-co.example", "  OWNER@Mail-Co.Example "):
        ok = client.post("/api/auth/login",
                         json={"username": ident, "password": "mailpass123!"})
        assert ok.status_code == 200, ok.text
        assert ok.json()["user"]["tenant_id"] == s["user"]["tenant_id"]
    # wrong password over the email identifier stays a generic 401
    bad = client.post("/api/auth/login",
                      json={"username": "owner@mail-co.example", "password": "nope"})
    assert bad.status_code == 401
    # legacy username login works for the very same email-bearing account
    ok = client.post("/api/auth/login",
                     json={"username": "mail_owner", "password": "mailpass123!"})
    assert ok.status_code == 200
    assert ok.json()["user"]["email"] == "owner@mail-co.example"


@test
def test_username_login_still_works_without_email():
    # Accounts created the old way (invite + username, NO email) are untouched.
    inv = client.post("/api/admin/invites", headers=auth(STATE["acme"]["token"]),
                      json={"role": "member", "department": "Engineering & Tech", "days": 7})
    assert inv.status_code == 200, inv.text
    reg = client.post("/api/auth/register",
                      json={"username": "legacy_worker", "password": "legacypass1",
                            "invite_code": inv.json()["code"]})
    assert reg.status_code == 200, reg.text
    assert reg.json()["user"]["email"] is None
    # old payload, old identifier — byte-for-byte compatible behavior
    ok = client.post("/api/auth/login",
                     json={"username": "legacy_worker", "password": "legacypass1"})
    assert ok.status_code == 200, ok.text
    me = client.get("/api/auth/me", headers=auth(ok.json()["token"])).json()
    assert me["username"] == "legacy_worker" and me["email"] is None


@test
def test_email_uniqueness():
    t_acme = auth(STATE["acme"]["token"])
    admin_id = STATE["acme"]["user"]["id"]
    users = {u["username"]: u for u in client.get("/api/admin/users", headers=t_acme).json()}

    # set the admin's own work email; re-setting it (normalized) stays allowed
    r = client.patch(f"/api/admin/users/{admin_id}", headers=t_acme,
                     json={"email": "boss@acme-corp.example"})
    assert r.status_code == 200, r.text
    r = client.patch(f"/api/admin/users/{admin_id}", headers=t_acme,
                     json={"email": "BOSS@Acme-Corp.Example"})
    assert r.status_code == 200, r.text

    # global uniqueness across organizations — case-insensitive, at signup …
    r = client.post("/api/auth/signup-org",
                    json={"org_name": "Squat Corp", "username": "squat_admin",
                          "password": "squatpass123", "email": "boss@acme-corp.example"})
    assert r.status_code == 409
    # … and via admin PATCH onto another member
    r = client.patch(f"/api/admin/users/{users['hana_hr']['id']}", headers=t_acme,
                     json={"email": "Boss@Acme-Corp.example"})
    assert r.status_code == 409
    # malformed values are rejected without writing anything
    r = client.patch(f"/api/admin/users/{users['hana_hr']['id']}", headers=t_acme,
                     json={"email": "not-an-email"})
    assert r.status_code == 400
    # set + clear (explicit null) round-trips through the directory
    r = client.patch(f"/api/admin/users/{users['hana_hr']['id']}", headers=t_acme,
                     json={"email": "HANA@Acme-Corp.Example"})
    assert r.status_code == 200
    after = {u["username"]: u for u in client.get("/api/admin/users", headers=t_acme).json()}
    assert after["hana_hr"]["email"] == "hana@acme-corp.example"
    r = client.patch(f"/api/admin/users/{users['hana_hr']['id']}", headers=t_acme,
                     json={"email": None})
    assert r.status_code == 200
    after = {u["username"]: u for u in client.get("/api/admin/users", headers=t_acme).json()}
    assert after["hana_hr"]["email"] is None
    # an omitted field (old PATCH bodies) never touches the stored email
    r = client.patch(f"/api/admin/users/{admin_id}", headers=t_acme,
                     json={"department": "Human Resources"})
    assert r.status_code == 200
    after = {u["username"]: u for u in client.get("/api/admin/users", headers=t_acme).json()}
    assert after["acme_admin"]["email"] == "boss@acme-corp.example"


@test
def test_cross_tenant_email_isolation():
    t_acme = auth(STATE["acme"]["token"])
    t_apex = auth(STATE["apex"]["token"])
    acme_id = STATE["acme"]["user"]["id"]
    acme_user = STATE["acme"]["user"]["username"]

    # another organization's admin cannot touch the Acme account (404, no leak)
    r = client.patch(f"/api/admin/users/{acme_id}", headers=t_apex,
                     json={"email": "attacker@apex-global.example"})
    assert r.status_code == 404
    # Acme's own admin may set a work email
    r = client.patch(f"/api/admin/users/{acme_id}", headers=t_acme,
                     json={"email": "iso@acme-corp.example"})
    assert r.status_code == 200, r.text

    # the other tenant's directory lists only its own people and emails
    apex_users = client.get("/api/admin/users", headers=t_apex).json()
    assert "iso@acme-corp.example" not in {u.get("email") for u in apex_users}
    assert acme_user not in {u["username"] for u in apex_users}

    # logging in with that email always resolves to the OWNING tenant
    ok = client.post("/api/auth/login",
                     json={"username": "iso@acme-corp.example",
                           "password": "password123!"})
    assert ok.status_code == 200, ok.text
    assert ok.json()["user"]["tenant_id"] == STATE["acme"]["user"]["tenant_id"]

    # global uniqueness blocks the other tenant from claiming the same email
    r = client.patch(f"/api/admin/users/{STATE['apex']['user']['id']}",
                     headers=t_apex, json={"email": "iso@acme-corp.example"})
    assert r.status_code == 409


@test
def test_init_migrates_existing_database():
    """Stage A schema changes are additive + idempotent on a PRE-EXISTING DB."""
    import sqlite3
    from app import db as D

    legacy = os.path.join(_TMP, "legacy_stageA.db")
    con = sqlite3.connect(legacy)
    con.executescript(
        """
        CREATE TABLE tenants(id TEXT PRIMARY KEY, name TEXT NOT NULL,
                             created TEXT DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE users(
          id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, pw_hash TEXT NOT NULL,
          tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          role TEXT NOT NULL DEFAULT 'member',
          department TEXT NOT NULL DEFAULT 'General',
          employee_id TEXT,
          is_manager INTEGER NOT NULL DEFAULT 0,
          created TEXT DEFAULT CURRENT_TIMESTAMP);
        INSERT INTO tenants(id,name) VALUES('t_legacy','Legacy Co');
        INSERT INTO users(id,username,pw_hash,tenant_id,role)
            VALUES('u_legacy','old_timer','x','t_legacy','admin');
        """)
    con.commit()
    con.close()

    original = D.DB_PATH
    try:
        D.DB_PATH = legacy
        D.init()                                   # migration run #1
        con = sqlite3.connect(legacy)
        # email column was added …
        cols = {r[1] for r in con.execute("PRAGMA table_info(users)")}
        assert "email" in cols, "email column missing on an existing database"
        # … with a UNIQUE partial index over email …
        idx = {r[1]: r for r in con.execute("PRAGMA index_list(users)")}
        assert "idx_users_email" in idx and idx["idx_users_email"][2] == 1, idx
        icols = [r[2] for r in con.execute("PRAGMA index_info(idx_users_email)")]
        assert icols == ["email"], icols
        # … and the R2 case-insensitive partial index alongside it
        assert "idx_users_email_ci" in idx and idx["idx_users_email_ci"][2] == 1 \
            and idx["idx_users_email_ci"][4] == 1, idx
        # … while the pre-existing row is untouched (email NULL = legacy login)
        row = con.execute(
            "SELECT username,email,role FROM users WHERE id='u_legacy'").fetchone()
        assert row == ("old_timer", None, "admin"), row
        # the migrated database enforces email uniqueness …
        con.execute(
            "INSERT INTO users(id,username,pw_hash,tenant_id,email) "
            "VALUES('u_e1','dup_a','x','t_legacy','same@legacy.example')")
        con.commit()
        try:
            con.execute(
                "INSERT INTO users(id,username,pw_hash,tenant_id,email) "
                "VALUES('u_e2','dup_b','x','t_legacy','same@legacy.example')")
            con.commit()
            raise AssertionError("duplicate email accepted on migrated database")
        except sqlite3.IntegrityError:
            pass
        finally:
            con.close()
        D.init()                                   # run #2: idempotent, no error
    finally:
        D.DB_PATH = original


# --- Stage A hardening: R1 shadowing, R2 DB-level CI uniqueness, R3 races ----

@test
def test_email_may_not_shadow_another_username():
    """R1: an email equal to ANOTHER account's username is rejected on both
    email write paths; plain username login behavior stays untouched."""
    t_acme = auth(STATE["acme"]["token"])
    users = {u["username"]: u for u in client.get("/api/admin/users", headers=t_acme).json()}
    # a member whose USERNAME looks like an email (the shadowing vector).
    # Registration now refuses to CREATE '@'-usernames (the race fix — see
    # test_signup_org_rejects_at_username), so the legacy account is seeded
    # exactly as a pre-fix database still holds it: the new rule never
    # renames, deletes or modifies existing rows, and login is unchanged.
    import sqlite3
    from app import db as D
    from app import security as S
    shadow_id = uuid.uuid4().hex
    con = sqlite3.connect(D.DB_PATH)
    con.execute(
        "INSERT INTO users(id,username,email,pw_hash,tenant_id,role,department,employee_id) "
        "VALUES(?,?,?,?,?,?,?,?)",
        (shadow_id, "shadow@corp", None, S.hash_pw("shadowpass1"),
         STATE["acme"]["user"]["tenant_id"], "member", "Finance & Operations", "LEGACY"))
    con.commit()
    con.close()

    # (a) admin PATCH may not claim that username as an email
    r = client.patch(f"/api/admin/users/{users['hana_hr']['id']}", headers=t_acme,
                     json={"email": "shadow@corp"})
    assert r.status_code == 409, r.text
    assert "username" in r.json()["detail"].lower(), r.text
    # (b) organization signup may not claim it either (no tenant is created)
    r = client.post("/api/auth/signup-org",
                    json={"org_name": "Shadow Corp", "username": "shadow_admin",
                          "password": "shadowpass1", "email": "shadow@corp"})
    assert r.status_code == 409, r.text
    # (c) the shadowed username still logs in exactly as before (R1 preserves
    #     existing username login — no fallback change, no lockout)
    ok = client.post("/api/auth/login", json={"username": "shadow@corp", "password": "shadowpass1"})
    assert ok.status_code == 200 and ok.json()["user"]["id"] == shadow_id, ok.text
    # (d) self-consistency stays allowed: an account may hold ITS OWN
    #     username-shaped email (same row either way — nothing is shadowed)
    r = client.patch(f"/api/admin/users/{shadow_id}", headers=t_acme,
                     json={"email": "shadow@corp"})
    assert r.status_code == 200, r.text
    after = {u["username"]: u for u in client.get("/api/admin/users", headers=t_acme).json()}
    assert after["shadow@corp"]["email"] == "shadow@corp"
    r = client.patch(f"/api/admin/users/{shadow_id}", headers=t_acme, json={"email": None})
    assert r.status_code == 200, r.text
    # and email-vs-email uniqueness is untouched by R1
    r = client.patch(f"/api/admin/users/{users['hana_hr']['id']}", headers=t_acme,
                     json={"email": "shadow@corp"})
    assert r.status_code == 409, r.text


@test
def test_email_case_insensitive_unique_at_db_level():
    """R2: the DATABASE itself rejects case-variant emails (raw writes that
    bypass _norm_email included); NULL emails stay unlimited."""
    import sqlite3
    from app import db as D
    t_acme = auth(STATE["acme"]["token"])
    users = {u["username"]: u for u in client.get("/api/admin/users", headers=t_acme).json()}
    r = client.patch(f"/api/admin/users/{users['hana_hr']['id']}", headers=t_acme,
                     json={"email": "ci.probe@acme-corp.example"})
    assert r.status_code == 200, r.text

    con = sqlite3.connect(D.DB_PATH)
    try:
        idx = {row[1]: row for row in con.execute("PRAGMA index_list(users)")}
        assert "idx_users_email_ci" in idx, idx
        assert idx["idx_users_email_ci"][2] == 1, "CI index must be UNIQUE"
        assert idx["idx_users_email_ci"][4] == 1, "CI index must be PARTIAL (NULLs allowed)"
        # the raw database (bypassing app normalization) rejects a case variant …
        try:
            con.execute(
                "INSERT INTO users(id,username,pw_hash,tenant_id,email) "
                "VALUES('rawci1','raw_ci_probe','x',?, 'CI.PROBE@acme-corp.example')",
                (STATE["acme"]["user"]["tenant_id"],))
            ci_rejects = False
        except sqlite3.IntegrityError:
            ci_rejects = True
        assert ci_rejects, "CI index must reject case variants at the DB level"
        # … while NULL emails remain unlimited (every legacy account is NULL)
        con.execute("INSERT INTO users(id,username,pw_hash,tenant_id,email) "
                    "VALUES('rawci2','raw_ci_null_a','x',?,NULL)",
                    (STATE["acme"]["user"]["tenant_id"],))
        con.execute("INSERT INTO users(id,username,pw_hash,tenant_id,email) "
                    "VALUES('rawci3','raw_ci_null_b','x',?,NULL)",
                    (STATE["acme"]["user"]["tenant_id"],))
    finally:
        con.rollback()      # probes never persist — the directory stays pristine
        con.close()


@test
def test_init_stops_safely_on_case_variant_duplicates():
    """R2: if existing data already holds case-variant duplicate emails, init()
    must stop loudly and change nothing — never delete or rewrite users."""
    import sqlite3
    from app import db as D
    legacy = os.path.join(_TMP, "legacy_ci_dupes.db")
    con = sqlite3.connect(legacy)
    con.executescript(
        """
        CREATE TABLE tenants(id TEXT PRIMARY KEY, name TEXT NOT NULL);
        CREATE TABLE users(
          id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, email TEXT, pw_hash TEXT NOT NULL,
          tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          role TEXT NOT NULL DEFAULT 'member', department TEXT NOT NULL DEFAULT 'General',
          employee_id TEXT, is_manager INTEGER NOT NULL DEFAULT 0,
          created TEXT DEFAULT CURRENT_TIMESTAMP);
        INSERT INTO tenants(id,name) VALUES('t1','Dupe Co');
        INSERT INTO users(id,username,pw_hash,tenant_id,email)
            VALUES('u1','dup_a','x','t1','Same@Dupe.example');
        INSERT INTO users(id,username,pw_hash,tenant_id,email)
            VALUES('u2','dup_b','x','t1','same@dupe.example');
        """)
    con.commit(); con.close()

    original = D.DB_PATH
    try:
        D.DB_PATH = legacy
        try:
            D.init()
            raise AssertionError("init() must refuse to index case-variant duplicate emails")
        except RuntimeError as e:
            # actionable report: names the normalized conflicting value
            assert "same@dupe.example" in str(e) and "No data was changed" in str(e), e
        con = sqlite3.connect(legacy)
        rows = sorted(con.execute("SELECT id,username,email FROM users").fetchall())
        assert rows == [("u1", "dup_a", "Same@Dupe.example"),
                        ("u2", "dup_b", "same@dupe.example")], rows
        idx = {r[1] for r in con.execute("PRAGMA index_list(users)")}
        assert "idx_users_email_ci" not in idx, "CI index must not exist after the refusal"
        con.close()
        # once an admin clears the duplicate, init() completes and adds it
        con = sqlite3.connect(legacy)
        con.execute("UPDATE users SET email=NULL WHERE id='u2'")
        con.commit(); con.close()
        D.init()
        con = sqlite3.connect(legacy)
        idx = {r[1] for r in con.execute("PRAGMA index_list(users)")}
        assert "idx_users_email_ci" in idx, idx
        assert con.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 2
        assert con.execute("SELECT email FROM users WHERE id='u1'").fetchone()[0] \
            == "Same@Dupe.example"          # surviving data untouched
        con.close()
    finally:
        D.DB_PATH = original


@test
def test_email_uniqueness_race_returns_409_not_500():
    """R3: when the availability pre-check loses a race, the database
    constraint fires and the endpoint answers 409 (precise message), never
    500. Deterministic: the pre-check is disabled for the racing request only,
    simulating a concurrent writer committing between check and write."""
    import app.main as M
    t_acme = auth(STATE["acme"]["token"])
    users = {u["username"]: u for u in client.get("/api/admin/users", headers=t_acme).json()}

    original = M._assert_email_available
    # Explicit per-call script for the six availability checks these four
    # requests perform (pre-check, then classifier on the losing ones):
    #   PATCH fin_user  -> pre-check (honor: value free, write wins the race)
    #   PATCH hana_hr   -> pre-check (BLIND), classifier (honor -> precise 409)
    #   signup Race     -> pre-check (honor: value free, INSERT wins)
    #   signup Race II  -> pre-check (BLIND), classifier (honor -> precise 409)
    script = iter(["honor", "blind", "honor", "honor", "blind", "honor"])

    def raced_precheck(c, email, user_id=None):
        if next(script) == "blind":
            return                      # pre-check "lost the race": let the write hit the CI index
        return original(c, email, user_id)

    M._assert_email_available = raced_precheck
    try:
        # admin path: first write wins; the racing second write hits the CI index
        r = client.patch(f"/api/admin/users/{users['fin_user']['id']}", headers=t_acme,
                         json={"email": "race@acme-corp.example"})
        assert r.status_code == 200, r.text
        r = client.patch(f"/api/admin/users/{users['hana_hr']['id']}", headers=t_acme,
                         json={"email": "RACE@acme-corp.example"})
        assert r.status_code == 409, r.text
        assert "already in use" in r.json()["detail"], r.text
        # the losing PATCH committed NOTHING (email, and no partial effects)
        after = {u["username"]: u for u in client.get("/api/admin/users", headers=t_acme).json()}
        assert after["hana_hr"]["email"] != "race@acme-corp.example"
        assert after["fin_user"]["email"] == "race@acme-corp.example"
        # signup path: same guarantee for organization creation
        r = client.post("/api/auth/signup-org",
                        json={"org_name": "Race Corp", "username": "race_owner",
                              "password": "racepass123", "email": "race2@race.example"})
        assert r.status_code == 200, r.text
        r = client.post("/api/auth/signup-org",
                        json={"org_name": "Race Corp II", "username": "race_owner2",
                              "password": "racepass123", "email": "Race2@Race.Example"})
        assert r.status_code == 409, r.text
        assert "already in use" in r.json()["detail"], r.text
    finally:
        M._assert_email_available = original


@test
def test_signup_org_rejects_at_username():
    """Race fix: NEW usernames may not contain '@'. Org signup validates
    before any write — no tenant row and no user row is ever created."""
    import sqlite3
    from app import db as D
    con = sqlite3.connect(D.DB_PATH)
    t_before = con.execute("SELECT COUNT(*) FROM tenants").fetchone()[0]
    u_before = con.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    con.close()
    # with an (otherwise valid) email in the body
    r = client.post("/api/auth/signup-org",
                    json={"org_name": "At Sign Corp", "username": "at@admin",
                          "password": "password123!",
                          "email": "at_admin@at-sign.example"})
    assert r.status_code == 400, r.text
    assert "must not contain '@'" in r.json()["detail"], r.text
    # and without one — same rule, same result
    r = client.post("/api/auth/signup-org",
                    json={"org_name": "At Sign Corp 2", "username": "other@name",
                          "password": "password123!"})
    assert r.status_code == 400, r.text
    con = sqlite3.connect(D.DB_PATH)
    assert not con.execute(
        "SELECT 1 FROM tenants WHERE name LIKE 'At Sign Corp%'").fetchone()
    assert not con.execute(
        "SELECT 1 FROM users WHERE username IN ('at@admin','other@name')").fetchone()
    assert con.execute("SELECT COUNT(*) FROM tenants").fetchone()[0] == t_before
    assert con.execute("SELECT COUNT(*) FROM users").fetchone()[0] == u_before
    con.close()


@test
def test_register_rejects_at_username_and_keeps_invite():
    """Race fix on the invitation path: '@' usernames 400 BEFORE any database
    work, no user row exists, the invitation is not consumed — and the very
    same invite stays fully usable afterwards (zero side effects)."""
    import sqlite3
    from app import db as D
    t_acme = auth(STATE["acme"]["token"])
    inv = client.post("/api/admin/invites", headers=t_acme,
                      json={"role": "member", "department": "Marketing & Sales", "days": 7})
    assert inv.status_code == 200, inv.text
    code = inv.json()["code"]
    r = client.post("/api/auth/register",
                    json={"username": "member@corp", "password": "password123!",
                          "invite_code": code})
    assert r.status_code == 400, r.text
    assert "must not contain '@'" in r.json()["detail"], r.text
    con = sqlite3.connect(D.DB_PATH)
    assert not con.execute(
        "SELECT 1 FROM users WHERE username='member@corp'").fetchone()
    row = con.execute("SELECT used_by FROM invites WHERE code=?", (code,)).fetchone()
    assert row is not None and row[0] is None      # invite untouched, unconsumed
    con.close()
    ok = client.post("/api/auth/register",
                     json={"username": "new_marketer", "password": "password123!",
                           "invite_code": code})
    assert ok.status_code == 200, ok.text
    con = sqlite3.connect(D.DB_PATH)
    row = con.execute("SELECT used_by FROM invites WHERE code=?", (code,)).fetchone()
    assert row[0] == ok.json()["user"]["id"]       # consumed only by the valid use
    con.close()


@test
def test_at_username_rejected_even_with_prechecks_blinded():
    """The rule is value-based, not check-based: with every cross-row pre-check
    blinded (the TOCTOU technique), '@' usernames are still refused — so no
    concurrent interleaving can create one. Legacy '@' accounts keep working,
    and restored pre-checks still accept a valid registration."""
    import sqlite3
    from app import db as D
    from app import main as M
    t_acme = auth(STATE["acme"]["token"])
    inv = client.post("/api/admin/invites", headers=t_acme,
                      json={"role": "member", "department": "Legal & Compliance", "days": 7})
    assert inv.status_code == 200, inv.text
    code = inv.json()["code"]
    original = M._assert_email_available
    M._assert_email_available = lambda *a, **k: None
    try:
        r = client.post("/api/auth/register",
                        json={"username": "blind@corp", "password": "password123!",
                              "invite_code": code})
        assert r.status_code == 400, r.text
        r = client.post("/api/auth/signup-org",
                        json={"org_name": "Blind Corp", "username": "blind@admin",
                              "password": "password123!"})
        assert r.status_code == 400, r.text
    finally:
        M._assert_email_available = original
    con = sqlite3.connect(D.DB_PATH)
    assert not con.execute(
        "SELECT 1 FROM tenants WHERE name='Blind Corp'").fetchone()
    assert not con.execute(
        "SELECT 1 FROM users WHERE username IN ('blind@corp','blind@admin')").fetchone()
    assert con.execute("SELECT used_by FROM invites WHERE code=?",
                       (code,)).fetchone()[0] is None
    con.close()
    ok = client.post("/api/auth/register",
                     json={"username": "blind_ok_user", "password": "password123!",
                           "invite_code": code})
    assert ok.status_code == 200, ok.text
    # legacy behavior intact end-to-end: the seeded '@' account still logs in
    legacy = client.post("/api/auth/login",
                         json={"username": "shadow@corp", "password": "shadowpass1"})
    assert legacy.status_code == 200, legacy.text


# --- Conversational intent gate (observed through the API) -------------------

@test
def test_casual_chat_needs_no_llm_and_persists_normally():
    t = auth(STATE["acme"]["token"])
    before = len(client.get("/api/conversations", headers=t).json())
    # No LLM key is configured for these tests, yet casual turns return 200:
    # they short-circuit before retrieval, generation and verification.
    for q, marker in (("hi", "Hello!"), ("OK", "Understood"),
                      ("  thank you!  ", "You're welcome")):
        r = client.post("/api/chat", headers=t, json={"question": q})
        assert r.status_code == 200, (q, r.status_code, r.text)
        assert marker in r.json()["answer"], (q, r.json()["answer"])
        assert r.json()["conversation_id"], "casual turns must still be persisted"
    convs = client.get("/api/conversations", headers=t).json()
    assert len(convs) == before + 3, (before, len(convs))
    titles = {c["title"] for c in convs}
    assert {"hi", "OK", "  thank you!  "} <= titles, titles


@test
def test_thanks_prefixed_document_question_still_goes_through_rag():
    t = auth(STATE["acme"]["token"])
    r = client.post("/api/chat", headers=t,
                    json={"question": "Thank you, how many weeks of parental leave?"})
    # Same document question the 503 test uses: with no LLM key the real RAG
    # path fails with 503, proving the casual gate did not swallow it.
    assert r.status_code == 503, (r.status_code, r.text)
    assert "key" in r.json()["detail"].lower()


@test
def test_unspaced_and_spaced_thanks_both_reply_without_rag():
    t = auth(STATE["acme"]["token"])
    # No LLM key is configured here: a 200 proves these short-circuited before
    # retrieval/generation/verification — including the unspaced "thankyou".
    for q in ("thankyou", "thank you", "THANK YOU!", "  thanks  ", "gotit", "TQ"):
        r = client.post("/api/chat", headers=t, json={"question": q})
        assert r.status_code == 200, (q, r.status_code, r.text)
        ans = r.json()["answer"]
        assert ("You're welcome" in ans) or ("Understood" in ans) or ("Hello!" in ans), (q, ans)
        assert "couldn't find" not in ans.lower(), (q, ans)


@test
def test_thankyou_prefix_does_not_swallow_a_document_question():
    t = auth(STATE["acme"]["token"])
    # Both spellings of a thanks-prefixed policy question must still go
    # through authorized retrieval (503 = the real RAG path without an LLM key).
    for q in ("thank you, what is the parental leave policy?",
              "thankyou, what is the parental leave policy?"):
        r = client.post("/api/chat", headers=t, json={"question": q})
        assert r.status_code == 503, (q, r.status_code, r.text)
        assert "key" in r.json()["detail"].lower()


# --- Stability pass: destructive ordering, races, scope guard, language ------

@test
def test_rejected_reupload_preserves_the_previous_document():
    t = auth(STATE["acme"]["token"])
    first = upload(STATE["acme"]["token"], "Handbook2.txt", "Version one.\n",
                   visibility="org", department="Human Resources")
    assert first.status_code == 200, first.text
    before = first.json()

    # (a) an unknown ACL target must be rejected BEFORE anything is replaced
    bad_acl = upload(STATE["acme"]["token"], "Handbook2.txt", "Version two.\n",
                     visibility="restricted", allowed="no-such-user")
    assert bad_acl.status_code == 400, bad_acl.text

    # (b) a file with no extractable text must fail without replacing either
    empty = upload(STATE["acme"]["token"], "Handbook2.txt", "",
                   visibility="org", department="Human Resources")
    assert empty.status_code == 422, empty.text

    docs = [d for d in client.get("/api/documents", headers=t).json()
            if d["filename"] == "Handbook2.txt"]
    assert len(docs) == 1, "a rejected upload must neither duplicate nor delete the original"
    assert docs[0]["id"] == before["id"] and docs[0]["chunks"] == before["chunks"]


@test
def test_department_scope_change_requires_an_existing_department():
    t = auth(STATE["acme"]["token"])
    doc = upload(STATE["acme"]["token"], "OrgWide.txt", "Company-wide memo.\n",
                 visibility="organization")
    assert doc.status_code == 200, doc.text
    doc_id = doc.json()["id"]
    # An organization-scoped document stores no department: applying
    # "department" scope would hide it from every member while reporting ok.
    r = client.patch(f"/api/documents/{doc_id}/access", headers=t,
                     json={"visibility": "department", "download_allowed": True})
    assert r.status_code == 400, r.text
    assert "department" in r.json()["detail"].lower()
    still = [d for d in client.get("/api/documents", headers=t).json() if d["id"] == doc_id]
    assert still and still[0]["visibility"] == "organization"


@test
def test_invite_claim_statement_grants_the_code_once():
    # register() consumes an invite with a guarded UPDATE (… AND used_by IS
    # NULL); pin the statement's semantics: only the first claim can win.
    r = client.post("/api/admin/invites", headers=auth(STATE["acme"]["token"]),
                    json={"role": "member", "days": 7})
    assert r.status_code == 200, r.text
    code = r.json()["code"]
    from app import db as D
    import sqlite3
    con = sqlite3.connect(D.DB_PATH)
    try:
        first = con.execute("UPDATE invites SET used_by=? WHERE code=? AND used_by IS NULL",
                            ("claimant-1", code)).rowcount
        second = con.execute("UPDATE invites SET used_by=? WHERE code=? AND used_by IS NULL",
                             ("claimant-2", code)).rowcount
    finally:
        con.close()
    assert (first, second) == (1, 0), (first, second)


@test
def test_language_selection_reaches_generation_not_the_query():
    # Before the fix the language suffix was appended to the question, so even
    # "hi" missed the casual gate; now it reaches only the generation prompt.
    t = auth(STATE["acme"]["token"])
    casual = client.post("/api/chat", headers=t, json={"question": "hi", "language": "Spanish"})
    assert casual.status_code == 200, casual.text
    assert "Hello!" in casual.json()["answer"]
    # a real document question with a non-English language still runs RAG
    real = client.post("/api/chat", headers=t,
                       json={"question": "How many weeks of parental leave?", "language": "Spanish"})
    assert real.status_code == 503, (real.status_code, real.text)


def main():
    failed = 0
    for fn in TESTS:
        name = fn.__name__
        try:
            fn()
            print(f"  PASS  {name}")
        except AssertionError as e:
            failed += 1
            print(f"  FAIL  {name}: {e}")
        except Exception as e:
            failed += 1
            print(f"  ERROR {name}: {type(e).__name__}: {e}")
    print(f"\n{len(TESTS) - failed}/{len(TESTS)} tests passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
