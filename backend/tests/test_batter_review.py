"""Synthetic input checks, not real WONY accuracy or contact ground truth."""
from copy import deepcopy
import json
import numpy as np
import pytest
from app.validation.batter_review import BatterReview,review_batter
from app.validation.context import pitcher_context
from .test_roles import client
from .test_target_validation import clip,selection
from .test_input_quality import samples,headers


@pytest.fixture
def result():
    poses=samples()
    return {'pose':poses,'automatic_role_estimate':{'value':'unknown','confidence':0,'estimated':True},
        'validation_summary':{'metadata':{'duration_seconds':2}},
        'target_tracking':{'selection':{'confirmed_by_user':True,'viewpoint':'third_person'}},
        'source_time_mapping':[{'clip_time':s['time_seconds'],'source_time':s['time_seconds'],
            'frame_index':i,'source_frame_index':i*6} for i,s in enumerate(poses)],
        'visualization':{'overlay_video_url':'/overlay.mp4','pose3d':{'frames':[{'frame':i,'joints':{}} for i in range(16)]}}}


def review():return BatterReview.model_validate({'windows':[{'start':0,'end':1.5}]})


def test_manual_windows_do_not_create_contact_bat_speed_or_swing_events(result):
    r=review_batter(result,review())
    assert r['automatic_role']['value']=='unknown' and r['manual_role']=='batter'
    assert r['contact_score'] is None and r['power_score'] is None and r['bat_speed'] is None
    p=r['plays'][0]
    assert p['swing_start']['value'] is None and p['swing_end']['value'] is None
    assert p['swing_path']['value'] is None and p['swing_type']['value'] is None
    assert p['contact']['value'] is None and p['lower_body_power_proxy']['value'] is None
    assert r['bat_trail']['value'] is None and r['bat_object_tracking']['value'] is None


def test_single_visible_hand_is_not_bat_or_two_hand_path(result):
    r=review_batter(result,review())['plays'][0]
    assert r['right_hand_path_2d_proxy']['value']
    assert r['both_arm_visible_samples']==0 and r['swing_path']['value'] is None
    assert r['right_hand_path_2d_proxy']['confidence']==.25
    assert r['right_elbow_angle_range_2d']['value'] is not None


@pytest.mark.parametrize('view',['first_person','unknown'])
def test_first_person_never_generates_upper_body_from_hidden_landmarks(result,view):
    result['target_tracking']['selection']['viewpoint']=view
    p=review_batter(result,review())['plays'][0]
    assert p['head_displacement_2d_proxy']['value'] is None
    assert p['right_hand_path_2d_proxy']['value'] is None
    assert p['references']['estimated_3d_frames']==[]


def test_unconfirmed_target_never_produces_body_observations(result):
    result['target_tracking']['selection']['confirmed_by_user']=False
    assert review_batter(result,review())['plays'][0]['head_displacement_2d_proxy']['value'] is None


def test_no_pose_after_loss_is_not_interpolated(result):
    result['pose']=result['pose'][:3]
    p=review_batter(result,review())['plays'][0]
    assert p['right_hand_path_2d_proxy']['value'] is None
    assert p['head_displacement_2d_proxy']['value'] is None


def test_gap_in_pose_cannot_be_filled_for_review_metrics(result):
    result['pose']=[s for s in result['pose'] if not .5<=s['time_seconds']<=1]
    assert review_batter(result,review())['plays'][0]['head_displacement_2d_proxy']['value'] is None


def test_missing_wrist_does_not_prevent_separate_head_input(result):
    for s in result['pose']:s['landmarks'][16]['visibility']=.1
    p=review_batter(result,review())['plays'][0]
    assert p['head_displacement_2d_proxy']['value'] is not None
    assert p['right_hand_path_2d_proxy']['value'] is None


@pytest.mark.parametrize('windows',[[{'start':1,'end':.5}],[{'start':0,'end':float('nan')}],[],[{'start':0,'end':1},{'start':.5,'end':1.5}]])
def test_invalid_manual_review_ranges(windows):
    with pytest.raises(ValueError):BatterReview.model_validate({'windows':windows})


def test_out_of_video_window_rejected(result):
    with pytest.raises(ValueError,match='duration'):review_batter(result,BatterReview.model_validate({'windows':[{'start':0,'end':3}]}))


def test_ordered_arm_motion_alone_cannot_make_batter_clip_pitcher():
    r=pitcher_context(samples(),[],[])
    assert r['throwing_sequence']['detected'] and r['value']=='unknown'


def test_review_api_schema_rejects_invalid_windows(client):
    response=client.post('/api/validation',data={'selection':selection().model_dump_json(),
        'batter_review':json.dumps({'windows':[{'start':1,'end':.5}]})},files={'video':('x.mp4',b'fake')})
    assert response.status_code==422


def test_review_api_preserves_first_person_and_null_tools(client,clip):
    s=selection(viewpoint='first_person',role_hint='batter')
    with clip.open('rb') as source:
        response=client.post('/api/validation',data={'selection':s.model_dump_json(),
            'batter_review':json.dumps({'windows':[{'start':0,'end':.8}]})},files={'video':('clip.mp4',source,'video/mp4')})
    assert response.status_code==200,response.text
    r=client.get('/api/validation/'+response.json()['id']+'/analysis').json()
    assert r['batter_validation']['automatic_role']['value']=='unknown'
    assert r['pose']==[] and r['events']==[]
    assert r['batter_validation']['plays'][0]['head_displacement_2d_proxy']['value'] is None
    assert all(t['score'] is None for t in r['scouting_report']['player_tools'].values())
