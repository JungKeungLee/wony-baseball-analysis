import copy
import json
import numpy as np
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.analysis.engine import analyze_role
from app.analysis.shared.pose_metrics import pose_rows
from app.models.result import AnalysisResult


@pytest.fixture
def poses():
    result=[]
    for n in range(8):
        p=[dict(x=.5,y=.5,z=0,visibility=.9) for _ in range(33)]
        for i,x,y in [(0,.5,.1),(11,.4,.3),(12,.6,.3),(13,.35,.4),(14,.65,.4),
                      (15,.3+n*.025,.5-n*.015),(16,.7+n*.025,.5-n*.015),
                      (23,.4+n*.02,.6),(24,.6+n*.02,.6),(25,.35,.75),(26,.65,.75),
                      (27,.3,.9),(28,.7,.9)]:
            p[i].update(x=x,y=y)
        result.append(dict(time_seconds=n*.1,aspect_ratio=1,landmarks=p))
    return result


@pytest.fixture
def client(tmp_path,monkeypatch):
    monkeypatch.setenv('WONY_DATA_DIR',str(tmp_path/'results'))
    return TestClient(app)


def assert_metric(m):
    assert m['estimated'] is True
    assert 0 <= m['confidence'] <= 1
    assert m['confidence_grade'] in ['high','medium','low']
    if m['value'] is None:
        assert m['confidence']==0 and m['reason']


@pytest.mark.parametrize('role',['batter','defense','catcher','pitcher'])
def test_normal_role_and_confidence(poses,role):
    r=analyze_role(poses,role)
    assert r['role']==role and r['status']=='completed'
    assert r['usable_pose_frames']==8
    for m in list(r['metrics'].values())+list(r['summary'].values()):
        assert_metric(m)
    for e in r['events']:
        assert e['role']==role and e['candidate'] and e['estimated']
        assert 0<=e['timestamp']<=.7+1e-6
        assert_metric(next(iter(e['metrics'].values())))
    assert r['events']
    json.dumps(r,allow_nan=False)


@pytest.mark.parametrize('role',['batter','defense','catcher','pitcher'])
def test_insufficient_pose(role):
    r=analyze_role([],role)
    assert r['status']=='insufficient_pose'
    assert not r['events']
    assert all(m['value'] is None for m in r['metrics'].values())
    assert not r['strengths'] and not r['weaknesses'] and not r['coaching']


def test_batter_swing_schema_and_unobservable(poses):
    r=analyze_role(poses,'batter')
    assert r['summary']['swing_type']['value']=='uppercut'
    assert r['metrics']['knee_flexion']['value']>=0
    assert r['metrics']['stance_width']['value']==pytest.approx(4/3)
    assert r['events'][0]['type']=='swing'
    for k in ['impact_time','contact','whiff','wrist_angle','stance_type','bat_start_position','foul_or_in_play']:
        assert r['metrics'][k]['value'] is None
        assert r['metrics'][k]['reason']


def test_catcher_sections(poses):
    r=analyze_role(poses,'catcher')
    for group in ['receiving','blocking','throwing_transition']:
        assert r[group]
        for m in r[group].values():
            assert_metric(m)
    assert r['receiving']['receive_success']['value'] is None
    assert r['blocking']['blocking_success']['value'] is None
    assert r['events'][0]['type']=='receive'


@pytest.mark.parametrize('position',['infielder','outfielder'])
def test_defense_position_hint(poses,position):
    r=analyze_role(poses,'defense',position_type=position)
    assert r['position_type']==position and r['position_source']=='manual'
    assert r['fielding'] and r['tracking'] and r['catching'] and r['throwing_transition']
    assert r['events'][0]['type']=='fielding'
    assert r['metrics']['first_step_direction']['value']=='image_right'
    assert r['metrics']['reaction_time']['value'] is None


def test_auto_does_not_invent_role_or_position(poses):
    r=analyze_role(poses,'auto')
    assert r['role']=='unknown' and r['status']=='unknown_role' and not r['events']
    assert {c['value'] for c in r['role_candidates']}=={'batter','defense','catcher','pitcher','baserunning'}
    assert all(c['confidence']==0 for c in r['role_candidates'])
    r=analyze_role(poses,'defense')
    assert r['position_type']=='unknown'
    assert len(r['position_candidates'])==2


