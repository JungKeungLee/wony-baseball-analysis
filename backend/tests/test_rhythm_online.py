"""WONY RHYTHM 온라인 기록 (입장권 → 세션 → 결과 저장 / 랭킹). Supabase 는 가짜로 대체 (실제 접속 없음)."""
import base64
import hashlib
import hmac
import io
import json
import logging
import time
import urllib.error
import uuid
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.main import app as main_app
from app.rhythm import auth as rhythm_auth
from app.rhythm.config import load_config
from app.rhythm.routes import create_router
from app.rhythm.supabase import DbError, RhythmDb, sign

LINK = 'link-secret-' + 'a' * 40
DBS = 'db-secret-' + 'b' * 40
ENV = {
    'RHYTHM_LINK_SECRET': LINK, 'RHYTHM_DB_SECRET': DBS, 'SUPABASE_URL': 'https://example.supabase.co',
    'SUPABASE_PUBLISHABLE_KEY': 'sb_publishable_test', 'WONY_PHONE_URL': 'https://phone.example/phone',
}
USER = str(uuid.uuid4())
POLICY = json.loads((Path(__file__).resolve().parents[2] / 'shared' / 'record_policy_cases.json').read_text(encoding='utf-8'))


def ticket(secret=LINK, **over):
    data = {'sub': USER, 'role': 'user', 'name': '워니팬', 'aud': 'wony-rhythm', 'exp': int(time.time()) + 60,
            'nonce': uuid.uuid4().hex, **over}
    body = 'v1.' + base64.urlsafe_b64encode(json.dumps(data).encode()).rstrip(b'=').decode()
    sig = base64.urlsafe_b64encode(hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest()).rstrip(b'=').decode()
    return f'{body}.{sig}'


class FakeDb:
    """006 rhythm_submit_play 와 같은 응답 형태 (play_id 중복 · 츄르 · 순위 전/후)"""
    calls = []
    fail = None
    wallet_fail = None
    rows = []
    plays = {}
    balance = {}
    REWARD = {'easy': 1, 'normal': 2, 'hard': 4, 'hell': 7}

    def __init__(self, config):
        self.config = config

    def submit(self, user_id, record):
        FakeDb.calls.append(('submit', user_id, record))
        if FakeDb.fail:
            raise DbError(FakeDb.fail)
        if record['play_id'] in FakeDb.plays:
            return {**FakeDb.plays[record['play_id']], 'duplicate': True, 'rank_before': None}
        ranked = record['status'] == 'CLEAR' and not record['no_fail']
        churu = {'granted': False, 'amount': 0}
        if ranked:
            before = FakeDb.balance.get(user_id, 0)
            amount = FakeDb.REWARD[record['difficulty']]
            FakeDb.balance[user_id] = before + amount
            churu = {'granted': True, 'amount': amount, 'balance_before': before, 'balance_after': before + amount}
        out = {'record_id': str(uuid.uuid4()), 'play_id': record['play_id'], 'duplicate': False, 'ranked': ranked,
               'rank_before': 12 if ranked else None, 'rank_after': 7 if ranked else None, 'total_ranked': 30,
               'best_before': 1000 if ranked else None,
               'best': {'best_score': record['score']} if ranked else None, 'improved': {'score': ranked}, 'churu': churu}
        FakeDb.plays[record['play_id']] = out
        return out

    def ranking(self, user_id, song, difficulty, lane_count, limit, around=0):
        FakeDb.calls.append(('ranking', user_id, song, difficulty, lane_count, limit) + ((around,) if around else ()))
        if FakeDb.fail:
            raise DbError(FakeDb.fail)
        return FakeDb.rows

    def my_records(self, user_id):
        FakeDb.calls.append(('records', user_id))
        if FakeDb.fail:
            raise DbError(FakeDb.fail)
        return {
            'best': [{'song_id': 'demo-beat', 'difficulty': 'hard', 'lane_count': 4, 'best_score': 30000, 'best_grade': 'S+',
                      'best_accuracy': 100, 'best_max_combo': 30, 'clear_count': 2, 'best_score_at': '2026-10-14T00:00:00Z'}],
            'recent': [{'song_id': 'demo-beat', 'difficulty': 'hell', 'lane_count': 4, 'note_speed': 1, 'status': 'GAME_OVER',
                        'no_fail': False, 'score': 3000, 'grade': 'F', 'accuracy': 23.08, 'max_combo': 3, 'perfect_count': 3,
                        'great_count': 0, 'good_count': 0, 'miss_count': 10, 'total_notes': 13, 'final_life': 0,
                        'ranked': False, 'created_at': '2026-10-14T00:05:00Z'}],
        }

    def wallet(self, user_id):
        FakeDb.calls.append(('wallet', user_id))
        if FakeDb.wallet_fail:
            raise DbError(FakeDb.wallet_fail)
        return FakeDb.balance.get(user_id, 0)


