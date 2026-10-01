"""OmniRAG — Streamlit frontend. All data & security live in the FastAPI backend; this file only calls its API."""
import os
import requests
import streamlit as st

API = os.getenv("API_URL", "http://localhost:8000").rstrip("/") + "/api"
ss = st.session_state
st.set_page_config(page_title="OmniRAG", page_icon="🔐", layout="wide")


def call(method, path, **kw):
    headers = {"Authorization": f"Bearer {ss.token}"} if ss.get("token") else {}
    try:
        r = requests.request(method, API + path, headers=headers, timeout=180, **kw)
    except requests.ConnectionError:
        st.error("Can't reach the backend. Start it with: uvicorn app.main:app --port 8000")
        st.stop()
    if r.status_code == 401 and ss.get("token"):
        ss.clear(); st.rerun()
    if not r.ok:
        try:
            d = r.json().get("detail", "Request failed")
        except Exception:
            d = r.text
        raise RuntimeError(d if isinstance(d, str) else d[0].get("msg", "Invalid input"))
    return r.json()


def do_auth(path, body):
    try:
        res = call("POST", path, json=body)
    except RuntimeError as e:
        st.error(str(e)); return
    ss.token, ss.cid, ss.msgs = res["token"], None, []
    st.rerun()


# ── Sign in / join / create org ─────────────────────────────────────────────
def auth_page():
    st.title("🔐 OmniRAG")
    st.caption("Private document Q&A where every answer shows its source — each organization's data stays separate, and people only see what they're granted.")
    t1, t2, t3 = st.tabs(["Sign in", "Join with invite code", "New organization"])
    with t1, st.form("login"):
        u, p = st.text_input("Username"), st.text_input("Password", type="password")
        if st.form_submit_button("Sign in", type="primary"):
            do_auth("/auth/login", {"username": u, "password": p})
    with t2, st.form("join"):
        code, u, p = st.text_input("Invite code"), st.text_input("Choose a username"), st.text_input("Password (8+ characters)", type="password")
        if st.form_submit_button("Create account", type="primary"):
            do_auth("/auth/register", {"username": u, "password": p, "invite_code": code})
    with t3, st.form("org"):
        o, u, p = st.text_input("Organization name"), st.text_input("Admin username"), st.text_input("Admin password (8+ characters)", type="password")
        if st.form_submit_button("Create organization", type="primary"):
            do_auth("/auth/signup-org", {"org_name": o, "username": u, "password": p})


# ── Ask ─────────────────────────────────────────────────────────────────────
def show_msg(m):
    with st.chat_message(m["role"]):
        st.markdown(m["content"])
        if m["role"] == "assistant":
            bits = []
            if m.get("citations") and m.get("confidence", -1) >= 0:
                bits.append(("✅ Verified " if m.get("grounded") else "⚠️ Low confidence ") + f"{m['confidence']}%")
            if m.get("provider"): bits.append(f"model: {m['provider']}")
            if m.get("latency_ms"): bits.append(f"{m['latency_ms'] / 1000:.1f}s")
            if bits: st.caption(" · ".join(bits))
            if m.get("citations"):
                with st.expander(f"Sources ({len(m['citations'])})"):
                    for c in m["citations"]:
                        st.markdown(f"**[{c['n']}] {c['filename']}** — page {c['page']}\n\n> {c['snippet']}…")
            if m.get("trace"):
                with st.expander("How this answer was produced"):
                    for t in m["trace"]: st.write("• " + t)


def chat_page():
    with st.sidebar:
        st.divider()
        provs = call("GET", "/providers")["available"]
        prov = "auto"
        if st.button("➕ New conversation", use_container_width=True):
            ss.cid, ss.msgs = None, []; st.rerun()
        for c in call("GET", "/conversations"):
            a, b = st.columns([5, 1])
            if a.button(c["title"][:28], key=f"o{c['id']}", use_container_width=True):
                ss.cid, ss.msgs = c["id"], call("GET", f"/conversations/{c['id']}"); st.rerun()
            if b.button("✕", key=f"d{c['id']}"):
                call("DELETE", f"/conversations/{c['id']}")
                if ss.cid == c["id"]: ss.cid, ss.msgs = None, []
                st.rerun()
    st.header("Ask your documents")
    if not ss.msgs:
        st.info("Ask about policies, manuals or reports in your Library. Answers cite the exact passage.")
    for m in ss.msgs: show_msg(m)
    q = st.chat_input("Ask a question…")
    if q:
        ss.msgs.append({"role": "user", "content": q}); show_msg(ss.msgs[-1])
        with st.chat_message("assistant"), st.spinner("Searching, reranking, fact-checking…"):
            try:
                r = call("POST", "/chat", json={"question": q, "conversation_id": ss.cid, "provider": None if prov == "auto" else prov})
                ss.cid = r["conversation_id"]; ss.msgs.append({**r, "role": "assistant", "content": r["answer"]})
            except RuntimeError as e:
                ss.msgs.pop(); st.error(str(e)); return
        st.rerun()