@pytest.mark.parametrize('role',['batter','defense','catcher','pitcher'])
def test_static_pose_has_no_action_event(poses,role):
    samples=[dict(copy.deepcopy(poses[0]),time_seconds=n*.1) for n in range(8)]
    r=analyze_role(samples,role)
    assert r['events']==[]
    if role=='batter':
        assert r['metrics']['swing_type']['value'] is None
    if role=='pitcher':
        assert r['metrics']['release_time']['value'] is None


def test_shared_rejects_malformed_low_visibility_and_duplicate_time(poses):
    assert pose_rows([{}])==[]
    low=copy.deepcopy(poses)
    for s in low:
        s['landmarks'][0]['visibility']=.1
    assert pose_rows(low)==[]
    bad=copy.deepcopy(poses[0]);bad['landmarks'][0]['x']=float('nan')
    assert pose_rows([bad])==[]
    assert len(pose_rows([poses[0],poses[0]]))==1


@pytest.mark.parametrize('role',['batter','defense','catcher','pitcher','auto'])
def test_api_dispatch_persistence_and_schema(client,monkeypatch,poses,role):
    monkeypatch.setattr('app.api.routes.extract_frames',lambda _: [(0,np.zeros((10,10,3),dtype=np.uint8))])
    monkeypatch.setattr('app.api.routes.extract_pose',lambda _: poses)
    response=client.post('/api/analyze',data={'role':role,'position_type':'infielder'},
                         files={'video':('sample.mp4',b'fake video')})
    assert response.status_code==200,response.text
    r=response.json()
    AnalysisResult.model_validate(r)
    assert r['requested_role']==role
    assert client.get('/api/analysis/'+r['id']).json()==r


def test_invalid_role_and_failure_cleanup(client,monkeypatch,tmp_path):
    assert client.post('/api/analyze',data={'role':'coach'},files={'video':('x',b'x')}).status_code==422
    assert client.post('/api/analyze',data={'position_type':'shortstop'},files={'video':('x',b'x')}).status_code==422
    def fail(_):
        raise RuntimeError('private internal detail')
    monkeypatch.setattr('app.api.routes.extract_frames',fail)
    response=client.post('/api/analyze',data={'role':'batter'},files={'video':('x',b'x')})
    assert response.status_code==500 and response.json()['detail']['code']=='analysis_failed'
    assert 'private internal detail' not in response.text
    assert not list((tmp_path/'results').iterdir())
    from app.api.routes import processing_lock
    assert not processing_lock.locked()


@pytest.mark.parametrize('role',['batter','defense','catcher','pitcher','auto'])
def test_api_insufficient_pose(client,monkeypatch,role):
    monkeypatch.setattr('app.api.routes.extract_frames',lambda _: [])
    monkeypatch.setattr('app.api.routes.extract_pose',lambda _: [])
    response=client.post('/api/analyze',data={'role':role},files={'video':('x',b'x')})
    assert response.status_code==200
    assert response.json()['status']=='insufficient_pose'
    assert response.json()['events']==[]


@pytest.mark.parametrize('role',['batter','defense','catcher','pitcher'])
def test_left_handed_analysis(poses,role):
    r=analyze_role(poses,role,hand='left')
    assert r['status']=='completed'
    assert all(m['estimated'] for m in r['metrics'].values())


def test_save_failure_removes_temporary_file(tmp_path,monkeypatch):
    from pathlib import Path
    from app.models.storage import save_result
    monkeypatch.setenv('WONY_DATA_DIR',str(tmp_path))
    def fail(*args):
        raise OSError('simulated replacement failure')
    monkeypatch.setattr(Path,'replace',fail)
    with pytest.raises(OSError):
        save_result({'id':'test','value':1})
    assert list(tmp_path.iterdir())==[]


def test_vertical_motion_is_not_reported_as_left(poses):
    samples = copy.deepcopy(poses)
    for n, sample in enumerate(samples):
        for i, x in [(23, .4), (24, .6)]:
            sample['landmarks'][i].update(x=x, y=.6+n*.01)
    result = analyze_role(samples, 'defense')
    assert result['metrics']['first_step_direction']['value'] == 'image_down'
