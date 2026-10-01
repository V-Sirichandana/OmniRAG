import time, bcrypt, jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from .config import JWT_SECRET
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
        row = c.execute("SELECT u.id,u.username,u.role,u.tenant_id,t.name AS tenant_name FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.id=?", (uid,)).fetchone()
    if not row: raise HTTPException(401, "User no longer exists")
    return dict(row)

def admin_user(user=Depends(current_user)) -> dict:
    if user["role"] != "admin": raise HTTPException(403, "Administrator access required")
    return user