# ── Library ─────────────────────────────────────────────────────────────────
def library_page(user):
    admin = user["role"] == "admin"
    st.header("Library")
    people = {u["id"]: u["username"] for u in call("GET", "/admin/users") if u["id"] != user["id"]} if admin else {}
    if admin:
        with st.form("upload", clear_on_submit=True):
            f = st.file_uploader("Document", type=["pdf", "docx", "pptx", "txt", "md", "csv"])
            vis = st.radio("Who can search it?", ["org", "restricted"], format_func=lambda x: "Whole organization" if x == "org" else "Selected people only", horizontal=True)
            allowed = st.multiselect("Selected people", list(people), format_func=people.get)
            if st.form_submit_button("Upload & index", type="primary") and f:
                try:
                    with st.spinner("Reading, chunking, embedding…"):
                        r = call("POST", "/documents", files={"file": (f.name, f.getvalue())}, data={"visibility": vis, "allowed_user_ids": ",".join(allowed)})
                    st.success(f"Indexed {r['filename']} → {r['chunks']} passages")
                except RuntimeError as e:
                    st.error(str(e))
    docs = call("GET", "/documents")
    if not docs: st.info("No documents yet."); return
    for d in docs:
        with st.expander(f"{'🔒' if d['visibility'] == 'restricted' else '🌐'} {d['filename']} — {d['chunks']} passages · by {d['uploaded_by']}"):
            if not admin: st.write("Visible to you."); continue
            vis = st.radio("Access", ["org", "restricted"], index=int(d["visibility"] == "restricted"), key=f"v{d['id']}", horizontal=True,
                           format_func=lambda x: "Whole organization" if x == "org" else "Selected people only")
            sel = st.multiselect("Selected people", list(people), default=[x for x in d.get("allowed_user_ids", []) if x in people], format_func=people.get, key=f"s{d['id']}")
            a, b = st.columns(2)
            if a.button("Save access", key=f"a{d['id']}"):
                call("PATCH", f"/documents/{d['id']}/access", json={"visibility": vis, "allowed_user_ids": sel}); st.rerun()
            if b.button("Delete document", key=f"x{d['id']}"):
                call("DELETE", f"/documents/{d['id']}"); st.rerun()


# ── Administration ──────────────────────────────────────────────────────────
def admin_page(user):
    st.header("Administration")
    s = call("GET", "/admin/stats")
    for col, (label, key) in zip(st.columns(4), [("People", "users"), ("Documents", "documents"), ("Passages", "chunks"), ("Questions asked", "queries")]):
        col.metric(label, s[key])
    st.subheader("People")
    for u in call("GET", "/admin/users"):
        a, b, c = st.columns([3, 2, 1])
        a.write(u["username"] + (" (you)" if u["id"] == user["id"] else ""))
        if u["id"] == user["id"]:
            b.write(u["role"]); continue
        new = b.selectbox("role", ["member", "admin"], index=int(u["role"] == "admin"), key=f"r{u['id']}", label_visibility="collapsed")
        if new != u["role"]:
            call("PATCH", f"/admin/users/{u['id']}", json={"role": new}); st.rerun()
        if c.button("Remove", key=f"u{u['id']}"):
            call("DELETE", f"/admin/users/{u['id']}"); st.rerun()
    st.subheader("Invitations")
    st.caption("New people can only join with a single-use code that expires in 7 days.")
    a, b = st.columns([1, 3])
    role = a.selectbox("Role for new person", ["member", "admin"])
    if b.button("Create invite code", type="primary"):
        ss.new_code = call("POST", "/admin/invites", json={"role": role, "days": 7})["code"]
    if ss.get("new_code"): st.success("New code (share it privately):"); st.code(ss.new_code)
    open_inv = [i for i in call("GET", "/admin/invites") if not i["used_by"]]
    if open_inv: st.dataframe([{"code": i["code"], "role": i["role"], "expires": i["expires"][:10]} for i in open_inv], hide_index=True)
    st.subheader("Activity log")
    st.dataframe(call("GET", "/admin/audit"), hide_index=True, use_container_width=True)


# ── Router ──────────────────────────────────────────────────────────────────
if not ss.get("token"):
    auth_page(); st.stop()
ss.setdefault("cid", None); ss.setdefault("msgs", [])
me = call("GET", "/auth/me")
with st.sidebar:
    st.title("🔐 OmniRAG")
    st.markdown(f"**{me['tenant_name']}**  \n{me['username']} · {me['role']}")
    page = st.radio("Go to", ["Ask", "Library"] + (["Administration"] if me["role"] == "admin" else []), label_visibility="collapsed")
    if st.button("Sign out", use_container_width=True):
        ss.clear(); st.rerun()
{"Ask": chat_page, "Library": lambda: library_page(me), "Administration": lambda: admin_page(me)}[page]()