@pytest.fixture
def client():
    FakeDb.calls, FakeDb.fail, FakeDb.wallet_fail, FakeDb.rows, FakeDb.plays, FakeDb.balance = [], None, None, [], {}, {}
    rhythm_auth._used.clear()
    app = FastAPI()
    app.include_router(create_router(ENV, db_factory=FakeDb))
    return TestClient(app, base_url='https://testserver', follow_redirects=False)


def login(client, **over):
    res = client.get('/rhythm-login', params={'ticket': ticket(**over), 'next': '/songs'})
    assert res.status_code == 303
    return res


def chart_count(song='demo-beat', diff='hard'):
    site = Path(__file__).resolve().parents[2] / 'frontend-demo'
    return len(json.loads((site / 'songs' / 'charts' / f'{song}-{diff}.json').read_text(encoding='utf-8'))['notes'])


def row(status='CLEAR', no_fail=False, **over):
    total = chart_count()
    p = total if status != 'GAME_OVER' else 3
    m = 0 if status != 'GAME_OVER' else 10
    base = {
        'play_id': str(uuid.uuid4()), 'song_id': 'demo-beat', 'difficulty': 'hard', 'lane_count': 4, 'note_speed': 1.5, 'status': status,
        'no_fail': no_fail, 'score': p * 1000, 'grade': 'S+' if status != 'GAME_OVER' else 'F',
        'accuracy': round(p * 100 / total, 2), 'max_combo': p, 'perfect_count': p, 'great_count': 0, 'good_count': 0,
        'miss_count': m, 'total_notes': total, 'final_life': 100 if status == 'CLEAR' else 0, 'result_version': 3,
    }
    return {**base, **over}


def post(client, body, origin='https://testserver'):
    return client.post('/api/rhythm/results', content=json.dumps(body), headers={'Content-Type': 'application/json', 'Origin': origin})


# ── 입장권 / 세션 ──────────────────────────────────────────────────────────────
def test_login_sets_httponly_session_and_redirects(client):
    res = login(client)
    assert res.headers['location'] == '/songs'
    cookie = res.headers['set-cookie']
    assert 'wony_rhythm_session=' in cookie and 'HttpOnly' in cookie and 'SameSite=lax' in cookie and 'Secure' in cookie
    assert res.headers['referrer-policy'] == 'no-referrer'
    me = client.get('/api/rhythm/me').json()
    assert me == {'loggedIn': True, 'nickname': '워니팬', 'onlineEnabled': True, 'loginUrl': 'https://phone.example/phone',
                  'churuBalance': 0}


@pytest.mark.parametrize('bad', [
    lambda: ticket(secret='other-secret-' + 'c' * 40),
    lambda: ticket(aud='wony-baseball'),          # 다른 서비스용 입장권
    lambda: ticket(role='guest'),
    lambda: ticket(sub='not-a-uuid'),
    lambda: ticket(exp=int(time.time()) - 1),
    lambda: ticket(exp=int(time.time()) + 3600),  # 너무 긴 입장권
    lambda: ticket()[:-3] + 'abc',
    lambda: '',
])
def test_bad_tickets_do_not_log_in(client, bad):
    res = client.get('/rhythm-login', params={'ticket': bad()})
    assert res.status_code == 303 and 'login=failed' in res.headers['location']
    assert 'set-cookie' not in res.headers
    assert client.get('/api/rhythm/me').json()['loggedIn'] is False


def test_ticket_is_one_time(client):
    t = ticket()
    assert 'set-cookie' in client.get('/rhythm-login', params={'ticket': t}).headers
    other = TestClient(client.app, base_url='https://testserver', follow_redirects=False)
    assert 'set-cookie' not in other.get('/rhythm-login', params={'ticket': t}).headers


