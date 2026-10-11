from copy import deepcopy
from datetime import date
from uuid import uuid4
import json
import numpy as np
import pytest
from .test_roles import poses, client
from app.analysis.engine import analyze_role
from app.scouting.growth import compare_records, illustrative_demo_growth
from app.models.storage import save_result


@pytest.fixture
def mock_video(monkeypatch,poses):
    monkeypatch.setattr('app.api.routes.extract_frames',lambda _:[(i*.1,np.zeros((80,100,3),dtype=np.uint8)) for i in range(8)])
    monkeypatch.setattr('app.api.routes.extract_pose',lambda _:poses)


def upload(client,role='batter',**fields):
    # Explicit conditions required by the evidence-first growth comparison policy.
    capture={'camera_angle':'side','environment':'real','video_quality':'good','camera_motion':'fixed'}
    return client.post('/api/analyze',data={'role':role,'capture_context':json.dumps(capture),**fields},files={'video':('video.mp4',b'fixture')})


@pytest.mark.parametrize('role',['batter','defense','catcher','pitcher','baserunning'])
def test_roles_have_evidence_first_scouting_and_visual_links(client,mock_video,role):
    response=upload(client,role,player_id='PLAYER-1',analysis_date='2026-10-10')
    assert response.status_code==200,response.text
    result=response.json();report=result['scouting_report']
    assert result['schema_version']=='0.4.0' and result['player_id']=='PLAYER-1'
    assert report['analysis_date']=='2026-10-10' and report['synthetic_demo'] is False
    assert set(report['ratings'])=={'batting','defense','catching','pitching','baserunning'}
    assert all(value is None for value in report['ratings'].values())
    for evaluation in report['role_evaluations'].values():
        for assessment in evaluation['metrics'].values():
            assert assessment['score'] is None and assessment['grade'] is None
            assert assessment['estimated'] and assessment['reason']
    assert report['traits']
    for play in report['plays']:
        assert play['confidence']==play['event']['confidence']
        assert play['strengths']==[] and play['weaknesses']==[]
        assert play['context_feedback']['scope']=='whole_clip'
        assert play['visualization_reference']['analysis_id']==result['id']
        frame=play['visualization_reference']['frame']
        assert result['visualization']['pose3d']['frames'][frame]['timestamp']==pytest.approx(play['timestamp'])
        if play['keyframe']:
            assert client.get(play['keyframe']['image_url']).status_code==200
    assert client.get('/api/analysis/'+result['id']).json()==result


def test_baserunning_insufficient_and_no_fabricated_speed(poses):
    result=analyze_role(poses,'baserunning')
    assert result['status']=='completed' and result['summary']['running_posture']['value'] is not None
    for key in ['start_reaction','acceleration','direction_change','base_approach','sliding','decision_making']:
        assert result['metrics'][key]['value'] is None and result['metrics'][key]['confidence']==0
    assert analyze_role([],'baserunning')['status']=='insufficient_pose'


def test_invalid_player_date_and_context(client):
    for fields in [{'player_id':'../escape'},{'analysis_date':'not-a-date'},{'comparison_context':'x'*81}]:
        assert upload(client,**fields).status_code==422
    assert client.get('/api/players/invalid%20player/history').status_code==422
    assert client.get('/api/players/PLAYER/history?source=all').status_code==422


def test_insufficient_report_withheld(client,monkeypatch):
    monkeypatch.setattr('app.api.routes.extract_frames',lambda _:[])
    monkeypatch.setattr('app.api.routes.extract_pose',lambda _:[])
    r=upload(client).json()
    assert r['status']=='insufficient_pose'
    assert r['scouting_report']['traits']==[] and r['scouting_report']['plays']==[]
    assert r['scouting_report']['strengths']==[]


