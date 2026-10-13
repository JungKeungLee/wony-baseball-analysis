"""Supabase 서명 함수 호출 (표준 라이브러리 urllib 만 사용 — 의존성 추가 없음).

  public.rhythm_submit_play(p_payload, p_signature)
  public.rhythm_get_ranking_signed(p_payload, p_signature)
  public.rhythm_get_wallet_signed(p_payload, p_signature)      (006: 츄르 잔액)

payload = 이 서버가 만든 JSON 문자열, signature = hex(HMAC-SHA256(RHYTHM_DB_SECRET, payload)).
DB 는 같은 비밀값으로 서명 · 5분 이내 시각 · 1회용 nonce(저장)를 확인합니다 (supabase/sql/003).
publishable(anon) key 로 호출하며 service role key 는 쓰지 않습니다.
비밀값 · 키 · 응답 본문은 로그에 남기지 않습니다.
"""
import hashlib
import hmac
import json
import logging
import secrets
import time
import urllib.error
import urllib.request

log = logging.getLogger('uvicorn.error').getChild('rhythm')
TIMEOUT = 6


class DbError(RuntimeError):
    """kind: rejected(값 거절 · 400) / unavailable(네트워크 · 장애) / misconfigured(서명 · 설정 불일치)"""

    def __init__(self, kind, message=''):
        super().__init__(message or kind)
        self.kind = kind


def sign(payload, secret):
    return hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()


class RhythmDb:
    def __init__(self, config, opener=None):
        self.config = config
        self._open = opener or urllib.request.urlopen

    def _rpc(self, fn, payload_obj):
        payload = json.dumps(payload_obj, separators=(',', ':'), ensure_ascii=True, sort_keys=True)
        body = json.dumps({'p_payload': payload, 'p_signature': sign(payload, self.config.db_secret)}).encode()
        headers = {'apikey': self.config.publishable_key, 'Content-Type': 'application/json', 'Accept': 'application/json'}
        if self.config.publishable_key.startswith('eyJ'):  # 이전 형식 anon JWT 는 Authorization 도 필요
            headers['Authorization'] = f'Bearer {self.config.publishable_key}'
        req = urllib.request.Request(f'{self.config.supabase_url}/rest/v1/rpc/{fn}', data=body, headers=headers, method='POST')
        try:
            with self._open(req, timeout=TIMEOUT) as res:
                return json.loads(res.read().decode() or 'null')
        except urllib.error.HTTPError as exc:
            detail = {}
            try:
                detail = json.loads(exc.read().decode() or '{}')
            except (ValueError, OSError):
                pass
            code = str(detail.get('code') or '')
            message = str(detail.get('message') or '')
            if code in ('28000', '55000') or exc.code in (401, 403):
                # 서명 · 비밀값 · 키 설정 불일치 (사용자 잘못이 아님) → 운영 확인 필요
                log.warning('rhythm db %s: auth/config error (status %s, code %s)', fn, exc.code, code or '-')
                raise DbError('misconfigured') from None
            if exc.code == 400 or code.startswith(('22', '23')):
                raise DbError('rejected', message[:200]) from None
            log.warning('rhythm db %s: http %s', fn, exc.code)
            raise DbError('unavailable') from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
            log.warning('rhythm db %s: %s', fn, type(exc).__name__)
            raise DbError('unavailable') from None

    def submit(self, user_id, record):
        return self._rpc('rhythm_submit_play', {
            'action': 'submit', 'user_id': user_id, 'ts': int(time.time()), 'nonce': secrets.token_hex(16), 'record': record,
        })

    def ranking(self, user_id, song_id, difficulty, lane_count, limit, around=0):
        rows = self._rpc('rhythm_get_ranking_signed', {
            'action': 'ranking', 'user_id': user_id, 'ts': int(time.time()),
            'song_id': song_id, 'difficulty': difficulty, 'lane_count': lane_count, 'limit': limit, 'around': around,
        })
        return rows if isinstance(rows, list) else []

    def wallet(self, user_id):
        """츄르 잔액 (지갑이 없으면 0)"""
        out = self._rpc('rhythm_get_wallet_signed', {'action': 'wallet', 'user_id': user_id, 'ts': int(time.time())})
        balance = out.get('churu_balance') if isinstance(out, dict) else None
        if not isinstance(balance, int) or isinstance(balance, bool) or balance < 0:
            raise DbError('unavailable')
        return balance
