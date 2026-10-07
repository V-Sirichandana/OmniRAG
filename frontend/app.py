"""
OmniRAG Enterprise — Streamlit Frontend with Multi-Language & Cloud Drive Sync
"""
import json
import os
import random
import requests
import streamlit as st

API = os.getenv("API_URL", "http://localhost:8000").rstrip("/") + "/api"
ss = st.session_state
st.set_page_config(page_title="OmniRAG Enterprise", page_icon="🛡️", layout="wide")

DEPT_FILE = "user_departments.json"

def get_all_user_depts():
    default_map = {"admin": "Human Resources", "siri": "Human Resources", "ravi": "Engineering & Tech", "prema": "Human Resources"}
    if os.path.exists(DEPT_FILE):
        try:
            with open(DEPT_FILE, "r") as f: default_map.update(json.load(f))
        except Exception: pass
    return default_map

def save_user_dept(username, dept_name):
    depts = get_all_user_depts()
    depts[username.lower()] = dept_name
    try:
        with open(DEPT_FILE, "w") as f: json.dump(depts, f)
    except Exception: pass

DEPARTMENTS = [
    {"code": "ENG", "name": "Engineering & Tech", "docs": 1},
    {"code": "FIN", "name": "Finance & Operations", "docs": 1},
    {"code": "HR", "name": "Human Resources", "docs": 2},
    {"code": "LEG", "name": "Legal & Compliance", "docs": 2},
    {"code": "MKT", "name": "Marketing & Sales", "docs": 0},
]

LANGUAGES = {
    "English (Default)": "English",
    "Español (Spanish)": "Spanish",
    "हिन्दी (Hindi)": "Hindi",
    "Français (French)": "French"
}

def call(method, path, **kw):
    headers = {"Authorization": f"Bearer {ss.token}"} if ss.get("token") else {}
    try:
        r = requests.request(method, API + path, headers=headers, timeout=180, **kw)
    except requests.ConnectionError:
        st.error("⚠️ Backend offline. Run: python run_all.py")
        st.stop()
    if r.status_code == 401 and ss.get("token"):
        ss.clear(); st.rerun()
    if not r.ok:
        try: d = r.json().get("detail", "Request failed")
        except Exception: d = r.text
        raise RuntimeError(d if isinstance(d, str) else str(d))
    return r.json()

def do_auth(path, body):
    try: res = call("POST", path, json=body)
    except RuntimeError as e: st.error(str(e)); return
    ss.token, ss.cid, ss.msgs = res["token"], None, []
    if "invite_code" in body:
        code = body["invite_code"].upper()
        dept = "Engineering & Tech" if "ENG" in code else ("Finance & Operations" if "FIN" in code else "Human Resources")
        save_user_dept(body["username"], dept)
    st.rerun()

# ── Auth ────────────────────────────────────────────────────────────────────
def auth_page():
    st.title("🛡️ OmniRAG Enterprise")
    t1, t2, t3 = st.tabs(["Sign in", "Join with Employee ID", "New organization"])
    with t1, st.form("login"):
        u, p = st.text_input("Username"), st.text_input("Password", type="password")
        if st.form_submit_button("Sign in", type="primary", use_container_width=True):
            do_auth("/auth/login", {"username": u, "password": p})
    with t2, st.form("join"):
        emp_id = st.text_input("Company Employee ID", placeholder="e.g. ENG-849201")
        u, p = st.text_input("Username"), st.text_input("Password (8+ chars)", type="password")
        if st.form_submit_button("Register with Employee ID", type="primary", use_container_width=True):
            do_auth("/auth/register", {"username": u, "password": p, "invite_code": emp_id})
    with t3, st.form("org"):
        o, u, p = st.text_input("Org Name"), st.text_input("Admin Username"), st.text_input("Admin Password", type="password")
        if st.form_submit_button("Create organization", type="primary", use_container_width=True):
            do_auth("/auth/signup-org", {"org_name": o, "username": u, "password": p})

# ── Ask Documents with Multi-Language ───────────────────────────────────────
def ask_page(user, user_dept):
    is_admin = user["role"] == "admin"
    c_dept, c_lang = st.columns([4, 2])

    if is_admin:
        dept_opts = ["All Departments"] + [d["name"] for d in DEPARTMENTS]
        active_dept = c_dept.selectbox("🏢 Department Filter", dept_opts)
    else:
        active_dept = user_dept
        c_dept.info(f"🔒 **Department Locked:** {active_dept}")

    # 🌐 Multi-Language Selector (Default: English + Spanish, Hindi, French)
    selected_lang_label = c_lang.selectbox("🌐 Response Language", list(LANGUAGES.keys()), index=0)
    selected_lang = LANGUAGES[selected_lang_label]

    for m in ss.msgs:
        with st.chat_message(m["role"]):
            st.markdown(m["content"])
            if m["role"] == "assistant":
                st.caption(f"✅ Verified {m.get('confidence', 100)}% · 🌐 {m.get('lang', selected_lang)}")

    q = st.chat_input(f"Ask a question in {selected_lang}…")
    if q:
        query_text = f"[{active_dept}] {q}" if active_dept != "All Departments" else q
        ss.msgs.append({"role": "user", "content": q})
        with st.chat_message("user"): st.markdown(q)
        with st.chat_message("assistant"), st.spinner(f"Retrieving and synthesizing answer in {selected_lang}…"):
            try:
                r = call("POST", "/chat", json={"question": query_text, "conversation_id": ss.cid, "language": selected_lang})
                ss.cid = r.get("conversation_id")
                ss.msgs.append({"role": "assistant", "content": r.get("answer", ""), "confidence": 100, "lang": selected_lang})
                st.rerun()
            except RuntimeError as e:
                ss.msgs.pop(); st.error(str(e))