def record(value,day,source=False,role='batter',context='same-side-camera'):
    return {'id':str(uuid4()),'player_id':'PLAYER','role':role,'analysis_date':f'2026-10-{day:02d}',
        'capture_context':{'camera_angle':'side','environment':'real','video_quality':'good','camera_motion':'fixed'},
        'scouting_report':{'observation_window':{'duration_seconds':.7,'sample_count':8,'max_gap_seconds':.1}},
        'created_at':f'2026-10-{day:02d}T00:00:00+00:00','status':'completed',
        'synthetic_demo':source,'comparison_context':context,'observation_method_version':'pose-proxies-v1',
        'throwing_hand':'right','position_type':None,
        'metrics':{'balance':{'value':value,'unit':'torso_lengths','method':'same-method','confidence':.6}},
        'ratings':{'batting':None}}


def test_growth_sorted_deltas_and_no_improvement_claim():
    points=compare_records([record(.1,3),record(.3,1),record(.2,2)])
    assert [p['observations']['balance']['delta'] for p in points]==[None,-.1,-.1]
    assert all(p['rating_deltas']['batting'] is None for p in points)
    assert 'not demonstrated skill improvement' in points[-1]['observations']['balance']['interpretation']


@pytest.mark.parametrize('change',[{'comparison_context':None},{'comparison_context':'other-camera'},
    {'observation_method_version':'v2'},{'throwing_hand':'left'},{'status':'insufficient_pose'}])
def test_growth_rejects_incompatible_context(change):
    first=record(.3,1);second=record(.2,2);second.update(change)
    observation=compare_records([first,second])[-1]['observations']['balance']
    assert observation['delta'] is None and not observation['comparable'] and observation['reason']


def test_growth_never_crosses_roles_or_demo_source():
    points=compare_records([record(.3,1),record(.2,2,True),record(.1,3,role='pitcher')])
    assert all(p['previous_analysis_id'] is None for p in points)


def test_growth_rejects_low_confidence_units_and_boolean():
    for key,value in [('confidence',.2),('unit','meters'),('value',True),('value',None)]:
        first=record(.3,1);second=record(.2,2);second['metrics']['balance'][key]=value
        assert compare_records([first,second])[-1]['observations']['balance']['delta'] is None


def test_player_history_and_aggregate_separate_real_demo(client,mock_video):
    real=upload(client,player_id='SAME-PLAYER',analysis_date='2026-10-10',comparison_context='side-A').json()
    demo=client.post('/api/demo/defense',data={'player_id':'SAME-PLAYER','analysis_date':'2026-10-11'}).json()
    assert demo['synthetic_demo'] and 'DEMO' in demo['scouting_report']['overall_summary']
    actual=client.get('/api/players/SAME-PLAYER/history').json()
    synthetic=client.get('/api/players/SAME-PLAYER/history?source=demo').json()
    assert actual['count']==1 and actual['points'][0]['analysis_id']==real['id']
    assert synthetic['count']==1 and synthetic['points'][0]['analysis_id']==demo['id']
    aggregate=client.get('/api/players/SAME-PLAYER/scouting-report').json()
    assert aggregate['roles']['batting']['analysis_id']==real['id']
    assert aggregate['roles']['defense'] is None
    assert all(value is None for value in aggregate['ratings'].values())
    assert client.get('/api/players/NO-PLAYER/history').json()['count']==0


def test_history_multiple_roles_and_existing_records_preserved(client,mock_video):
    first=upload(client,player_id='MULTI',analysis_date='2026-10-09',comparison_context='side-A').json()
    second=upload(client,player_id='MULTI',analysis_date='2026-10-10',comparison_context='side-A').json()
    defense=upload(client,'defense',player_id='MULTI',analysis_date='2026-10-11').json()
    history=client.get('/api/players/MULTI/history').json()
    assert history['count']==3
    assert history['points'][1]['observations']['balance']['delta']==0
    aggregate=client.get('/api/players/MULTI/scouting-report').json()
    assert aggregate['roles']['batting']['analysis_id']==second['id']
    assert aggregate['roles']['defense']['analysis_id']==defense['id']
    assert client.get('/api/analysis/'+first['id']).json()==first


def test_demo_growth_is_illustrative_not_actual_ratings(client):
    result=client.get('/api/demo/growth').json()
    assert result['synthetic_demo'] is True
    assert [p['delta'] for p in result['points']]==[None,9,6]
    assert all(p['confidence']==0 and p['synthetic_demo'] for p in result['points'])
