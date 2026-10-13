"""WONY RHYTHM 온라인 기록 · 랭킹 API (게임 플레이 중에는 호출되지 않음: 결과 화면 1번 + 랭킹 화면).

  GET  /rhythm-login?ticket=…&next=/…   WONY PHONE 입장권 → 세션 쿠키 → 게임 화면으로 이동
  POST /api/rhythm/logout                세션 쿠키 삭제
  GET  /api/rhythm/me                    로그인 · 온라인 기능 상태 · 츄르 잔액(로그인 회원)
  POST /api/rhythm/results               게임 결과 1건 저장 (로그인 회원, 실제 플레이만) → 순위 전/후 · 츄르 지급 결과
  GET  /api/rhythm/ranking?song&difficulty&laneCount&limit&around   곡 + 난이도 랭킹 (로그인 회원, around = 내 앞뒤 순위)

user_id 는 요청 본문이 아니라 세션 쿠키에서만 정합니다 (본문에 user_id 가 있으면 거절).
AUTO / PREVIEW 판은 게임이 보내지 않고, 보내더라도 여기서 거절합니다 (autoplay · preview 필드 = 허용되지 않은 필드).
츄르 지급량 · 잔액 · 순위는 DB 가 계산합니다. 본문에 churu · 잔액 같은 필드가 있으면 거절합니다 (허용되지 않은 필드).
같은 판(play_id)을 다시 보내면 DB 가 처음 결과를 그대로 돌려줍니다 (재저장 · 재지급 없음).
"""
import json
import logging
import threading
import time
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.rhythm.auth import COOKIE, TicketError, make_session, read_session, verify_ticket
from app.rhythm.config import load_config
from app.rhythm.supabase import DbError, RhythmDb

log = logging.getLogger('uvicorn.error').getChild('rhythm')
SITE = Path(__file__).resolve().parents[3] / 'frontend-demo'
NOTE_SPEEDS = (0.75, 1.0, 1.25, 1.5, 1.75, 2.0)   # frontend-demo/js/config.js NOTE_SPEEDS
DIFFICULTIES = ('easy', 'normal', 'hard', 'hell')
SUBMIT_MIN_INTERVAL = 3       # 같은 회원 저장 최소 간격(초)
SUBMIT_MAX_PER_HOUR = 120
RANKING_CACHE_SECONDS = 20
WALLET_CACHE_SECONDS = 30
UUID_PATTERN = r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'


class ResultRow(BaseModel):
    """js/ranking.js toRankingRow 와 같은 필드 (= DB 컬럼). 그 외 필드(user_id, autoplay, preview …)는 거절."""
    model_config = ConfigDict(extra='forbid', strict=False)

    play_id: str = Field(pattern=UUID_PATTERN)   # 게임 1판 고유값 (중복 저장 · 중복 지급 방지)
    song_id: str = Field(pattern=r'^[a-z0-9][a-z0-9-]{1,47}$')
    difficulty: Literal['easy', 'normal', 'hard', 'hell']
    lane_count: Literal[4, 6, 8] = 4
    note_speed: float
    status: Literal['CLEAR', 'GAME_OVER', 'NO_FAIL_CLEAR']
    no_fail: bool
    score: int = Field(ge=0, le=22_000_000)
    grade: Literal['S+', 'S', 'A', 'B', 'C', 'D', 'F']
    accuracy: float = Field(ge=0, le=100)
    max_combo: int = Field(ge=0, le=20_000)
    perfect_count: int = Field(ge=0, le=20_000)
    great_count: int = Field(ge=0, le=20_000)
    good_count: int = Field(ge=0, le=20_000)
    miss_count: int = Field(ge=0, le=20_000)
    total_notes: int = Field(ge=1, le=20_000)
    final_life: float = Field(ge=0, le=100)
    result_version: int = Field(ge=1, le=100)


# ── 곡 / 채보 (서버에 있는 파일로 총 노트 수 확인) ──────────────────────────────
_chart_cache = {}


def chart_info(song_id, difficulty):
    """(laneCount, 노트 수) 또는 None (곡/난이도 없음). 파일이 바뀌면 다시 읽음."""
    try:
        catalog_path = SITE / 'songs' / 'songs.json'
        songs = json.loads(catalog_path.read_text(encoding='utf-8')).get('songs', [])
        song = next((s for s in songs if s.get('id') == song_id), None)
        if not song or difficulty not in (song.get('difficulties') or []):
            return None
        path = SITE / 'songs' / 'charts' / f'{song_id}-{difficulty}.json'
        mtime = path.stat().st_mtime
        cached = _chart_cache.get(path)
        if cached and cached[0] == mtime:
            return cached[1]
        chart = json.loads(path.read_text(encoding='utf-8'))
        info = (int(chart.get('laneCount', 4)), len(chart.get('notes') or []))
        _chart_cache[path] = (mtime, info)
        return info
    except (OSError, ValueError, TypeError):
        return None


