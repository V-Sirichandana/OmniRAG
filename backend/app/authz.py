"""Single source of truth for document authorization.

Every read path (listing, search, chat retrieval, citations, download,
delete, permission changes) resolves its document scope through
``visible_doc_ids`` and download rights through ``can_download`` — one
consistent rule instead of per-endpoint logic. Identity always comes from
the verified JWT (``u``), never from client-supplied ids.

Visibility scopes (documents.visibility):
  organization          — company-wide: every member of the owning organization.
  department            — only users whose department matches the document's
                          (legacy 'org' rows behave exactly like this, so
                          pre-existing documents keep their original access).
  selected_departments  — only users of the departments listed in
                          doc_departments (all validated to belong to the
                          document's own organization).
  restricted            — only users explicitly granted in doc_acl.

Role rules:
  admin   — organization admin: manages every document of their OWN
            organization (list, permissions, delete, download), and never
            another organization's data.
  member  — employee: sees organization-wide documents, their department's
            documents, documents selected for their department, and
            restricted documents explicitly granted to them.
"""
from . import db as D


def visible_doc_ids(u) -> list[str]:
    """Document ids the authenticated user may view AND query/retrieve.

    Used by listing, /api/search, chat retrieval and every authorization
    check that starts from "may this user touch this document at all".
    """
    tid, uid = u["tenant_id"], u["id"]
    with D.db() as c:
        if u["role"] == "admin":
            rows = c.execute("SELECT id FROM documents WHERE tenant_id=?", (tid,)).fetchall()
            return [r["id"] for r in rows]
        dept = (u.get("department") or "").strip()
        rows = c.execute(
            """SELECT id FROM documents
               WHERE tenant_id=? AND (
                     (visibility IN ('department','org') AND department=?)
                  OR visibility='organization'
                  OR (visibility='selected_departments'
                      AND id IN (SELECT dd.doc_id FROM doc_departments dd
                                 JOIN departments dp ON dp.id=dd.dept_id
                                 WHERE dp.name=?))
                  OR (visibility='restricted'
                      AND id IN (SELECT doc_id FROM doc_acl WHERE user_id=?))
               )""",
            (tid, dept, dept, uid),
        ).fetchall()
    return [r["id"] for r in rows]


def can_download(u, doc_id: str) -> bool:
    """Download = may view the document AND downloads are permitted for it.

    Organization admins may download every document of their organization.
    Members need the document's ``download_allowed`` permission; simply
    being able to query a document never implies download rights.
    """
    if doc_id not in visible_doc_ids(u):
        return False
    if u["role"] == "admin":
        return True
    with D.db() as c:
        r = c.execute("SELECT download_allowed FROM documents WHERE id=? AND tenant_id=?",
                      (doc_id, u["tenant_id"])).fetchone()
    return bool(r and r["download_allowed"])
