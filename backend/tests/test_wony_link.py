"""WONY PHONE admin-only entry: ticket -> session cookie; direct URLs are refused."""
import base64
import hashlib
import hmac
import json
import time
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.auth import wony_link

SECRET = 'test-secret-0123456789abcdef-0123456789'
# Signed by WONY PHONE server/baseballLink.ts signTicket() (tests/baseballLink.test.ts uses the same values)
PHONE_VECTOR = ('v1.eyJzdWIiOiJ1MSIsInJvbGUiOiJhZG1pbiIsImV4cCI6MjAwMDAwMDAwMCwibm9uY2UiOiJuMSJ9.'
                'bGKsGu7ojcLm7uqN7-tm6UgFaFK7QQuXuq3WzIt64YY')


def ticket(secret=SECRET, **payload):
    data = {'sub': 'admin-id', 'role': 'admin', 'exp': int(time.time()) + 60, 'nonce': base64.b16encode(time.time_ns().to_bytes(8, 'big')).decode(), **payload}
    body = 'v1.' + base64.urlsafe_b64encode(json.dumps(data).encode()).rstrip(b'=').decode()
    sig = base64.urlsafe_b64encode(hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest()).rstrip(b'=').decode()
    return f'{body}.{sig}'


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv('WONY_AUTH_SECRET', SECRET)
    wony_link._used.clear()
    return TestClient(app, follow_redirects=False)


def test_phone_signed_vector_verifies_in_python():
    assert wony_link.verify_ticket(PHONE_VECTOR, SECRET, now=1999999990) == 'u1'


def test_without_secret_service_is_unchanged(tmp_path, monkeypatch):
    monkeypatch.delenv('WONY_AUTH_SECRET', raising=False)
    plain = TestClient(app)
    assert plain.get('/').status_code == 200 and plain.get('/game').status_code == 200


@pytest.mark.parametrize('path', ['/', '/game', '/songs', '/settings', '/scores', '/js/game.js',
                                  '/songs/songs.json', '/demo/'])
def test_direct_url_without_session_is_refused(client, path):
    response = client.get(path)
    assert response.status_code == 401
    assert '접근 권한이 없습니다' in response.text


def test_api_style_request_gets_json_refusal(client):
    response = client.get('/songs/songs.json', headers={'accept': 'application/json'})
    assert response.status_code == 401 and '[auth_required]' in response.text


def test_health_stays_open(client):
    assert client.get('/health').status_code == 200


def test_admin_ticket_starts_session(client):
    response = client.get('/wony-login', params={'ticket': ticket()})
    assert response.status_code == 303 and response.headers['location'] == '/'
    cookie = response.headers['set-cookie']
    assert 'HttpOnly' in cookie and 'SameSite=lax' in cookie and 'Max-Age=14400' in cookie
    assert client.get('/').status_code == 200
    assert client.get('/songs/songs.json').status_code == 200


@pytest.mark.parametrize('bad', [
    lambda: ticket(role='manager'),
    lambda: ticket(role='user'),
    lambda: ticket(exp=int(time.time()) - 1),
    lambda: ticket(exp=int(time.time()) + 3600),          # longer than a short-lived ticket
    lambda: ticket(secret='another-secret-0123456789abcdef-012'),
    lambda: ticket()[:-2] + 'xx',                          # tampered signature
    lambda: 'v1.not.valid',
    lambda: '',
])
def test_bad_tickets_are_refused(client, bad):
    response = client.get('/wony-login', params={'ticket': bad()})
    assert response.status_code == 401 and 'set-cookie' not in response.headers
    assert client.get('/').status_code == 401


def test_ticket_is_one_time(client):
    once = ticket()
    assert client.get('/wony-login', params={'ticket': once}).status_code == 303
    other = TestClient(app, follow_redirects=False)
    assert other.get('/wony-login', params={'ticket': once}).status_code == 401


def test_forged_or_expired_session_cookie_is_refused(client):
    stale = wony_link.make_session('admin-id', SECRET, now=time.time() - wony_link.SESSION_SECONDS - 10)
    client.cookies.set(wony_link.COOKIE, stale)
    assert client.get('/').status_code == 401
    client.cookies.set(wony_link.COOKIE, wony_link.make_session('admin-id', 'wrong-secret-0123456789abcdef-01234'))
    assert client.get('/').status_code == 401


def test_short_secret_fails_closed(tmp_path, monkeypatch):
    monkeypatch.setenv('WONY_AUTH_SECRET', 'too-short')
    closed = TestClient(app)
    assert closed.get('/').status_code == 503 and closed.get('/wony-login').status_code == 503