class Limiter:
    def __init__(self):
        self.lock = threading.Lock()
        self.hits = {}
        self.plays = {}

    def seen(self, key, play_id):
        """이미 저장 요청을 보낸 판의 재전송인지 (재시도는 간격 제한 없이 DB 가 처음 결과를 돌려줌)"""
        with self.lock:
            return play_id in self.plays.get(key, ())

    def remember(self, key, play_id):
        with self.lock:
            plays = self.plays.setdefault(key, [])
            if play_id not in plays:
                plays.append(play_id)
            del plays[:-50]

    def allow(self, key, now=None):
        now = time.time() if now is None else now
        with self.lock:
            recent = [t for t in self.hits.get(key, []) if t > now - 3600]
            if (recent and now - recent[-1] < SUBMIT_MIN_INTERVAL) or len(recent) >= SUBMIT_MAX_PER_HOUR:
                self.hits[key] = recent
                return False
            recent.append(now)
            self.hits[key] = recent
            return True


def _int_or_none(v):
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def submit_response(out):
    """DB 결과 → 브라우저 응답 (DB 가 계산한 값만 전달)"""
    out = out if isinstance(out, dict) else {}
    churu = out.get('churu') if isinstance(out.get('churu'), dict) else {}
    granted = churu.get('granted') is True
    return {
        'ok': True,
        'ranked': out.get('ranked') is True,
        'duplicate': out.get('duplicate') is True,
        'best': out.get('best'),
        'improved': out.get('improved') or {},
        'rankBefore': _int_or_none(out.get('rank_before')),
        'rankAfter': _int_or_none(out.get('rank_after')),
        'totalRanked': _int_or_none(out.get('total_ranked')),
        'bestBefore': _int_or_none(out.get('best_before')),
        'churu': {
            'granted': granted,
            'amount': (_int_or_none(churu.get('amount')) or 0) if granted else 0,
            'balanceBefore': _int_or_none(churu.get('balance_before')) if granted else None,
            'balanceAfter': _int_or_none(churu.get('balance_after')) if granted else None,
        },
    }


def _json(status, body):
    return JSONResponse(body, status_code=status, headers={'Cache-Control': 'private, no-store'})


def _safe_next(value):
    if not value or not value.startswith('/') or value.startswith('//') or value.startswith('/\\') or len(value) > 200:
        return '/'
    return value


def _same_origin(request):
    origin = request.headers.get('origin')
    if origin is None:
        return request.headers.get('sec-fetch-site') in (None, 'same-origin')
    host = request.headers.get('x-forwarded-host') or request.headers.get('host')
    return origin.split('://', 1)[-1] == host