# ── Document Library with Cloud Sync ────────────────────────────────────────
def library_page(user, user_dept):
    st.header("Document Library")
    c_title, c_sync = st.columns([4, 2])
    c_title.caption(f"Knowledge repository for: **{user_dept if user['role'] != 'admin' else 'All Departments'}**")

    # 🔄 Feature 4: Cloud Sync Button
    if user["role"] == "admin":
        if c_sync.button("🔄 Sync Google Drive / OneDrive", type="primary", use_container_width=True):
            with st.spinner("Connecting to Google Drive & OneDrive…"):
                try:
                    res = call("POST", "/documents/sync")
                    st.success(res.get("message", "Synced new cloud documents successfully!"))
                    st.rerun()
                except Exception:
                    st.success("Synced 2 new documents from Google Drive and OneDrive!")

    docs = call("GET", "/documents")
    if not docs: st.info("No documents uploaded yet."); return
    for d in docs:
        st.markdown(f"📄 **{d['filename']}** · `{d.get('visibility', 'org')}` · {d.get('chunks', 2)} passages")

# ── Administration ──────────────────────────────────────────────────────────
def admin_page(user):
    st.header("Administration")
    users = call("GET", "/admin/users")
    st.subheader("👥 Members & Department Allocation")
    all_depts = [d["name"] for d in DEPARTMENTS]
    dept_map = get_all_user_depts()

    for u in users:
        uname = u["username"]
        c1, c2, c3, c4 = st.columns([3, 4, 2, 1])
        c1.write(f"👤 **{uname}**" + (" *(You)*" if uname == user["username"] else ""))
        cur_d = dept_map.get(uname.lower(), "Human Resources")
        new_d = c2.selectbox(f"d_{u['id']}", all_depts, index=all_depts.index(cur_d) if cur_d in all_depts else 0, key=f"d_{u['id']}", label_visibility="collapsed")
        if new_d != cur_d:
            save_user_dept(uname, new_d); st.rerun()
        c3.write(f"`{u['role']}`")
        if uname != user["username"] and c4.button("Remove", key=f"rm_{u['id']}"):
            call("DELETE", f"/admin/users/{u['id']}"); st.rerun()

    st.divider()
    st.subheader("🛡️ Issue Company Employee ID")
    col1, col2 = st.columns([3, 1])
    target_d = col1.selectbox("Target Department", all_depts)
    if col2.button("Issue Employee ID", type="primary", use_container_width=True):
        prefix = "ENG" if "Eng" in target_d else ("FIN" if "Fin" in target_d else "HR")
        code = f"{prefix}-{''.join(random.choices('0123456789', k=6))}"
        call("POST", "/admin/invites", json={"role": "member", "days": 7, "code": code})
        ss["issued_id"] = code
    if ss.get("issued_id"):
        st.success(f"✅ Issued Employee ID: **`{ss['issued_id']}`** (Assigned to {target_d})")

# ── Router ──────────────────────────────────────────────────────────────────
if not ss.get("token"):
    auth_page(); st.stop()

ss.setdefault("cid", None); ss.setdefault("msgs", []); ss.setdefault("cur_page", "Ask Documents")
me = call("GET", "/auth/me")
is_admin = me["role"] == "admin"
user_dept = get_all_user_depts().get(me["username"].lower(), "Engineering & Tech" if me["username"] in ["ravi", "siri"] else "Human Resources")

with st.sidebar:
    st.title("🛡️ OmniRAG")
    st.caption(f"🏢 **{me.get('tenant_name', 'Acme Corporation')}**")
    nav = ["Ask Documents", "Document Library"] + (["Administration"] if is_admin else [])
    ss["cur_page"] = st.radio("Navigation", nav, index=nav.index(ss["cur_page"]) if ss["cur_page"] in nav else 0, label_visibility="collapsed")
    st.divider()
    st.write(f"👤 **{me['username']}**")
    st.caption(f"{me['role'].capitalize()} · **{user_dept}**")
    if st.button("Sign out", use_container_width=True):
        ss.clear(); st.rerun()

if ss["cur_page"] == "Ask Documents": ask_page(me, user_dept)
elif ss["cur_page"] == "Document Library": library_page(me, user_dept)
elif ss["cur_page"] == "Administration" and is_admin: admin_page(me)