def test_open_redirect_blocked(client):
    for nxt in ('https://evil.example', '//evil.example', '/\\evil'):
        res = client.get('/rhythm-login', params={'ticket': ticket(), 'next': nxt})
        assert res.headers['location'] == '/'


def test_forged_or_expired_session_is_ignored(client):
    expired = rhythm_auth.make_session({'sub': USER, 'name': 'x'}, LINK, ttl=-10)
    client.cookies.set('wony_rhythm_session', expired)
    assert client.get('/api/rhythm/me').json()['loggedIn'] is False
    client.cookies.set('wony_rhythm_session', rhythm_auth.make_session({'sub': USER, 'name': 'x'}, 'wrong-' + 'd' * 40, ttl=60))
    assert client.get('/api/rhythm/me').json()['loggedIn'] is False
    # 입장권 비밀값으로 직접 만든 v1 토큰은 세션으로 통하지 않음 (용도별 키)
    client.cookies.set('wony_rhythm_session', ticket())
    assert client.get('/api/rhythm/me').json()['loggedIn'] is False


def test_logout(client):
    login(client)
    assert client.post('/api/rhythm/logout', headers={'Origin': 'https://testserver'}).status_code == 200
    assert client.get('/api/rhythm/me').json()['loggedIn'] is False


# ── 결과 저장 ──────────────────────────────────────────────────────────────────
def test_not_logged_in_cannot_save(client):
    res = post(client, row())
    assert res.status_code == 401 and FakeDb.calls == []


def test_logged_in_saves_own_record_with_session_user_id(client):
    login(client)
    res = post(client, row())
    assert res.status_code == 200, res.text
    assert res.json()['ok'] is True and res.json()['ranked'] is True
    kind, uid, record = FakeDb.calls[0]
    assert kind == 'submit' and uid == USER
    assert 'user_id' not in record


def test_submit_response_carries_db_rank_and_churu(client):
    login(client)
    body = post(client, row()).json()
    assert body == {
        'ok': True, 'ranked': True, 'duplicate': False, 'best': {'best_score': body['best']['best_score']},
        'improved': {'score': True}, 'rankBefore': 12, 'rankAfter': 7, 'totalRanked': 30, 'bestBefore': 1000,
        'churu': {'granted': True, 'amount': 4, 'balanceBefore': 0, 'balanceAfter': 4},
    }
    rhythm_auth._used.clear()
    client.cookies.clear()
    login(client, sub=str(uuid.uuid4()))
    over = post(client, row('GAME_OVER')).json()
    assert over['ranked'] is False and over['rankAfter'] is None
    assert over['churu'] == {'granted': False, 'amount': 0, 'balanceBefore': None, 'balanceAfter': None}


def test_play_id_required_and_must_be_uuid(client):
    login(client)
    body = row()
    del body['play_id']
    assert post(client, body).status_code == 422
    for bad in ['', 'abc', '1' * 36, str(uuid.uuid4()).upper(), str(uuid.uuid4()) + 'x']:
        res = post(client, row(play_id=bad))
        assert res.status_code == 422 and res.json()['fields'] == ['play_id'], bad
    assert FakeDb.calls == []


@pytest.mark.parametrize('field', ['churu', 'churuReward', 'churu_reward', 'churu_balance', 'price', 'balance', 'owned_skins'])
def test_client_cannot_send_churu_or_balance(client, field):
    login(client)
    res = post(client, {**row(), field: 9999})
    assert res.status_code == 422 and field in res.json()['fields']
    assert FakeDb.calls == []


def test_same_play_retry_is_not_rate_limited_and_not_regranted(client):
    """네트워크 재시도 · 새로고침: 같은 play_id 는 간격 제한 없이 다시 보내도 DB 가 처음 결과(중복)만 돌려줌"""
    login(client)
    body = row()
    first = post(client, body).json()
    again = post(client, body)
    assert again.status_code == 200, again.text
    assert again.json()['duplicate'] is True and again.json()['churu'] == first['churu']
    assert FakeDb.balance[USER] == 4, '츄르는 1번만'
    # 새 판은 여전히 간격 제한
    assert post(client, row()).status_code == 429


