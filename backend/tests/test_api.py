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
