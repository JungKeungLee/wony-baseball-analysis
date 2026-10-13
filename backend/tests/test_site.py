import json
import pytest
from fastapi.testclient import TestClient
from app.main import app, SITE

DIFFICULTIES = ['easy', 'normal', 'hard', 'hell']


@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv('WONY_AUTH_SECRET', raising=False)
    return TestClient(app, follow_redirects=False)


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
def test_pages(client, path, marker):
    response = client.get(path)
    assert response.status_code == 200 and marker in response.text and 'WONY RHYTHM' in response.text


@pytest.mark.parametrize('path', ['/css/app.css', '/js/game.js', '/js/clock.js', '/songs/songs.json'])
def test_static_assets(client, path):
    assert client.get(path).status_code == 200


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