def test_user_id_in_body_is_rejected(client):
    login(client)
    res = post(client, {**row(), 'user_id': str(uuid.uuid4())})
    assert res.status_code == 422 and 'user_id' in res.json()['fields']
    assert FakeDb.calls == []


@pytest.mark.parametrize('flag', ['autoplay', 'preview'])
def test_auto_and_preview_are_rejected(client, flag):
    login(client)
    assert post(client, {**row(), flag: True}).status_code == 422
    assert FakeDb.calls == []


def test_policy_cases_match_server(client):
    """shared/record_policy_cases.json: 서버가 받는 판(실제 플레이)과 랭킹 여부"""
    login(client)
    for c in POLICY['cases']:
        if not c['expect']['sendOnline']:
            continue  # AUTO / PREVIEW: 게임이 보내지 않음 (위 테스트: 보내도 거절)
        rhythm_auth._used.clear()
        status = c['status']
        body = row(status, c['noFail']) if status != 'NO_FAIL_CLEAR' else row('NO_FAIL_CLEAR', True, final_life=0)
        res = post(client, body)
        if res.status_code == 429:  # 저장 간격 제한: 다른 회원 세션으로
            client.cookies.clear()
            login(client, sub=str(uuid.uuid4()))
            res = post(client, body)
        assert res.status_code == 200, (c['name'], res.text)
        assert res.json()['ranked'] is c['expect']['ranking'], c['name']


@pytest.mark.parametrize('patch, code', [
    ({'score': -1}, 422), ({'accuracy': 101}, 422), ({'difficulty': 'insane'}, 422), ({'final_life': 150}, 422),
    ({'status': 'AUTO'}, 422), ({'note_speed': 1.3}, 422), ({'lane_count': 5}, 422), ({'song_id': '../x'}, 422),
    ({'song_id': 'no-such-song'}, 400), ({'total_notes': 9999}, 400), ({'lane_count': 6}, 400),
])
def test_invalid_results_rejected_before_db(client, patch, code):
    login(client)
    res = post(client, {**row(), **patch})
    assert res.status_code == code, res.text
    assert FakeDb.calls == []


def test_cross_site_post_blocked(client):
    login(client)
    assert post(client, row(), origin='https://evil.example').status_code == 403
    assert FakeDb.calls == []


def test_rate_limit(client):
    login(client)
    assert post(client, row()).status_code == 200
    assert post(client, row()).status_code == 429
    assert len(FakeDb.calls) == 1


@pytest.mark.parametrize('kind, code', [('unavailable', 502), ('misconfigured', 503), ('rejected', 400)])
def test_db_failures_return_clear_errors(client, kind, code):
    login(client)
    FakeDb.fail = kind
    res = post(client, row())
    assert res.status_code == code and res.json()['ok'] is False


def test_online_disabled_without_env():
    app = FastAPI()
    app.include_router(create_router({'RHYTHM_LINK_SECRET': LINK}, db_factory=FakeDb))
    c = TestClient(app, base_url='https://testserver', follow_redirects=False)
    rhythm_auth._used.clear()
    c.get('/rhythm-login', params={'ticket': ticket()})
    assert c.get('/api/rhythm/me').json()['onlineEnabled'] is False
    assert c.get('/api/rhythm/me').json()['churuBalance'] is None
    assert post(c, row()).status_code == 503


