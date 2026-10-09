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


def upload(tok, name, text, visibility="org", department="", allowed=""):
    return client.post(
        "/api/documents",
        headers=auth(tok),
        files={"file": (name, text.encode(), "application/octet-stream")},
        data={"visibility": visibility, "department": department,
              "allowed_user_ids": allowed})


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

    # strict isolation: even the admin (Human Resources) cannot see Finance files
    docs = client.get("/api/documents", headers=auth(STATE["acme"]["token"])).json()
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
    # strict: the admin cannot delete another department's document (404)
    r = client.delete(f"/api/documents/{STATE['payroll']['id']}",
                      headers=auth(STATE["acme"]["token"]))
    assert r.status_code == 404

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
