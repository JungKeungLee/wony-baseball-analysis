"""WONY PHONE admin-only entry: signed one-time ticket -> HttpOnly session cookie.

WONY PHONE (server/baseballLink.ts) verifies the Supabase session server-side and DB is_admin(), then
issues ``v1.<payload>.<HMAC-SHA256>`` (60 s, one-time nonce). This service accepts that ticket at
``/wony-login`` and then requires the session cookie on every page and API request.

When WONY_AUTH_SECRET is unset the service behaves as before (local-only use). When it is set but
shorter than 32 characters, every request is refused (fail closed).

WONY PHONE's BASEBALL_ANALYSIS_URL is opened by the admin's *browser*. http://127.0.0.1:8000 means
"localhost of the device running that browser": it works only when WONY PHONE is opened on the same PC
as this server; other PCs/phones would hit their own localhost. For other devices, deploy this server
at a separate HTTPS address and set that address in WONY PHONE.
"""
import base64
import hashlib
import hmac
import json
import os
import threading
import time
from fastapi import Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

SECRET_ENV = 'WONY_AUTH_SECRET'
COOKIE = 'wony_baseball_session'
SESSION_SECONDS = 4 * 3600
OPEN_PATHS = {'/health', '/wony-login'}
_used = {}
_lock = threading.Lock()


def _b64d(text):
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def _b64e(data):
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()


def _sign(secret, body):
    return _b64e(hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest())


def _unpack(token, secret, version):
    parts = (token or '').split('.')
    if len(parts) != 3 or parts[0] != version:
        raise ValueError('malformed')
    body = f'{parts[0]}.{parts[1]}'
    if not hmac.compare_digest(_sign(secret, body), parts[2]):
        raise ValueError('bad signature')
    payload = json.loads(_b64d(parts[1]))
    if not isinstance(payload, dict):
        raise ValueError('malformed')
    return payload


def verify_ticket(token, secret, now=None):
    """Return the admin user id; raise ValueError for bad/expired/reused/non-admin tickets."""
    now = time.time() if now is None else now
    payload = _unpack(token, secret, 'v1')
    exp, nonce, sub = payload.get('exp'), payload.get('nonce'), payload.get('sub')
    if payload.get('role') != 'admin' or not isinstance(sub, str) or not sub:
        raise ValueError('not admin')
    if not isinstance(exp, (int, float)) or exp < now or exp > now + 120:
        raise ValueError('expired')
    if not isinstance(nonce, str) or not nonce:
        raise ValueError('malformed')
    with _lock:
        for key in [k for k, until in _used.items() if until < now]:
            del _used[key]
        if nonce in _used:
            raise ValueError('reused')
        _used[nonce] = exp
    return sub


def make_session(sub, secret, now=None):
    exp = int((time.time() if now is None else now) + SESSION_SECONDS)
    body = 's1.' + _b64e(json.dumps({'sub': sub, 'exp': exp}, separators=(',', ':')).encode())
    return f'{body}.{_sign(secret, body)}'


def verify_session(value, secret, now=None):
    try:
        payload = _unpack(value, secret, 's1')
    except (ValueError, TypeError, json.JSONDecodeError):
        return None
    now = time.time() if now is None else now
    return payload.get('sub') if isinstance(payload.get('exp'), int) and payload['exp'] > now else None


_DENIED = '''<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>접근 권한 없음</title></head><body style="font-family:system-ui,sans-serif;background:#0b1015;color:#edf4f5;display:grid;place-items:center;min-height:100vh;margin:0">
<main style="max-width:420px;padding:24px;text-align:center"><h1 style="font-size:22px">접근 권한이 없습니다.</h1>
<p style="color:#8c9ba7;line-height:1.6">WONY PHONE에 관리자 계정으로 로그인한 뒤<br>"야구 분석" 앱에서 열어주세요.</p></main></body></html>'''


def _deny(request, code='auth_required', status=401):
    if request.url.path.startswith('/api/') or 'application/json' in request.headers.get('accept', ''):
        return JSONResponse({'detail': f'[{code}] Open from WONY PHONE with an admin account'}, status_code=status)
    return HTMLResponse(_DENIED, status_code=status)


def install(app):
    @app.middleware('http')
    async def wony_admin_gate(request: Request, call_next):
        secret = os.getenv(SECRET_ENV, '')
        if not secret:
            return await call_next(request)  # local-only mode (unchanged behavior)
        if len(secret) < 32:
            return _deny(request, 'auth_misconfigured', 503)
        path = request.url.path
        if path == '/wony-login':
            try:
                sub = verify_ticket(request.query_params.get('ticket', ''), secret)
            except (ValueError, TypeError, json.JSONDecodeError):
                return _deny(request, 'invalid_ticket')
            response = RedirectResponse('/', status_code=303)
            secure = request.url.scheme == 'https' or request.headers.get('x-forwarded-proto') == 'https'
            response.set_cookie(COOKIE, make_session(sub, secret), max_age=SESSION_SECONDS, httponly=True,
                                samesite='lax', secure=secure, path='/')
            response.headers['Cache-Control'] = 'no-store'
            return response
        if path in OPEN_PATHS or verify_session(request.cookies.get(COOKIE), secret):
            return await call_next(request)
        return _deny(request)