# ── 랭킹 ──────────────────────────────────────────────────────────────────────
def test_ranking_requires_login_and_maps_rows(client):
    assert client.get('/api/rhythm/ranking', params={'song': 'demo-beat', 'difficulty': 'hard'}).status_code == 401
    login(client)
    FakeDb.rows = [
        {'rank': 1, 'nickname': '사용자A', 'avatar_url': None, 'best_score': 200000, 'best_grade': 'S+', 'best_accuracy': 99.5,
         'best_max_combo': 300, 'achieved_at': '2026-10-14T00:00:00Z', 'is_me': False},
        {'rank': 2, 'nickname': None, 'avatar_url': None, 'best_score': 185000, 'best_grade': 'S', 'best_accuracy': 96,
         'best_max_combo': 250, 'achieved_at': '2026-10-14T00:01:00Z', 'is_me': True},
    ]
    res = client.get('/api/rhythm/ranking', params={'song': 'demo-beat', 'difficulty': 'hard', 'limit': 10})
    assert res.status_code == 200
    rows = res.json()['rows']
    assert rows[0] == {'rank': 1, 'nickname': '사용자A', 'avatarUrl': None, 'bestScore': 200000, 'bestGrade': 'S+',
                       'bestAccuracy': 99.5, 'bestMaxCombo': 300, 'isMe': False}
    assert rows[1]['isMe'] is True and rows[1]['nickname'] is None
    assert FakeDb.calls[-1] == ('ranking', USER, 'demo-beat', 'hard', 4, 10)
    # 캐시: 같은 요청은 DB 를 다시 부르지 않음, 결과 저장 후에는 다시 부름
    client.get('/api/rhythm/ranking', params={'song': 'demo-beat', 'difficulty': 'hard', 'limit': 10})
    assert sum(1 for c in FakeDb.calls if c[0] == 'ranking') == 1
    post(client, row())
    client.get('/api/rhythm/ranking', params={'song': 'demo-beat', 'difficulty': 'hard', 'limit': 10})
    assert sum(1 for c in FakeDb.calls if c[0] == 'ranking') == 2


def test_me_returns_churu_balance_cached_and_updated_by_submit(client):
    assert client.get('/api/rhythm/me').json()['churuBalance'] is None, '비로그인: 잔액 없음'
    assert FakeDb.calls == []
    login(client)
    FakeDb.balance[USER] = 26
    assert client.get('/api/rhythm/me').json()['churuBalance'] == 26
    assert client.get('/api/rhythm/me').json()['churuBalance'] == 26
    assert sum(1 for c in FakeDb.calls if c[0] == 'wallet') == 1, '잠깐 동안은 캐시'
    post(client, row())
    assert client.get('/api/rhythm/me').json()['churuBalance'] == 30, '저장 결과(DB 잔액)로 바로 갱신'
    assert sum(1 for c in FakeDb.calls if c[0] == 'wallet') == 1


def test_me_wallet_failure_does_not_break_login(client):
    login(client)
    FakeDb.wallet_fail = 'unavailable'
    res = client.get('/api/rhythm/me')
    assert res.status_code == 200 and res.json()['loggedIn'] is True and res.json()['churuBalance'] is None


def test_ranking_around_param(client):
    login(client)
    res = client.get('/api/rhythm/ranking?song=demo-beat&difficulty=hard&laneCount=4&limit=3&around=2')
    assert res.status_code == 200, res.text
    assert FakeDb.calls[-1] == ('ranking', USER, 'demo-beat', 'hard', 4, 3, 2)
    for bad in ['6', '-1', 'x']:
        assert client.get(f'/api/rhythm/ranking?song=demo-beat&difficulty=hard&around={bad}').status_code == 422


def test_ranking_query_params_from_browser(client):
    """브라우저(js/ranking.js)가 보내는 그대로: 숫자도 문자열로 옴"""
    login(client)
    res = client.get('/api/rhythm/ranking?song=demo-beat&difficulty=hard&laneCount=4&limit=10')
    assert res.status_code == 200, res.text
    assert FakeDb.calls[-1] == ('ranking', USER, 'demo-beat', 'hard', 4, 10)
    assert client.get('/api/rhythm/ranking?song=demo-beat&difficulty=hard&laneCount=5').status_code == 422
    assert client.get('/api/rhythm/ranking?song=demo-beat&difficulty=hard&laneCount=x').status_code == 422


def test_ranking_failure_is_reported_not_crashing(client):
    login(client)
    FakeDb.fail = 'unavailable'
    res = client.get('/api/rhythm/ranking', params={'song': 'demo-beat', 'difficulty': 'hard'})
    assert res.status_code == 502 and res.json()['ok'] is False


