"""WONY PHONE 회원 입장권 → WONY RHYTHM 세션.

WONY PHONE 서버(server/rhythmLink.ts)가 Supabase 세션을 서버에서 검증(auth.getUser)한 뒤
``v1.<payload>.<HMAC-SHA256>`` 입장권을 발급합니다 (60초, 1회용 nonce, aud = wony-rhythm).
  payload = {"sub": user_id, "role": "user|manager|admin", "name": 닉네임, "aud": "wony-rhythm", "exp": ..., "nonce": ...}
이 서버는 입장권을 확인하고 HttpOnly 세션 쿠키(서명)를 발급합니다. 이후 user_id 는 이 쿠키에서만 얻습니다.
(야구 분석 때 쓰던 app/auth/wony_link.py 와 같은 서명 형식. 비밀값과 aud 가 달라 서로 섞이지 않음)
"""
import hashlib
import hmac
import json
import re
import threading
import time

from app.auth.wony_link import _b64e, _sign, _unpack

AUDIENCE = 'wony-rhythm'
COOKIE = 'wony_rhythm_session'
ROLES = ('user', 'manager', 'admin')
UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
TICKET_MAX_AGE = 120  # 입장권 유효시간 상한 (발급 측 60초)

_used = {}
_lock = threading.Lock()


class TicketError(ValueError):
    pass


def _session_key(link_secret):
    # 입장권 비밀값을 그대로 쓰지 않고 용도별 키를 파생 (쿠키로 입장권을 만들 수 없게)
    return hmac.new(link_secret.encode(), b'wony-rhythm-session-v1', hashlib.sha256).hexdigest()


def clean_name(value):
    if not isinstance(value, str):
        return None
    name = re.sub(r'[\x00-\x1f\x7f]', '', value).strip()[:30]
    return name or None


def verify_ticket(token, secret, now=None):
    """회원 입장권 확인 → {"sub", "role", "name"}. 위조 · 만료 · 재사용 · 다른 용도 입장권은 TicketError."""
    now = time.time() if now is None else now
    try:
        payload = _unpack(token, secret, 'v1')
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        raise TicketError('malformed') from exc
    sub, role, exp, nonce = payload.get('sub'), payload.get('role'), payload.get('exp'), payload.get('nonce')
    if payload.get('aud') != AUDIENCE:
        raise TicketError('audience')
    if not isinstance(sub, str) or not UUID_RE.match(sub):
        raise TicketError('subject')
    if role not in ROLES:
        raise TicketError('role')
    if not isinstance(exp, (int, float)) or exp < now or exp > now + TICKET_MAX_AGE:
        raise TicketError('expired')
    if not isinstance(nonce, str) or not 16 <= len(nonce) <= 128:
        raise TicketError('nonce')
    with _lock:
        for key in [k for k, until in _used.items() if until < now]:
            del _used[key]
        if nonce in _used:
            raise TicketError('reused')
        _used[nonce] = exp
    return {'sub': sub, 'role': role, 'name': clean_name(payload.get('name'))}


def make_session(member, link_secret, ttl, now=None):
    exp = int((time.time() if now is None else now) + ttl)
    data = {'sub': member['sub'], 'name': member.get('name'), 'exp': exp}
    body = 'r1.' + _b64e(json.dumps(data, separators=(',', ':'), ensure_ascii=False).encode())
    return f'{body}.{_sign(_session_key(link_secret), body)}'


def read_session(value, link_secret, now=None):
    """세션 쿠키 → {"sub", "name"} 또는 None (위조 · 만료 · 형식 오류)."""
    if not value or not link_secret:
        return None
    try:
        payload = _unpack(value, _session_key(link_secret), 'r1')
    except (ValueError, TypeError, json.JSONDecodeError):
        return None
    now = time.time() if now is None else now
    sub, exp = payload.get('sub'), payload.get('exp')
    if not isinstance(sub, str) or not UUID_RE.match(sub) or not isinstance(exp, int) or exp <= now:
        return None
    return {'sub': sub, 'name': clean_name(payload.get('name'))}
