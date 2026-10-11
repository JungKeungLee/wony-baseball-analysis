import subprocess
import numpy as np
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.analysis.pitcher.analyzer import angle, analyze, METRICS


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv('WONY_DATA_DIR', str(tmp_path / 'results'))
    return TestClient(app)


def test_angles_and_missing_pose():
    assert angle(np.array([1, 0]), np.array([0, 0]), np.array([0, 1])) == pytest.approx(90)
    assert angle(np.zeros(2), np.zeros(2), np.ones(2)) is None
    result = analyze([])
    assert set(result['metrics']) == set(METRICS)
    assert result['ball_speed'] is None
    assert all(m['value'] is None and m['confidence'] == 0 for m in result['metrics'].values())


def test_synthetic_pose():
    samples = []
    for t in range(5):
        points = [dict(x=.5, y=.5, z=0, visibility=.9) for _ in range(33)]
        for i, x, y in [(11,.4,.3),(12,.6,.3),(23,.4,.6),(24,.6,.6),
                        (14,.65,.2),(16,.7+t*.02,.1),(25,.4,.75),(27,.3,.9),(28,.7,.9)]:
            points[i].update(x=x, y=y)
        samples.append(dict(time_seconds=t*.1, aspect_ratio=1, landmarks=points))
    result = analyze(samples)
    assert result['usable_pose_frames'] == 5
    assert result['metrics']['elbow_angle']['value'] is not None
    assert all(m['estimated'] for m in result['metrics'].values())
    assert result['ball_speed'] is None


def test_invalid_upload_and_lookup(client):
    assert client.post('/api/analyze', files={'video': ('empty.mp4', b'')}).status_code == 422
    assert client.post('/api/analyze', files={'video': ('bad.mp4', b'not video')}).status_code == 422
    assert client.get('/api/analysis/00000000-0000-0000-0000-000000000000').status_code == 404
    assert client.get('/api/analysis/invalid').status_code == 422


def test_real_decode_pose_and_persistence(client, tmp_path):
    path = tmp_path / 'blank.mp4'
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i',
                    'color=c=black:s=320x240:r=10:d=0.5','-c:v','mpeg4',str(path)], check=True)
    response = client.post('/api/analyze', files={'video': ('blank.mp4', path.read_bytes(), 'video/mp4')})
    assert response.status_code == 200
    result = response.json()
    assert result['sampled_frames'] == 5
    assert result['status'] == 'insufficient_pose'
    assert result['detected_pose_frames'] == 0
    assert client.get('/api/analysis/'+result['id']).json() == result
    assert not list((tmp_path/'results').glob('*.upload'))


def test_upload_size_limit(client, monkeypatch):
    monkeypatch.setattr('app.api.routes.MAX_BYTES', 4)
    assert client.post('/api/analyze', files={'video': ('big.mp4', b'12345')}).status_code == 413


def test_busy_and_hand_validation(client):
    from app.api.routes import processing_lock
    processing_lock.acquire()
    try:
        assert client.post('/api/analyze', files={'video': ('x.mp4', b'x')}).status_code == 503
    finally:
        processing_lock.release()
    assert client.post('/api/analyze', data={'throwing_hand': 'unknown'},
                       files={'video': ('x.mp4', b'x')}).status_code == 422


def test_duration_limit(tmp_path):
    from app.video.frames import extract_frames, InvalidVideo
    path = tmp_path / 'long.mp4'
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i',
                    'color=c=black:s=64x64:r=10:d=2','-c:v','mpeg4',str(path)], check=True)
    with pytest.raises(InvalidVideo, match='at most'):
        extract_frames(path, max_duration=1)
    assert not path.with_suffix('.normalized.mp4').exists()