# ── Supabase 호출 (실제 HTTP 대신 가짜 opener) ─────────────────────────────────
class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_db_request_is_signed_with_publishable_key_only():
    seen = {}

    def opener(req, timeout):
        seen.update(url=req.full_url, headers={k.lower(): v for k, v in req.header_items()}, body=json.loads(req.data))
        return FakeResponse(b'{"ranked": true}')

    db = RhythmDb(load_config(ENV), opener=opener)
    assert db.submit(USER, row())['ranked'] is True
    assert seen['url'] == 'https://example.supabase.co/rest/v1/rpc/rhythm_submit_play'
    assert seen['headers']['apikey'] == 'sb_publishable_test' and 'authorization' not in seen['headers']
    payload = seen['body']['p_payload']
    assert seen['body']['p_signature'] == sign(payload, DBS)
    data = json.loads(payload)
    assert data['action'] == 'submit' and data['user_id'] == USER and len(data['nonce']) == 32 and abs(data['ts'] - time.time()) < 5
    assert DBS not in json.dumps(seen) and LINK not in json.dumps(seen), '비밀값 자체는 전송하지 않음'


@pytest.mark.parametrize('status, body, kind', [
    (400, {'code': '23514', 'message': 'violates check constraint'}, 'rejected'),
    (400, {'code': '28000', 'message': 'rhythm: invalid signature'}, 'misconfigured'),
    (400, {'code': '55000', 'message': 'not configured'}, 'misconfigured'),
    (401, {}, 'misconfigured'),
    (503, {}, 'unavailable'),
])
def test_db_errors_are_classified(status, body, kind):
    def opener(req, timeout):
        raise urllib.error.HTTPError(req.full_url, status, 'x', {}, io.BytesIO(json.dumps(body).encode()))

    with pytest.raises(DbError) as exc:
        RhythmDb(load_config(ENV), opener=opener).submit(USER, row())
    assert exc.value.kind == kind


def test_wallet_and_ranking_requests_are_signed():
    seen = []

    def opener(req, timeout):
        seen.append((req.full_url, json.loads(req.data)))
        return FakeResponse(b'{"churu_balance": 26}' if req.full_url.endswith('wallet_signed') else b'[]')

    db = RhythmDb(load_config(ENV), opener=opener)
    assert db.wallet(USER) == 26
    db.ranking(USER, 'demo-beat', 'hard', 4, 3, 2)
    (wurl, wbody), (rurl, rbody) = seen
    assert wurl.endswith('/rpc/rhythm_get_wallet_signed') and rurl.endswith('/rpc/rhythm_get_ranking_signed')
    assert wbody['p_signature'] == sign(wbody['p_payload'], DBS)
    assert json.loads(wbody['p_payload'])['action'] == 'wallet' and json.loads(wbody['p_payload'])['user_id'] == USER
    assert json.loads(rbody['p_payload'])['around'] == 2


@pytest.mark.parametrize('payload', [b'{}', b'{"churu_balance": -1}', b'{"churu_balance": "9"}', b'null'])
def test_wallet_bad_response_is_unavailable(payload):
    db = RhythmDb(load_config(ENV), opener=lambda req, timeout: FakeResponse(payload))
    with pytest.raises(DbError) as exc:
        db.wallet(USER)
    assert exc.value.kind == 'unavailable'


def test_network_error_and_secrets_not_logged(caplog):
    def opener(req, timeout):
        raise urllib.error.URLError('connection refused')

    with caplog.at_level(logging.INFO):
        with pytest.raises(DbError) as exc:
            RhythmDb(load_config(ENV), opener=opener).ranking(USER, 'demo-beat', 'hard', 4, 50)
    assert exc.value.kind == 'unavailable'
    assert DBS not in caplog.text and LINK not in caplog.text and 'sb_publishable_test' not in caplog.text


def test_secret_key_never_used_as_publishable():
    assert load_config({**ENV, 'SUPABASE_PUBLISHABLE_KEY': 'sb_secret_abc'}).online_enabled is False
    assert load_config({**ENV, 'SUPABASE_URL': 'http://evil.example'}).supabase_url is None


def test_main_app_serves_rhythm_api(monkeypatch):
    monkeypatch.delenv('WONY_AUTH_SECRET', raising=False)
    c = TestClient(main_app)
    me = c.get('/api/rhythm/me')
    assert me.status_code == 200 and me.json()['loggedIn'] is False


