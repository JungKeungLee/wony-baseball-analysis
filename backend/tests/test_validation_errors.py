"""Server failures during /api/validation must still answer JSON with a coded detail (never an empty or plain body)."""
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.api import validation as validation_api
from .test_target_validation import clip, selection


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv('WONY_DATA_DIR', str(tmp_path / 'results'))
    return TestClient(app, raise_server_exceptions=False)


@pytest.mark.parametrize('error,status,code', [
    (FileNotFoundError(2, 'No such file or directory', 'ffmpeg'), 503, 'server_dependency_missing'),
    (MemoryError(), 503, 'server_out_of_memory'),
    (RuntimeError('boom'), 500, 'internal_error'),
])
def test_runner_failures_answer_coded_json(client, clip, monkeypatch, error, status, code):
    def fail(*args, **kwargs):
        raise error
    monkeypatch.setattr(validation_api, 'validate_clip', fail)
    with clip.open('rb') as video:
        response = client.post('/api/validation', data={'selection': selection().model_dump_json()},
                               files={'video': ('clip.mp4', video, 'video/mp4')})
    assert response.status_code == status
    assert response.headers['content-type'].startswith('application/json')
    assert response.json()['detail'].startswith(f'[{code}]')
    # 실패 후 잠금이 풀려 다음 분석을 받을 수 있어야 한다
    from app.api.routes import processing_lock
    assert processing_lock.acquire(blocking=False)
    processing_lock.release()


def test_other_api_errors_answer_json(client, monkeypatch):
    from app.api import validation
    monkeypatch.setattr(validation, 'list_reports', lambda *a, **k: (_ for _ in ()).throw(RuntimeError('db down')))
    response = client.get('/api/validation/reports')
    assert response.status_code == 500 and response.json()['detail'].startswith('[internal_error] RuntimeError')
