import time, bcrypt, jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from .config import JWT_SECRET, GOOGLE_CLIENT_ID
from .db import db

bearer = HTTPBearer(auto_error=False)
_fails: dict = {}  # username -> (count, locked_until)

def hash_pw(p): return bcrypt.hashpw(p.encode(), bcrypt.gensalt()).decode()
def check_pw(p, h): return bcrypt.checkpw(p.encode(), h.encode())
def make_token(user_id): return jwt.encode({"sub": user_id, "exp": int(time.time()) + 8 * 3600}, JWT_SECRET, algorithm="HS256")

def check_lock(username):
    n, until = _fails.get(username, (0, 0))
    if until > time.time(): raise HTTPException(429, "Too many failed attempts. Try again in a few minutes.")

def record_fail(username):
    n, _ = _fails.get(username, (0, 0)); n += 1
    _fails[username] = (n, time.time() + 300 if n >= 5 else 0)
    if n >= 5: _fails[username] = (0, time.time() + 300)

def clear_fail(username): _fails.pop(username, None)

def current_user(cred: HTTPAuthorizationCredentials = Depends(bearer)) -> dict:
    if not cred: raise HTTPException(401, "Not authenticated")
    try:
        uid = jwt.decode(cred.credentials, JWT_SECRET, algorithms=["HS256"])["sub"]
    except jwt.PyJWTError:
        raise HTTPException(401, "Invalid or expired token")
    with db() as c:  # re-read each request so role changes / deletions apply immediately
        row = c.execute(
            "SELECT u.id,u.username,u.email,u.role,u.tenant_id,u.department,u.employee_id,"
            "u.is_manager,u.full_name,u.employment_type,u.agreement_start,u.agreement_end,"
            "u.google_sub,u.disabled,t.name AS tenant_name "
            "FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.id=?", (uid,)).fetchone()
    if not row: raise HTTPException(401, "User no longer exists")
    row = dict(row)
    if row.get("disabled"):
        raise HTTPException(403, "Account is disabled")
    return row

def admin_user(user=Depends(current_user)) -> dict:
    if user["role"] != "admin": raise HTTPException(403, "Administrator access required")
    return user


def verify_google_credential(credential: str) -> dict:
    """Verify a Google ID token and return its claims.

    Uses Google's official google-auth library (verify_oauth2_token), which
    checks the signature, issuer, audience and expiry. Returns a dict with at
    least 'sub', 'email', 'email_verified' (and 'name' when present).
    Raises HTTPException(401) on any failure. Never logs the token.
    """
    if not credential or not isinstance(credential, str):
        raise HTTPException(400, "Missing Google credential")
    from . import config as _cfg
    client_id = _cfg.GOOGLE_CLIENT_ID
    if not client_id:
        raise HTTPException(503, "Google sign-in is not configured")
    try:
        from google.oauth2 import id_token as _id_token
        from google.auth.transport import requests as _grequests
        claims = _id_token.verify_oauth2_token(credential, _grequests.Request(), client_id)
    except Exception:
        raise HTTPException(401, "Invalid or expired Google credential")
    # verify_oauth2_token already validates aud/iss/exp; enforce email verification
    # explicitly and re-check audience defensively.
    if claims.get("aud") != client_id:
        raise HTTPException(401, "Invalid Google audience")
    if not claims.get("email_verified"):
        raise HTTPException(401, "Google email is not verified")
    if not claims.get("sub") or not claims.get("email"):
        raise HTTPException(401, "Incomplete Google identity")
    return {
        "sub": claims["sub"],
        "email": str(claims["email"]).strip().lower(),
        "email_verified": bool(claims.get("email_verified")),
        "name": claims.get("name"),
    }
