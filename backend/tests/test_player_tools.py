"""Formula, provenance, unsupported evidence and capture compatibility regressions."""
from copy import deepcopy
import json
import math
from uuid import uuid4
import numpy as np
import pytest
from .test_roles import poses, client
from .test_scouting import mock_video, upload, record
from app.analysis.engine import analyze_role
from app.scouting.proxies import calculate
from app.scouting.tools import build_tools, aggregate_tools, repeated_hand_path
from app.scouting.growth import compare_records
from app.models.result import ToolAssessment

CAPTURE={'camera_angle':'side','environment':'vr','vr_environment':'WONY-test',
         'video_quality':'good','camera_motion':'fixed','projection':'flat'}


def result(poses,role='batter',day=1):
    r={'id':str(uuid4()),'pose':deepcopy(poses),'throwing_hand':'right',
       'player_id':'PLAYER','comparison_context':'practice-A','capture_context':deepcopy(CAPTURE),
       'analysis_date':f'2026-10-{day:02d}','created_at':f'2026-10-{day:02d}T00:00:00Z',
       'observation_method_version':'pose-proxies-v1','synthetic_demo':False,
       **analyze_role(poses,role)}
    r['scouting_report']=build_tools(r,[])
    return r


def observe(tool,key):
    return next(m for m in tool['observations'] if m['metric']==key)


def test_contact_distinguishes_movement_from_actual_contact(poses):
    r=result(poses);tool=r['scouting_report']['player_tools']['contact']
    assert tool['status']=='estimated' and tool['score'] is None and tool['grade'] is None
    assert observe(tool,'head_stability_score')['value'] is not None
    assert observe(tool,'contact')['status']=='not_supported'
    assert observe(tool,'contact')['value'] is None
    assert observe(tool,'hand_path_consistency_proxy')['status']=='insufficient_data'
    assert '실제 컨택' in tool['summary']


def test_power_formulas_body_relative_speed_and_separation(poses):
    samples=[]
    for i in range(8):
        p=deepcopy(poses[0]);p['time_seconds']=i*.1
        for wrist in [15,16]:p['landmarks'][wrist]['x']+=i*.006
        p['landmarks'][11]['y']=.27;p['landmarks'][12]['y']=.33
        samples.append(p)
    proxy=calculate(result(samples))
    assert proxy['hand_speed_proxy']['value']==pytest.approx(.2)
    assert proxy['hand_acceleration_proxy']['value']==pytest.approx(0,abs=1e-12)
    assert proxy['hip_shoulder_separation_proxy']['value']==pytest.approx(math.degrees(math.atan2(.06,.2)))
    assert proxy['hand_speed_proxy']['unit']=='torso_lengths_per_second'
    assert proxy['hip_shoulder_separation_proxy']['confidence']==.2


def test_motion_derivatives_reject_pose_gaps(poses):
    poses[4]['time_seconds']=1
    for i in range(5,8):poses[i]['time_seconds']=1+(i-4)*.1
    proxy=calculate(result(poses))
    assert 'hand_speed_proxy' not in proxy and 'hand_acceleration_proxy' not in proxy
    assert 'balance_variability_proxy' in proxy


def test_speed_only_for_running_role_and_requires_cycles(poses):
    batter=result(poses);running=result(poses,'baserunning')
    assert batter['scouting_report']['player_tools']['speed']['status']=='insufficient_data'
    speed=running['scouting_report']['player_tools']['speed']
    assert observe(speed,'running_speed_proxy')['status']=='estimated'
    assert observe(speed,'cadence_proxy')['status']=='insufficient_data'
    assert observe(speed,'actual_running_speed')['value'] is None
    assert observe(speed,'sixty_yard_time')['value'] is None


def test_ankle_cycles_compute_cadence_without_claiming_contacts(poses):
    samples=[]
    for i in range(50):
        p=deepcopy(poses[0]);p['time_seconds']=i*.1
        signal=.06*math.sin(2*math.pi*(i*.1))
        p['landmarks'][27]['y']+=signal;p['landmarks'][28]['y']-=signal
        for joint in [23,24]:p['landmarks'][joint]['x']+=i*.002
        samples.append(p)
    proxy=calculate(result(samples,'baserunning'))
    assert proxy['stride_frequency_proxy']['value']==pytest.approx(1)
    assert proxy['cadence_proxy']['value']==pytest.approx(120)
    assert 'unverified' in proxy['cadence_proxy']['method']