# WONY PHONE tests/rhythmLink.test.ts 의 PHONE_RHYTHM_VECTOR 와 같은 값 (TypeScript 로 서명 → Python 으로 검증)
PHONE_RHYTHM_VECTOR = (
    'v1.eyJzdWIiOiIxMTExMTExMS0yMjIyLTQzMzMtODQ0NC01NTU1NTU1NTU1NTUiLCJyb2xlIjoidXNlciIsIm5hbWUiOiLsm4zri4jtjKwiLCJhdWQiOiJ3b255LXJoeXRobSIsImV4cCI6MjAwMDAwMDAwMCwibm9uY2UiOiJuMDEyMzQ1Njc4OWFiY2RlZiJ9.'
    'n0IuvAz7-TYM6xgC6KN1P3_72hVvCQhRxuBQAvJzubc'
)


def test_phone_ticket_vector():
    rhythm_auth._used.clear()
    who = rhythm_auth.verify_ticket(PHONE_RHYTHM_VECTOR, 'rhythm-vector-secret-0123456789abcdef', now=1999999990)
    assert who == {'sub': '11111111-2222-4333-8444-555555555555', 'role': 'user', 'name': '워니팬'}


def test_local_env_file_fills_only_missing_and_skips_render(tmp_path):
    from app.rhythm.config import load_local_env_file
    f = tmp_path / '.env'
    f.write_text('# comment\nRHYTHM_LINK_SECRET="from-file"\nSUPABASE_URL=https://x.supabase.co\nlower=ignored\n', encoding='utf-8')
    env = {'SUPABASE_URL': 'https://already.set'}
    assert load_local_env_file(f, env) == ['RHYTHM_LINK_SECRET']
    assert env == {'SUPABASE_URL': 'https://already.set', 'RHYTHM_LINK_SECRET': 'from-file'}
    assert load_local_env_file(f, {'RENDER': 'true'}) == []
    assert load_local_env_file(tmp_path / 'missing.env', {}) == []


def test_check_command_reports_without_printing_secrets(monkeypatch, capsys):
    from app.rhythm import check
    for k, v in ENV.items():
        monkeypatch.setenv(k, v)
    monkeypatch.setattr(check, 'load_local_env_file', lambda: [])
    monkeypatch.setattr(check.RhythmDb, 'ranking', lambda self, *a: [])
    assert check.main() == 0
    out = capsys.readouterr().out
    assert 'OK  Supabase' in out and LINK not in out and DBS not in out and 'sb_publishable_test' not in out

    def boom(self, *a):
        raise DbError('misconfigured')
    monkeypatch.setattr(check.RhythmDb, 'ranking', boom)
    assert check.main() == 1
    assert 'RHYTHM_DB_SECRET' in capsys.readouterr().out


# ── 내 기록 (로그인 필수: 최고 기록 · 최근 플레이는 서버에서만) ───────────────────
def test_records_require_login_and_map_rows(client):
    assert client.get('/api/rhythm/records').status_code == 401
    assert FakeDb.calls == []
    login(client)
    res = client.get('/api/rhythm/records')
    assert res.status_code == 200, res.text
    body = res.json()
    assert FakeDb.calls[-1] == ('records', USER), '세션의 회원 것만'
    assert body['best'] == [{'songId': 'demo-beat', 'difficulty': 'hard', 'laneCount': 4, 'bestScore': 30000, 'bestGrade': 'S+',
                             'bestAccuracy': 100, 'bestMaxCombo': 30, 'clearCount': 2, 'bestScoreAt': '2026-10-14T00:00:00Z'}]
    assert body['recent'][0]['status'] == 'GAME_OVER' and body['recent'][0]['miss'] == 10 and body['recent'][0]['ranked'] is False
    assert 'user_id' not in res.text and USER not in res.text
    assert res.headers['cache-control'] == 'private, no-store'


def test_records_failure_is_reported(client):
    login(client)
    FakeDb.fail = 'unavailable'
    assert client.get('/api/rhythm/records').status_code == 502


def test_my_records_request_is_signed():
    seen = []

    def opener(req, timeout):
        seen.append(json.loads(req.data))
        return FakeResponse(b'{"best": [{"song_id": "demo-beat"}, "junk"], "recent": null}')

    out = RhythmDb(load_config(ENV), opener=opener).my_records(USER)
    assert out == {'best': [{'song_id': 'demo-beat'}], 'recent': []}
    payload = json.loads(seen[0]['p_payload'])
    assert payload['action'] == 'records' and payload['user_id'] == USER
    assert seen[0]['p_signature'] == sign(seen[0]['p_payload'], DBS)
