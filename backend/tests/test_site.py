import json
import time
import uuid

import pytest
from fastapi.testclient import TestClient
from app.main import app, SITE
from app.rhythm.auth import COOKIE, make_session

DIFFICULTIES = ['easy', 'normal', 'hard', 'hell']


LINK = 'site-link-' + 'a' * 40
USER = str(uuid.uuid4())


@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv('WONY_AUTH_SECRET', raising=False)
    return TestClient(app, follow_redirects=False)


@pytest.fixture
def login_env(client, monkeypatch):
    monkeypatch.setenv('RHYTHM_LINK_SECRET', LINK)
    monkeypatch.setenv('WONY_PHONE_URL', 'https://phone.example/phone')
    return client


@pytest.fixture
def member(login_env):
    """WONY PHONE 입장권으로 받은 것과 같은 세션 쿠키를 가진 회원"""
    login_env.cookies.set(COOKIE, make_session({'sub': USER, 'name': '워니팬'}, LINK, 3600))
    return login_env


def catalog():
    return json.loads((SITE / 'songs' / 'songs.json').read_text(encoding='utf-8'))['songs']


def test_health(client):
    response = client.get('/health')
    assert response.status_code == 200 and response.json() == {'status': 'ok'}


@pytest.mark.parametrize('path, marker', [
    ('/', 'data-page="home"'), ('/game', 'data-page="game"'), ('/game/', 'data-page="game"'),
    ('/songs', 'data-page="songs"'), ('/settings', 'data-page="settings"'), ('/scores', 'data-page="scores"'),
    ('/ranking', 'data-page="ranking"'), ('/shop', 'data-page="shop"'),
])
def test_pages(member, path, marker):
    response = member.get(path)
    assert response.status_code == 200 and marker in response.text and 'WONY RHYTHM' in response.text
    assert response.headers['cache-control'] == 'no-store'


@pytest.mark.parametrize('path', ['/', '/game', '/game/', '/game?song=demo-beat&diff=easy', '/songs', '/settings', '/scores',
                                  '/ranking', '/shop'])
def test_pages_require_rhythm_session(login_env, path):
    """로그인 필수: 세션이 없으면 게임 화면 대신 로그인 안내 (WONY PHONE 이동 버튼)"""
    response = login_env.get(path)
    assert response.status_code == 200
    assert 'data-page="login"' in response.text and '로그인이 필요한 서비스입니다.' in response.text
    assert 'href="https://phone.example/phone"' in response.text
    assert 'id="field"' not in response.text and '/js/game.js' not in response.text, '게임 화면 HTML 은 보내지 않음'
    assert response.headers['cache-control'] == 'no-store'


def test_forged_or_expired_session_gets_login_page(login_env):
    login_env.cookies.set(COOKIE, make_session({'sub': USER, 'name': 'x'}, 'other-secret-' + 'z' * 40, 3600))
    assert 'data-page="login"' in login_env.get('/game').text
    login_env.cookies.set(COOKIE, make_session({'sub': USER, 'name': 'x'}, LINK, 3600, now=time.time() - 7200))
    assert 'data-page="login"' in login_env.get('/game').text


def test_login_page_without_phone_url_or_login_config(client, monkeypatch):
    """로그인 설정이 없으면 아무도 게임을 열 수 없음 (우회 없음), WONY PHONE 주소가 없으면 버튼 대신 안내"""
    for k in ('RHYTHM_LINK_SECRET', 'WONY_PHONE_URL'):
        monkeypatch.delenv(k, raising=False)
    response = client.get('/game')
    assert 'data-page="login"' in response.text and 'href=""' in response.text
    monkeypatch.setenv('WONY_PHONE_URL', 'javascript:alert(1)')
    assert 'javascript:' not in client.get('/').text


@pytest.mark.parametrize('path', ['/css/app.css', '/js/game.js', '/js/clock.js', '/songs/songs.json'])
def test_static_assets(client, path):
    res = client.get(path)
    assert res.status_code == 200
    # 배포 직후 휴대폰이 이전 CSS/JS 를 쓰지 않도록 매번 확인 (바뀌지 않았으면 304)
    assert res.headers['cache-control'] == 'no-cache'
    again = client.get(path, headers={'If-None-Match': res.headers['etag']})
    assert again.status_code == 304


def test_media_is_cached(client):
    res = client.get('/assets/covers/demo-beat.webp')
    assert res.status_code == 200 and res.headers['cache-control'] == 'public, max-age=86400'


@pytest.mark.parametrize('path', ['/package.json', '/tests/browser.mjs', '/node_modules/playwright/package.json',
                                  '/analysis.html', '/report.js', '/index.html', '/../backend/app/main.py',
                                  '/staging/x/song.json', '/api/import'])
def test_non_public_files_are_not_served(client, path):
    assert client.get(path).status_code == 404


def test_game_server_has_no_import_api(client):
    assert client.post('/api/import').status_code in (404, 405)


@pytest.mark.parametrize('path', ['/demo', '/demo/', '/demo/validation/', '/demo/analysis/123'])
def test_legacy_demo_urls_redirect_home(client, path):
    response = client.get(path)
    assert response.status_code == 301 and response.headers['location'] == '/'


def test_song_catalog_files_exist_and_are_valid():
    for song in catalog():
        assert song['id'] and song['title'] and song['artist']
        assert set(song['difficulties']) <= set(DIFFICULTIES)
        if song.get('video'):
            assert (SITE / song['video'].lstrip('/')).is_file()
        if song.get('cover'):
            assert (SITE / song['cover'].lstrip('/')).is_file()
        for difficulty in song['difficulties']:
            chart = json.loads((SITE / 'songs' / 'charts' / f"{song['id']}-{difficulty}.json").read_text(encoding='utf-8'))
            assert chart['songId'] == song['id'] and chart['difficulty'] == difficulty
            times = [n['time'] for n in chart['notes']]
            lane_count = chart.get('laneCount', 4)  # 없으면 4키 (이전 채보)
            assert lane_count in (4, 6, 8)
            assert times == sorted(times) and all(0 <= n['lane'] < lane_count for n in chart['notes'])
            assert 0 <= times[0] and times[-1] <= song['durationMs']


def test_video_supports_range_requests(client):
    """iOS Safari 는 Range 요청(206)이 되어야 영상을 재생한다. 서버는 파일을 조각으로만 보낸다(메모리 부담 없음)."""
    songs = [s for s in catalog() if s.get('video')]
    if not songs:
        pytest.skip('등록된 영상 없음')
    response = client.get(songs[0]['video'], headers={'Range': 'bytes=0-1023'})
    assert response.status_code == 206
    assert len(response.content) == 1024
    assert response.headers['content-type'] == 'video/mp4'