def test_fielding_summary_context_and_range_formula(poses):
    r=result(poses,'defense');tool=r['scouting_report']['player_tools']['fielding']
    assert tool['status']=='estimated' and tool['evidence'][0]['role']=='defense'
    assert observe(tool,'range_proxy')['value']>0
    assert observe(tool,'first_step_direction')['value']=='image_right'
    assert '포구 성공' in tool['summary']
    assert r['scouting_report']['role_summary']['position_type']=='unknown'
    assert r['scouting_report']['role_summary']['assessments']['reaction']['status']=='not_supported'


@pytest.mark.parametrize('role',['pitcher','catcher','defense'])
def test_arm_never_creates_actual_velocity(poses,role):
    r=result(poses,role);arm=r['scouting_report']['player_tools']['arm']
    assert observe(arm,'actual_throw_velocity')['value'] is None
    assert observe(arm,'actual_throw_velocity')['status']=='not_supported'
    assert observe(arm,'arm_speed_proxy')['unit']=='torso_lengths_per_second'
    assert arm['score'] is None
    assert r['scouting_report']['best_tool'] is None and r['scouting_report']['play_style'] is None


@pytest.mark.parametrize('role',['batter','defense','catcher','pitcher','baserunning'])
def test_role_summaries_and_tool_contract(poses,role):
    report=result(poses,role)['scouting_report']
    assert report['role_summary']['role']==role and report['role_summary']['summary']
    assert report['role_summary']['assessments']
    assert set(report['additional_evaluations'])=={'reaction','balance','footwork','baserunning','catching','timing','swing_consistency'}
    for tool in report['player_tools'].values():
        assert ToolAssessment.model_validate(tool).score is None
        assert tool['status'] in ['estimated','insufficient_data','not_supported']
    json.dumps(report,allow_nan=False)


def test_pose_insufficient_proxies_and_tools_withheld():
    r=result([]);assert calculate(r)=={}
    assert all(tool['status']=='insufficient_data' and tool['confidence']==0 and not tool['evidence']
               for tool in r['scouting_report']['player_tools'].values())


def test_aggregation_latest_no_cross_role_averages_or_double_count(poses):
    batting=result(poses);defense=result(poses,'defense',2)
    aggregate=aggregate_tools([batting,defense,defense])
    assert aggregate['player_tools']['contact']['representative_analysis_id']==batting['id']
    assert aggregate['player_tools']['fielding']['representative_analysis_id']==defense['id']
    assert aggregate['player_tools']['fielding']['evidence_count']==1
    assert aggregate['player_tools']['speed']['status']=='insufficient_data'
    assert aggregate['best_tool'] is None and aggregate['play_style'] is None


def test_no_real_demo_tool_aggregation(poses):
    real=result(poses);demo=result(poses);demo['synthetic_demo']=True
    aggregate=aggregate_tools([real,demo]);assert aggregate['mixed_sources']
    assert all(t['status']=='insufficient_data' and not t['evidence'] for t in aggregate['player_tools'].values())


def test_three_compatible_candidate_paths_required(poses):
    records=[]
    for day in range(1,4):
        r=result(poses,day=day)
        r['events']=[{'type':'swing','timestamp':.3}]
        r['scouting_report']=build_tools(r,[]);records.append(r)
    assert repeated_hand_path(records[:2]) is None
    metric=repeated_hand_path(records)
    assert metric['value']==pytest.approx(0) and metric['sample_count']==3
    assert metric['analysis_ids']==[r['id'] for r in records]
    assert metric['confidence']==.2
    assert observe(aggregate_tools(records)['player_tools']['contact'],'hand_path_consistency_proxy')['value']==pytest.approx(0)
    records[-1]['capture_context']['camera_angle']='front'
    assert repeated_hand_path(records) is None


def test_evidence_links_existing_play_view_and_raw_retrieval(client,mock_video):
    r=upload(client,player_id='EVIDENCE').json()
    report=r['scouting_report'];ref=report['player_tools']['contact']['evidence'][0]
    assert ref['play_id'] in [p['id'] for p in report['plays']]
    assert ref['scope']=='whole_clip' and ref['candidate']
    assert ref['visualization_reference']['overlay_video_url']==r['visualization']['overlay_video_url']
    bundle=client.get('/api/reports/'+r['id']).json()
    assert bundle['player_tools']['contact']['evidence'][0]['play_id']==ref['play_id']
    assert client.get('/api/analysis/'+r['id']).json()==r


@pytest.mark.parametrize('change',[None,{'camera_angle':'front'},{'environment':'real','vr_environment':None},
    {'vr_environment':'other-game'},{'video_quality':'fair'},{'camera_motion':'moving'},{'projection':'360'}])
