"""Server-side WONY validation record list: read-only, isolated from growth history."""
import json
import os
import time
from uuid import uuid4
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.validation.records import save_source_name


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv('WONY_DATA_DIR', str(tmp_path / 'results'))
    return TestClient(app)


def root(tmp_path):
    folder = tmp_path / 'results' / 'validation'
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def tools(score=None):
    return {name: {'score': score, 'status': 'insufficient_data' if score is None else 'estimated'}
            for name in ['contact', 'power', 'speed', 'fielding', 'arm']}


def store(tmp_path, *, role='pitcher', source='automatic', hint='auto', auto='pitcher', lost=None,
          created='2026-10-13T01:00:00+00:00', duration=20.045, status='input_validation_only', **extra):
    identifier = str(uuid4())
    folder = root(tmp_path) / identifier
    folder.mkdir()
    result = {'id': identifier, 'validation_only': True, 'synthetic_demo': False,
        'created_at': created, 'analysis_date': created[:10], 'role': role, 'status': status,
        'role_input': {'role_hint': hint, 'source': source},
        'automatic_role_estimate': {'value': auto},
        'target_tracking': {'status': 'reidentification_required' if lost is not None else 'tracking',
                            'lost_at': lost, 'selection': {'viewpoint': 'third_person'}},
        'validation_summary': {'metadata': {'duration_seconds': duration}, 'sampled_frames': 201,
                               'usable_general_pose_frames': 6, 'estimated_3d_frames': 6},
        'scouting_report': {'player_tools': tools()}, **extra}
    (folder / 'analysis.json').write_text(json.dumps(result), encoding='utf-8')
    return identifier


def test_empty_list(client):
    data = client.get('/api/validation/reports').json()
    assert data['items'] == [] and data['total'] == 0 and data['skipped'] == 0
    assert data['growth_history_included'] is False


def test_multiple_records_newest_first_with_roles(client, tmp_path):
    pitcher = store(tmp_path, created='2026-10-13T01:00:00+00:00')
    batter = store(tmp_path, role='batter', source='user_provided', hint='batter', auto='unknown',
                   status='insufficient_pose', duration=32.034, created='2026-10-13T02:00:00+00:00')
    data = client.get('/api/validation/reports').json()
    assert data['total'] == 2 and [i['id'] for i in data['items']] == [batter, pitcher]
    first, second = data['items']
    assert first['role'] == 'batter' and first['role_source'] == 'user_provided' and first['automatic_role'] == 'unknown'
    assert first['analysis_status'] == 'insufficient_pose' and first['duration_sec'] == 32.034
    assert second['role'] == 'pitcher' and second['role_source'] == 'automatic'
    assert second['player_tools_status'] == 'insufficient_data' and second['player_tools_scored'] == 0
    assert second['report_status'] == 'completed' and second['report_url'] == f'/demo/validation/report/{pitcher}'
    page = client.get('/api/validation/reports?offset=1&limit=1').json()
    assert [i['id'] for i in page['items']] == [pitcher] and page['total'] == 2


def test_tracking_lost_is_reported_not_hidden(client, tmp_path):
    identifier = store(tmp_path, role='unknown', auto='unknown', lost=1.1, status='insufficient_pose')
    item = client.get('/api/validation/reports').json()['items'][0]
    assert item['id'] == identifier and item['tracking_lost_at'] == 1.1
    assert item['tracking_status'] == 'reidentification_required' and item['reidentification_required'] is True


def test_old_record_without_newer_fields_is_listed(client, tmp_path):
    identifier = str(uuid4())
    folder = root(tmp_path) / identifier
    folder.mkdir()
    old = {'id': identifier, 'validation_only': True, 'synthetic_demo': False, 'created_at': '2026-10-01T00:00:00+00:00',
           'analysis_date': '2026-10-01', 'role': 'unknown', 'target_tracking': {'status': 'tracking', 'lost_at': None}}
    (folder / 'analysis.json').write_text(json.dumps(old), encoding='utf-8')
    item = client.get('/api/validation/reports').json()['items'][0]
    assert item['id'] == identifier and item['role_source'] is None and item['automatic_role'] is None
    assert item['duration_sec'] is None and item['player_tools_status'] == 'not_available' and item['source_name'] is None


def test_broken_and_incomplete_results_are_skipped(client, tmp_path):
    good = store(tmp_path)
    folder = root(tmp_path)
    broken = folder / str(uuid4()); broken.mkdir(); (broken / 'analysis.json').write_text('{not json', encoding='utf-8')
    mismatched = folder / str(uuid4()); mismatched.mkdir()
    (mismatched / 'analysis.json').write_text(json.dumps({'id': 'other', 'validation_only': True}), encoding='utf-8')
    not_validation = folder / str(uuid4()); not_validation.mkdir()
    (not_validation / 'analysis.json').write_text(json.dumps({'id': not_validation.name}), encoding='utf-8')
    running = folder / str(uuid4()); running.mkdir()  # no analysis.json yet
    (folder / 'not-a-uuid').mkdir(); (folder / f'{uuid4()}.upload').write_bytes(b'partial')
    data = client.get('/api/validation/reports').json()
    assert [i['id'] for i in data['items']] == [good] and data['skipped'] == 4
    assert client.get(f'/api/validation/reports/{broken.name}').status_code == 422
    assert client.get(f'/api/validation/reports/{running.name}').status_code == 404
    assert client.get('/api/validation/reports/not-a-uuid').status_code == 422


def test_single_summary_and_cache_refresh(client, tmp_path):
    identifier = store(tmp_path)
    assert client.get(f'/api/validation/reports/{identifier}').json()['source_name'] is None
    save_source_name(root(tmp_path) / identifier, r'C:\clips\wony-pitcher-001.mp4')
    assert client.get(f'/api/validation/reports/{identifier}').json()['source_name'] == 'wony-pitcher-001.mp4'
    path = root(tmp_path) / identifier / 'analysis.json'
    data = json.loads(path.read_text(encoding='utf-8')); data['role'] = 'batter'
    path.write_text(json.dumps(data), encoding='utf-8')
    later = time.time() + 5; os.utime(path, (later, later))
    assert client.get('/api/validation/reports').json()['items'][0]['role'] == 'batter'


def test_records_stay_out_of_reports_and_growth(client, tmp_path):
    store(tmp_path)
    assert client.get('/api/validation/reports').json()['total'] == 1
    assert client.get('/api/reports').json()['total'] == 0
    assert client.get('/api/players/wony/history').json()['count'] == 0
