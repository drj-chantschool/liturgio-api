"""Login + role gate for liturgio-api.

Sessions are stateless HMAC-signed cookies: prod runs 2 instances against a
read-only DB, so there is nowhere to store server-side sessions. A cookie
carries (user_id, session_epoch, expiry); bumping app_user.session_epoch (on
password change or deactivation) invalidates every outstanding cookie.

Users/roles live in app_user / p_app_role (liturgio-tools/sql/make-app-users.sql)
and are managed with manage_users.py.

Bots send `Authorization: Bearer <token>` instead (api_token, liturgio-api #6);
only the token's SHA-256 is stored, and a token may only GET and submit edits.
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from typing import Callable, Optional
from urllib.parse import quote

import keyring
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

COOKIE_NAME = 'liturgio_session'
SESSION_TTL = 7 * 24 * 3600

# Minimum role_level for anything other than GET/HEAD/OPTIONS (see p_app_role).
WRITE_LEVEL = 50
ADMIN_LEVEL = 90

# Reachable without a session: the login page, its assets, and the auth calls.
PUBLIC_PATHS = {
    '/login', '/auth/login', '/auth/logout',
    '/static/style.css', '/static/login.css', '/static/login.js',
    '/favicon.ico',
}
# POSTs that the prod read-only guard must let through. Login/logout write no
# DB rows; /auth/password writes only the caller's own app_user row, as the
# separate liturgio_auth DB user (see app.pw_writer and DEPLOYMENT_PLAN.md);
# /api/edit_queue only INSERTs into edit_queue, as liturgio_queue
# (app.queue_writer), and still needs WRITE_LEVEL (see middleware).
READ_ONLY_EXEMPT = {'/auth/login', '/auth/logout', '/auth/password', '/api/edit_queue'}
# Writes any signed-in user may make on their own account, whatever their role.
SELF_SERVICE = {'/auth/password'}

# Bearer tokens (api_token, manage_users.py token ...) are for bots: they may
# read anything a GET reaches and submit to the edit queue, nothing else.
TOKEN_POSTS = {'/api/edit_queue'}
TOKEN_DENIED = {'/profile', '/api/me/profile'}
TOKEN_PREFIX = 'lt_'
_TOKEN_TOUCH_EVERY = 5 * 60

def new_token() -> str:
    return TOKEN_PREFIX + secrets.token_urlsafe(32)

def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()

def _token_may(method: str, path: str) -> bool:
    if path.startswith('/auth/') or path in TOKEN_DENIED:
        return False
    if method in ('GET', 'HEAD'):
        return True
    return method == 'POST' and path in TOKEN_POSTS

MIN_PASSWORD_LEN = 10
PASSWORD_CHANGE_DISABLED = ('Password changes are not enabled on this server yet; '
                            'ask an administrator to change it for you')


# ── Passwords ─────────────────────────────────────────────────────────────────
_SCRYPT_N, _SCRYPT_R, _SCRYPT_P = 2 ** 14, 8, 1
_SCRYPT_MAXMEM = 64 * 1024 * 1024

def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b'=').decode()

def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))

def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R,
                        p=_SCRYPT_P, maxmem=_SCRYPT_MAXMEM)
    return f'scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${_b64(salt)}${_b64(dk)}'

def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt, dk = stored.split('$')
        if algo != 'scrypt':
            return False
        got = hashlib.scrypt(password.encode(), salt=_unb64(salt), n=int(n), r=int(r),
                             p=int(p), maxmem=_SCRYPT_MAXMEM)
        return hmac.compare_digest(got, _unb64(dk))
    except (ValueError, TypeError):
        return False

# Spent on unknown usernames so timing doesn't reveal which usernames exist.
_DUMMY_HASH = hash_password(secrets.token_hex(8))


# ── Session cookie ────────────────────────────────────────────────────────────
def _load_secret(prod: bool) -> bytes:
    s = os.environ.get('LITURGIO_SESSION_SECRET')
    if s:
        return s.encode()
    if prod:
        # Instances must share the secret or cookies fail on the other one.
        raise RuntimeError('LITURGIO_SESSION_SECRET must be set in prod')
    s = keyring.get_password('liturgio-api', 'session_secret')
    if not s:
        s = secrets.token_urlsafe(48)
        keyring.set_password('liturgio-api', 'session_secret', s)
    return s.encode()

def _sign(secret: bytes, payload: dict) -> str:
    body = _b64(json.dumps(payload, separators=(',', ':')).encode())
    mac = _b64(hmac.new(secret, body.encode(), hashlib.sha256).digest())
    return f'{body}.{mac}'

def _unsign(secret: bytes, token: str) -> Optional[dict]:
    try:
        body, mac = token.split('.')
        want = _b64(hmac.new(secret, body.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(mac, want):
            return None
        payload = json.loads(_unb64(body))
        if payload.get('exp', 0) < time.time():
            return None
        return payload
    except (ValueError, TypeError):
        return None


# ── Login throttle (per instance; enough to blunt online guessing) ─────────────
_FAIL_WINDOW, _FAIL_MAX = 15 * 60, 10
_fails: dict = {}
_fails_lock = threading.Lock()

def _client_ip(request: Request) -> str:
    return request.client.host if request.client else '?'

def _throttled(ip: str) -> bool:
    now = time.time()
    with _fails_lock:
        recent = [t for t in _fails.get(ip, []) if now - t < _FAIL_WINDOW]
        _fails[ip] = recent
        return len(recent) >= _FAIL_MAX

def _record_fail(ip: str):
    with _fails_lock:
        _fails.setdefault(ip, []).append(time.time())


class Auth:
    def __init__(self, ro: Callable, prod: bool, pw_writer: Callable):
        self._ro = ro
        self._pw_writer = pw_writer     # engine allowed to UPDATE app_user
        self._prod = prod
        self._secret = _load_secret(prod)
        self._cache: dict = {}      # user_id -> (fetched_at, row or None)
        self._tokens: dict = {}     # token_hash -> (fetched_at, row or None)
        self._touched: dict = {}    # token_id -> last last_used_at stamp (this instance)
        self._touch_ok = True
        self._cache_lock = threading.Lock()

    # Users are re-read at most every 30 s so deactivation/role changes land
    # quickly without a DB hit on every static asset.
    def _user(self, user_id: int) -> Optional[dict]:
        now = time.time()
        with self._cache_lock:
            hit = self._cache.get(user_id)
            if hit and now - hit[0] < 30:
                return hit[1]
        with self._ro().connect() as conn:
            row = conn.execute(text("""
                SELECT u.user_id, u.username, u.display_name, u.role_code,
                       u.is_active, u.session_epoch, r.role_level,
                       r.display_name AS role_name
                FROM app_user u JOIN p_app_role r ON r.role_code = u.role_code
                WHERE u.user_id = :id
            """), {'id': user_id}).mappings().first()
        user = dict(row) if row else None
        with self._cache_lock:
            self._cache[user_id] = (now, user)
        return user

    def current_user(self, request: Request) -> Optional[dict]:
        token = request.cookies.get(COOKIE_NAME)
        payload = _unsign(self._secret, token) if token else None
        if not payload:
            return None
        user = self._user(int(payload['uid']))
        if not user or not user['is_active'] or user['session_epoch'] != payload.get('ep'):
            return None
        return user

    # Token rows are cached like users, so a revoke lands within 30 s.
    def token_user(self, token: str) -> Optional[dict]:
        h = hash_token(token)
        now = time.time()
        with self._cache_lock:
            hit = self._tokens.get(h)
        if hit and now - hit[0] < 30:
            row = hit[1]
        else:
            with self._ro().connect() as conn:
                r = conn.execute(text("""
                    SELECT token_id, user_id, user_epoch, revoked_at
                    FROM api_token WHERE token_hash = :h
                """), {'h': h}).mappings().first()
            row = dict(r) if r else None
            with self._cache_lock:
                self._tokens[h] = (now, row)
        if not row or row['revoked_at'] is not None:
            return None
        user = self._user(row['user_id'])
        if not user or not user['is_active'] or user['session_epoch'] != row['user_epoch']:
            return None
        self._touch(row['token_id'], now)
        return user

    def _touch(self, token_id: int, now: float):
        """Best effort: stamp last_used_at via liturgio_auth (needs the grant in
        make-app-users.sql); a missing grant just turns stamping off."""
        if not self._touch_ok or now - self._touched.get(token_id, 0) < _TOKEN_TOUCH_EVERY:
            return
        self._touched[token_id] = now
        try:
            with self._pw_writer().begin() as conn:
                conn.execute(text('UPDATE api_token SET last_used_at = NOW() WHERE token_id = :id'),
                             {'id': token_id})
        except (DBAPIError, HTTPException):
            self._touch_ok = False

    async def _token_request(self, request: Request, call_next, authz: str):
        # A request with an Authorization header is judged on it alone; the
        # cookie is ignored, so neither credential can stand in for the other.
        ip = _client_ip(request)
        if _throttled(ip):
            return JSONResponse({'detail': 'Too many failed attempts; try again later'},
                                status_code=429)
        scheme, _, token = authz.partition(' ')
        token = token.strip()
        user = self.token_user(token) if scheme.lower() == 'bearer' and token else None
        if user is None:
            _record_fail(ip)
            return JSONResponse({'detail': 'Invalid or revoked API token'}, status_code=401,
                                headers={'WWW-Authenticate': 'Bearer'})
        if not _token_may(request.method, request.url.path):
            return JSONResponse({'detail': 'API tokens may only read and submit to the edit queue'},
                                status_code=403)
        if request.method not in ('GET', 'HEAD') and user['role_level'] < WRITE_LEVEL:
            return JSONResponse({'detail': f"Role {user['role_name']} cannot make changes"},
                                status_code=403)
        request.state.user = user
        request.state.via_token = True
        return await call_next(request)

    async def middleware(self, request: Request, call_next):
        path = request.url.path
        authz = request.headers.get('authorization')
        if authz is not None:
            return await self._token_request(request, call_next, authz)
        if path in PUBLIC_PATHS:
            return await call_next(request)
        user = self.current_user(request)
        if user is None:
            if path.startswith('/api/') or request.method not in ('GET', 'HEAD'):
                return JSONResponse({'detail': 'Not logged in'}, status_code=401)
            nxt = path + (f'?{request.url.query}' if request.url.query else '')
            return RedirectResponse(f'/login?next={quote(nxt, safe="")}', status_code=303)
        if (request.method not in ('GET', 'HEAD', 'OPTIONS') and path not in SELF_SERVICE
                and user['role_level'] < WRITE_LEVEL):
            return JSONResponse({'detail': f"Role {user['role_name']} cannot make changes"},
                                status_code=403)
        request.state.user = user
        return await call_next(request)

    def login(self, request: Request, username: str, password: str):
        ip = _client_ip(request)
        if _throttled(ip):
            raise HTTPException(429, 'Too many failed logins; try again later')
        with self._ro().connect() as conn:
            row = conn.execute(text("""
                SELECT user_id, password_hash, is_active, session_epoch
                FROM app_user WHERE username = :u
            """), {'u': username.strip().lower()}).mappings().first()
        ok = verify_password(password, row['password_hash'] if row else _DUMMY_HASH)
        if not (row and ok and row['is_active']):
            _record_fail(ip)
            raise HTTPException(401, 'Invalid username or password')
        return self._session_response(row['user_id'], row['session_epoch'])

    def _session_response(self, user_id: int, epoch: int) -> JSONResponse:
        with self._cache_lock:
            self._cache.pop(user_id, None)
        token = _sign(self._secret, {'uid': user_id, 'ep': epoch,
                                     'exp': int(time.time()) + SESSION_TTL})
        resp = JSONResponse(self.public_user(self._user(user_id)))
        resp.set_cookie(COOKIE_NAME, token, max_age=SESSION_TTL, httponly=True,
                        samesite='lax', secure=self._prod, path='/')
        return resp

    def change_password(self, request: Request, current: str, new: str):
        """Self-service change. Bumps session_epoch (signing the user out
        everywhere else) and re-issues this browser's cookie at the new epoch."""
        user = request.state.user
        ip = _client_ip(request)
        if _throttled(ip):
            raise HTTPException(429, 'Too many failed attempts; try again later')
        if len(new) < MIN_PASSWORD_LEN:
            raise HTTPException(422, f'Use at least {MIN_PASSWORD_LEN} characters')
        if new == current:
            raise HTTPException(422, 'The new password must differ from the current one')
        with self._ro().connect() as conn:
            stored = conn.execute(text('SELECT password_hash FROM app_user WHERE user_id = :id'),
                                  {'id': user['user_id']}).scalar()
        if not (stored and verify_password(current, stored)):
            _record_fail(ip)
            raise HTTPException(403, 'Current password is incorrect')
        try:
            with self._pw_writer().begin() as conn:
                n = conn.execute(text("""
                    UPDATE app_user SET password_hash = :h, session_epoch = session_epoch + 1
                    WHERE user_id = :id AND session_epoch = :ep AND is_active = 1
                """), {'h': hash_password(new), 'id': user['user_id'],
                      'ep': user['session_epoch']}).rowcount
        except DBAPIError as exc:
            # Prod with liturgio_auth missing (1045) or not yet granted (1142/1143).
            if getattr(exc.orig, 'errno', None) in (1045, 1142, 1143):
                raise HTTPException(503, PASSWORD_CHANGE_DISABLED)
            raise
        if n != 1:
            # Epoch moved (changed elsewhere / deactivated) since this request authenticated.
            raise HTTPException(409, 'Your account changed while you were signed in; sign in again')
        return self._session_response(user['user_id'], user['session_epoch'] + 1)

    def profile(self, request: Request) -> dict:
        user = request.state.user
        with self._ro().connect() as conn:
            row = conn.execute(text("""
                SELECT u.created_at, r.notes AS role_notes
                FROM app_user u JOIN p_app_role r ON r.role_code = u.role_code
                WHERE u.user_id = :id
            """), {'id': user['user_id']}).mappings().first()
        return {
            **self.public_user(user),
            'role_notes': row['role_notes'] if row else None,
            'created_at': row['created_at'].isoformat() if row and row['created_at'] else None,
            'min_password_len': MIN_PASSWORD_LEN,
        }

    def logout(self):
        resp = JSONResponse({'ok': True})
        resp.delete_cookie(COOKIE_NAME, path='/')
        return resp

    @staticmethod
    def public_user(user: dict) -> dict:
        return {
            'username': user['username'],
            'display_name': user['display_name'] or user['username'],
            'role': user['role_code'],
            'role_name': user['role_name'],
            'role_level': user['role_level'],
            'can_write': user['role_level'] >= WRITE_LEVEL,
            'is_admin': user['role_level'] >= ADMIN_LEVEL,
        }


def safe_next(nxt: Optional[str]) -> str:
    """Only same-site relative paths, so ?next= can't bounce to another host."""
    if not nxt or not nxt.startswith('/') or nxt.startswith('//') or '\\' in nxt:
        return '/'
    return nxt