def test_growth_capture_incompatibility_blocks_all_deltas(change):
    a=record(.3,1);b=record(.2,2);a['capture_context']=deepcopy(CAPTURE);b['capture_context']=deepcopy(CAPTURE)
    if change is None:b['capture_context']=None
    else:b['capture_context'].update(change)
    point=compare_records([a,b])[-1]
    assert not point['comparison_compatible'] and point['comparison_reason']
    assert point['observations']['balance']['delta'] is None


def test_growth_tool_observations_with_metadata(poses):
    a=result(poses);b=result(poses,day=2)
    point=compare_records([a,b])[-1]
    assert point['comparison_compatible']
    assert point['tool_changes']['power']['hand_speed_proxy']['delta']==pytest.approx(0)
    assert point['tool_changes']['contact']['contact']['delta'] is None
    assert all(score['delta'] is None for score in point['criterion_scores'].values())


@pytest.mark.parametrize('value',['{}','[]','bad',json.dumps({'camera_angle':'side','environment':'vr','video_quality':'good'})])
def test_invalid_capture_context_rejected_without_analysis(client,value):
    for path in ['/api/analyze','/api/demo/batter','/api/vod','/api/live']:
        assert client.post(path,data={'capture_context':value},files={'video':('x.mp4',b'fake')}).status_code==422


def test_capture_context_persisted_in_raw_and_history(client,mock_video):
    r=upload(client,player_id='CAPTURE',capture_context=json.dumps(CAPTURE)).json()
    assert r['capture_context']==CAPTURE
    point=client.get('/api/players/CAPTURE/history').json()['points'][0]
    assert point['capture_context']==CAPTURE and not point['comparison_compatible']
    assert 'tool_changes' in point


def test_aggregation_different_players_never_combines_evidence(poses):
    a=result(poses);b=result(poses);b['player_id']='OTHER'
    aggregate=aggregate_tools([a,b])
    assert aggregate['mixed_players']
    assert all(not t['evidence'] for t in aggregate['player_tools'].values())


@pytest.mark.parametrize('position',['infielder','outfielder'])
def test_manual_fielding_context_preserved(poses,position):
    r=result(poses,'defense');r.update(analyze_role(poses,'defense',position_type=position))
    report=build_tools(r,[])
    assert report['role_summary']['position_type']==position
    assert report['player_tools']['fielding']['status']=='estimated'


@pytest.mark.parametrize('route',['/api/vod','/api/live'])
def test_live_vod_pass_conditions_to_common_engine_metadata(client,monkeypatch,route):
    captured={}
    if route=='/api/vod':
        async def submit(video,config,segments,metadata,options):
            captured.update(metadata);return {'id':'test'}
        monkeypatch.setattr('app.api.modes.submit',submit)
    else:
        def start(config,url,path,metadata):
            captured.update(metadata);return {'id':'test'}
        monkeypatch.setattr('app.api.modes.sessions.start',start)
    response=client.post(route,data={'player_id':'PLAYER','comparison_context':'practice-A','capture_context':json.dumps(CAPTURE)},
                         files={'video':('test.mp4',b'test')})
    assert response.status_code in [200,202]
    assert captured=={'player_id':'PLAYER','comparison_context':'practice-A','capture_context':CAPTURE}


@pytest.mark.parametrize('window',[None,{'duration_seconds':1.5,'sample_count':8,'max_gap_seconds':.1},
    {'duration_seconds':.7,'sample_count':6,'max_gap_seconds':.1},
    {'duration_seconds':.7,'sample_count':8,'max_gap_seconds':.4}])
def test_growth_observation_coverage_must_match(window):
    first=record(.3,1);second=record(.2,2);second['scouting_report']['observation_window']=window
    point=compare_records([first,second])[-1]
    assert not point['comparison_compatible']
    assert point['observations']['balance']['delta'] is None


def test_stationary_running_hint_does_not_create_speed_assessment(poses):
    still=[deepcopy(poses[0]) for _ in range(8)]
    for i,p in enumerate(still):p['time_seconds']=i*.1
    tool=result(still,'baserunning')['scouting_report']['player_tools']['speed']
    assert tool['status']=='insufficient_data' and tool['confidence']==0
    assert not tool['evidence'] and observe(tool,'running_speed_proxy')['value'] is None


def test_old_incomplete_capture_does_not_block_new_compatible_candidates(poses):
    records=[]
    for day in range(1,5):
        r=result(poses,day=day);r['events']=[{'type':'swing','timestamp':.3}]
        r['scouting_report']=build_tools(r,[]);records.append(r)
    records[0]['capture_context']=None
    metric=repeated_hand_path(records)
    assert metric['sample_count']==3
    assert records[0]['id'] not in metric['analysis_ids']