def create_router(env=None, db_factory=RhythmDb):
    router = APIRouter()
    limiter = Limiter()
    cache = {}
    wallets = {}   # user_id → (시각, 잔액). 저장 결과로 갱신
    cache_lock = threading.Lock()

    def cfg():
        return load_config(env)

    def member(request):
        c = cfg()
        return read_session(request.cookies.get(COOKIE), c.link_secret) if c.login_enabled else None

    @router.get('/rhythm-login', include_in_schema=False)
    def login(request: Request, ticket: str = '', next: str = '/'):  # noqa: A002 - 쿼리 이름
        c = cfg()
        target = _safe_next(next)
        if not c.login_enabled:
            return RedirectResponse('/?login=unavailable', status_code=303)
        try:
            who = verify_ticket(ticket, c.link_secret)
        except TicketError as exc:
            log.info('rhythm login refused: %s', exc)  # 입장권 값은 남기지 않음
            return RedirectResponse(f'{target}{"&" if "?" in target else "?"}login=failed', status_code=303)
        res = RedirectResponse(target, status_code=303)
        secure = request.url.scheme == 'https' or request.headers.get('x-forwarded-proto') == 'https'
        res.set_cookie(COOKIE, make_session(who, c.link_secret, c.session_seconds), max_age=c.session_seconds,
                       httponly=True, samesite='lax', secure=secure, path='/')
        res.headers['Cache-Control'] = 'no-store'
        res.headers['Referrer-Policy'] = 'no-referrer'
        return res

    @router.post('/api/rhythm/logout')
    def logout(request: Request):
        if not _same_origin(request):
            return _json(403, {'ok': False, 'error': 'forbidden'})
        res = _json(200, {'ok': True})
        res.delete_cookie(COOKIE, path='/')
        return res

    async def churu_balance(c, uid):
        now = time.time()
        with cache_lock:
            hit = wallets.get(uid)
            if hit and now - hit[0] < WALLET_CACHE_SECONDS:
                return hit[1]
        try:
            balance = await _run(lambda: db_factory(c).wallet(uid))
        except DbError:
            return None   # 잔액을 못 읽어도 로그인 · 게임은 정상
        with cache_lock:
            if len(wallets) > 2000:
                wallets.clear()
            wallets[uid] = (now, balance)
        return balance

    @router.get('/api/rhythm/me')
    async def me(request: Request):
        c = cfg()
        who = member(request)
        balance = await churu_balance(c, who['sub']) if who is not None and c.online_enabled else None
        return _json(200, {
            'loggedIn': who is not None,
            'nickname': who['name'] if who else None,
            'onlineEnabled': c.online_enabled,
            'loginUrl': c.phone_url,
            'churuBalance': balance,
        })

    @router.post('/api/rhythm/results')
    async def results(request: Request):
        c = cfg()
        if not _same_origin(request):
            return _json(403, {'ok': False, 'error': 'forbidden'})
        who = member(request)
        if who is None:
            return _json(401, {'ok': False, 'error': 'login_required'})
        if not c.online_enabled:
            return _json(503, {'ok': False, 'error': 'not_configured'})
        raw = await request.body()
        if len(raw) > 4096:
            return _json(413, {'ok': False, 'error': 'too_large'})
        try:
            row = ResultRow.model_validate_json(raw)
        except ValidationError as exc:
            return _json(422, {'ok': False, 'error': 'invalid', 'fields': sorted({str(e['loc'][0]) for e in exc.errors() if e.get('loc')})})
        if round(row.note_speed, 2) not in NOTE_SPEEDS:
            return _json(422, {'ok': False, 'error': 'invalid', 'fields': ['note_speed']})
        info = chart_info(row.song_id, row.difficulty)
        if info is None:
            return _json(400, {'ok': False, 'error': 'unknown_song'})
        if info != (row.lane_count, row.total_notes):
            return _json(400, {'ok': False, 'error': 'chart_mismatch'})
        retry = limiter.seen(who['sub'], row.play_id)
        if not retry and not limiter.allow(who['sub']):
            return _json(429, {'ok': False, 'error': 'too_many'})
        limiter.remember(who['sub'], row.play_id)
        try:
            out = await _run(lambda: db_factory(c).submit(who['sub'], row.model_dump()))
        except DbError as exc:
            if exc.kind == 'rejected':
                return _json(400, {'ok': False, 'error': 'rejected'})
            return _json(503 if exc.kind == 'misconfigured' else 502, {'ok': False, 'error': exc.kind})
        body = submit_response(out)
        with cache_lock:  # 이 곡 · 난이도 랭킹 캐시 무효화, 지갑 잔액 갱신
            for key in [k for k in cache if k[1:4] == (row.song_id, row.difficulty, row.lane_count)]:
                del cache[key]
            if body['churu']['balanceAfter'] is not None and not body['duplicate']:
                wallets[who['sub']] = (time.time(), body['churu']['balanceAfter'])
        return _json(200, body)

    @router.get('/api/rhythm/ranking')
    async def ranking(request: Request, song: str = Query(pattern=r'^[a-z0-9][a-z0-9-]{1,47}$'),
                      difficulty: Literal['easy', 'normal', 'hard', 'hell'] = 'normal',
                      laneCount: int = 4, limit: int = Query(default=50, ge=1, le=100),  # noqa: N803
                      around: int = Query(default=0, ge=0, le=5)):
        c = cfg()
        if laneCount not in (4, 6, 8):  # 쿼리 문자열 "4" 도 받도록 int 로 받은 뒤 확인
            return _json(422, {'ok': False, 'error': 'invalid', 'fields': ['laneCount']})
        who = member(request)
        if who is None:
            return _json(401, {'ok': False, 'error': 'login_required'})
        if not c.online_enabled:
            return _json(503, {'ok': False, 'error': 'not_configured'})
        key = (who['sub'], song, difficulty, laneCount, limit, around)
        now = time.time()
        with cache_lock:
            hit = cache.get(key)
            if hit and now - hit[0] < RANKING_CACHE_SECONDS:
                return _json(200, {'ok': True, 'rows': hit[1], 'cached': True})
        try:
            rows = await _run(lambda: db_factory(c).ranking(who['sub'], song, difficulty, laneCount, limit, around))
        except DbError as exc:
            return _json(503 if exc.kind == 'misconfigured' else 502, {'ok': False, 'error': exc.kind})
        out = [{
            'rank': r.get('rank'), 'nickname': r.get('nickname'), 'avatarUrl': r.get('avatar_url'),
            'bestScore': r.get('best_score'), 'bestGrade': r.get('best_grade'), 'bestAccuracy': r.get('best_accuracy'),
            'bestMaxCombo': r.get('best_max_combo'), 'isMe': r.get('is_me') is True,
        } for r in rows if isinstance(r, dict)]
        with cache_lock:
            if len(cache) > 500:
                cache.clear()
            cache[key] = (now, out)
        return _json(200, {'ok': True, 'rows': out})

    return router


async def _run(fn):
    from starlette.concurrency import run_in_threadpool
    return await run_in_threadpool(fn)
