"""Input reliability tests; no fixtures are presented as actual WONY performance."""
from copy import deepcopy
import numpy as np
import pytest
from .test_target_validation import selection,FakeTracker
from app.validation.target import expanded_roi,ManualTargetTracker,map_pose_to_source
from app.validation.quality import quality_report,restrict_3d
from app.validation.hud import numeric_hud,digit_observation,temporal_vote,game_speed_summary
from app.validation.context import pitcher_context,throwing_sequence,pitching_header
from app.analysis.shared.role_classifier import classify_role
from app.visualization.pose3d import pose3d_sequence


def samples():
    result=[]
    for n in range(16):
        p=[{'x':.5,'y':.3,'z':0,'visibility':.95} for _ in range(33)]
        for i in (11,12):p[i]['y']=.3
        for i in (23,24):p[i]['y']=.6
        for i in (25,26):p[i]['y']=.75
        for i in (27,28):p[i]['y']=.9
        p[11]['x']=.4;p[12]['x']=.6;p[23]['x']=.4;p[24]['x']=.6
        p[13]['x']=.35;p[14]['x']=.65;p[15]['x']=.3;p[16]['x']=.7
        p[16]['y']=.3+.3*([.3,.2,0,-.3,-.4,-.3,-.2,0,.2,.4,.5,.6,.6,.6,.6,.6][n])
        # Occluded glove blocks general pose; the visible throwing arm remains valid.
        p[15]['visibility']=.1
        result.append({'time_seconds':n*.1,'aspect_ratio':1,'landmarks':p})
    return result


def headers(confidence=.95):return [{'timestamp':t,'detected':confidence>=.85,'confidence':confidence} for t in [0,.2,.4,.6]]


def observations(values,confidence=.9):
    return [{'metric':'hud_converted_speed','timestamp':i*.2,'ocr_candidate':v,'ocr_confidence':confidence,'evidence_reference':f'frame-{i}'} for i,v in enumerate(values)]


def test_expanded_roi_clips_edges_and_keeps_selection():
    s=selection(pose_margin=.2)
    assert expanded_roi(s.bbox,96,80,s.pose_margin)==(14,0,42,80)
    assert s.bbox==(20,10,30,60)
    assert expanded_roi(s.bbox,96,80,0)==(20,10,30,60)


@pytest.mark.parametrize('margin',[-.01,.51])
def test_invalid_margin_rejected(margin):
    with pytest.raises(ValueError):selection(pose_margin=margin)


def test_expanded_crop_outside_joint_cannot_gain_visibility():
    s=samples()[0];s['landmarks'][16]['x']=1.2
    mapped=map_pose_to_source(s,(10,10,60,60),96,80)
    assert mapped['landmarks'][16]['visibility']==0 and mapped['landmarks'][16]['outside_pose_crop']
    assert s['landmarks'][16]['visibility']==.95


def test_low_confidence_pauses_pose_without_identity_change(monkeypatch):
    frame=np.random.default_rng(1).integers(40,170,(80,96,3),dtype=np.uint8)
    fake=FakeTracker();tracker=ManualTargetTracker(selection(),lambda:fake);tracker.update(frame,0)
    monkeypatch.setattr('app.validation.target.cv2.compareHist',lambda *a:.28)
    r=tracker.update(frame,.1)
    assert r['status']=='low_confidence' and not r['analysis_allowed'] and r['bbox']
    assert r['player_id']=='wony' and not r['reidentification_required']
    monkeypatch.setattr('app.validation.target.cv2.compareHist',lambda *a:0)
    assert tracker.update(frame,.2)['status']=='tracking'


def test_reidentification_state_never_restarts_tracker():
    frame=np.full((80,96,3),100,dtype=np.uint8);fake=FakeTracker(ok=False)
    tracker=ManualTargetTracker(selection(),lambda:fake);tracker.update(frame,0)
    assert tracker.update(frame,.1)['status']=='tracking_lost'
    tracker.require_reidentification()
    assert tracker.update(frame,1000)['status']=='reidentification_required'
    assert not tracker.record(1000)['analysis_allowed'] and fake.updates==1


def test_pitcher_requires_scene_and_motion_without_lowering_full_body_gate():
    s=samples();context=pitcher_context(s,headers(),[])
    assert context['value']=='pitcher' and context['throwing_sequence']['detected']
    assert context['throwing_sequence']['leg_lift'] is None
    assert classify_role(s)['value']=='unknown'
    result=classify_role(s,{'sbo_pitcher':context})
    assert result['value']=='pitcher' and result['estimated'] and .7<=result['confidence']<=.8
    assert quality_report(s,16)['full_body_usable_frames']==0


@pytest.mark.parametrize('kind',['no_scene','one_header','weak_header','no_motion','hidden_arm'])
def test_context_insufficient_evidence_stays_unknown(kind):
    s=samples();h=headers()
    if kind=='no_scene':h=[]
    if kind=='one_header':h=h[:1]
    if kind=='weak_header':h=headers(.5)
    if kind=='no_motion':
        for item in s:item['landmarks'][16]['y']=.4
    if kind=='hidden_arm':
        for item in s:item['landmarks'][16]['visibility']=.2
    context=pitcher_context(s,h,[])
    assert context['value']=='unknown'
    assert classify_role(s,{'sbo_pitcher':context})['value']=='unknown'


def test_blank_scene_does_not_match_pitching_template():
    assert not pitching_header(np.zeros((1080,1920,3),dtype=np.uint8))['detected']


def test_manual_role_hint_is_explicit_auxiliary_input():
    s=selection(role_hint='pitcher')
    assert s.role_hint=='pitcher' and s.confirmed_by_user
    with pytest.raises(ValueError):selection(role_hint='invented')


def test_hud_one_frame_never_accepted():
    assert temporal_vote(observations([113.6]),'hud_converted_speed')[0]['value'] is None


def test_hud_majority_rejects_outlier_and_preserves_game_source():
    votes=temporal_vote(observations([113.6,113.6,113.6,973.6,113.6]),'hud_converted_speed')
    assert all(v['value'] is None for v in votes[:-1])
    assert votes[-1]['value']==113.6 and votes[-1]['source']=='sbo_hud_observed'
    assert votes[-1]['supporting_frames']==4 and votes[-1]['physical_velocity'] is None


@pytest.mark.parametrize('values,confidence', [([973.6]*5,.95),([113.6]*5,.69),([113.6,121.3,113.6,121.3,113.6],.95),([float('nan')]*5,.95)])
def test_invalid_or_unstable_hud_withheld(values,confidence):
    assert all(v['value'] is None for v in temporal_vote(observations(values,confidence),'hud_converted_speed'))


def test_hud_change_is_not_smeared_into_previous_speed():
    votes=temporal_vote(observations([113.6]*6+[121.3]),'hud_converted_speed')
    assert votes[-2]['value']==113.6 and votes[-1]['value'] is None


def test_duplicate_or_sparse_frames_cannot_supply_votes():
    o=observations([113.6]*5)
    for item in o:item['timestamp']=0
    assert temporal_vote(o,'hud_converted_speed')[-1]['value'] is None
    o=observations([113.6]*5)
    for item in o:item['timestamp']*=10
    assert temporal_vote(o,'hud_converted_speed')[-1]['value'] is None


@pytest.mark.parametrize('text',['1136','-24.9','113.6.7','1e2.3'])
def test_invalid_decimal_ocr_rejected(monkeypatch,text):
    monkeypatch.setattr('app.validation.hud.shutil.which',lambda _:'/fake/tesseract')
    class Reply:stdout=f'text\tconf\n{text}\t95\n'.encode()
    monkeypatch.setattr('app.validation.hud.subprocess.run',lambda *a,**k:Reply())
    r=numeric_hud(np.zeros((50,130,3),dtype=np.uint8),'hud_converted_speed',0)
    assert r['ocr_candidate'] is None and r['value'] is None


def test_preprocessing_disagreement_withheld(monkeypatch):
    replies=iter([{'ocr_candidate':121.3,'ocr_confidence':.95},{'ocr_candidate':127.3,'ocr_confidence':.95}])
    monkeypatch.setattr('app.validation.hud.numeric_hud',lambda *a,**k:next(replies))
    r=digit_observation(np.zeros((50,130,3),dtype=np.uint8),'hud_converted_speed',0)
    assert r['ocr_candidate'] is None and r['ocr_confidence']==0


def test_raw_and_converted_values_never_become_physical_speed():
    votes=[{'metric':'hud_original_speed','value':24.9,'timestamp':1}, {'metric':'hud_converted_speed','value':113.6,'timestamp':2}]
    result=game_speed_summary(votes)
    assert result['raw_game_speed']==24.9 and result['converted_game_speed_kmh']==113.6
    assert result['physical_velocity'] is None and not result['same_pitch_association_verified']


def test_low_quality_pose_cannot_create_partial_3d_body():
    s=samples();sequence=pose3d_sequence([(p['time_seconds'],None) for p in s],dict(enumerate(s)))
    assert any(f['joints'] for f in sequence['frames']) # previous projector accepted anchors
    visualization={'pose3d':sequence};restrict_3d(visualization,s)
    assert all(not f['joints'] for f in sequence['frames'])
    assert sequence['available_frames']==0 and sequence['accuracy'] is None


def test_sufficient_pose_3d_availability_is_not_accuracy():
    s=samples()[:1];s[0]['landmarks'][15]['visibility']=.95
    sequence=pose3d_sequence([(0,None)],{0:s[0]});restrict_3d({'pose3d':sequence},s)
    assert sequence['available_frames']==1 and sequence['frames'][0]['visualization_available']
    assert not sequence['accuracy_verified'] and sequence['accuracy'] is None and sequence['estimated']


def test_quality_rates_include_missed_frames_and_hidden_joints():
    r=quality_report(samples(),20)
    assert r['pose_detection_rate']==.8 and r['full_body_usable_rate']==0
    assert r['joint_detection_rates']['right_wrist']['rate']==.8
    assert r['joint_detection_rates']['left_wrist']['rate']==0 and not r['accuracy_verified']


def test_header_from_unrelated_later_scene_cannot_set_role():
    h=[dict(o,timestamp=o['timestamp']+50) for o in headers()]
    assert pitcher_context(samples(),h,[])['value']=='unknown'


def test_current_unconfirmed_hud_does_not_reuse_stale_speed():
    summary=game_speed_summary([{'metric':'hud_original_speed','value':24.9,'timestamp':0},
        {'metric':'hud_original_speed','value':None,'timestamp':2}])
    assert summary['raw_game_speed'] is None and summary['review_required']


def test_long_tracker_sequence_keeps_single_manual_identity():
    frame=np.full((80,96,3),100,dtype=np.uint8);fake=FakeTracker()
    tracker=ManualTargetTracker(selection(),lambda:fake)
    for i in range(1201):
        r=tracker.update(frame,i*.1)
        assert r['player_id']=='wony' and r['analysis_allowed']
    assert fake.updates==1200 and tracker.lost_at is None


@pytest.mark.parametrize('t',[float('nan'),-.1,0,2])
def test_tracking_sampling_gap_or_invalid_time_stops_attribution(t):
    frame=np.full((80,96,3),100,dtype=np.uint8);fake=FakeTracker()
    tracker=ManualTargetTracker(selection(),lambda:fake);tracker.update(frame,0)
    r=tracker.update(frame,t)
    assert r['status']=='tracking_lost' and fake.updates==0 and not r['analysis_allowed']


def test_expansion_cannot_attribute_neighbor_core():
    from app.validation.target import pose_in_target
    s=samples()[0]
    assert pose_in_target(s,(20,10,60,60),96,80)
    for i in [11,12,23,24]:s['landmarks'][i]['x']=.95
    assert not pose_in_target(s,(20,10,60,60),96,80)


from .test_roles import client
from .test_target_validation import clip


def test_role_hint_api_preserves_first_person_and_insufficient_tools(client,clip):
    s=selection(viewpoint='first_person',role_hint='pitcher',pose_margin=.2)
    with clip.open('rb') as source:
        response=client.post('/api/validation',data={'selection':s.model_dump_json()},files={'video':('clip.mp4',source,'video/mp4')})
    assert response.status_code==200
    result=client.get('/api/validation/'+response.json()['id']+'/analysis').json()
    assert result['role']=='pitcher' and result['automatic_role_estimate']['value']=='unknown'
    assert result['role_input']['source']=='user_provided' and result['pose']==[]
    assert result['status']=='insufficient_pose'
    assert all(t['score'] is None and t['status']=='insufficient_data' for t in result['scouting_report']['player_tools'].values())


def test_persistent_hud_is_not_new_post_pitch_evidence():
    votes=[{'metric':'hud_converted_speed','value':113.6,'timestamp':t} for t in [.8,1,3]]
    context=pitcher_context(samples(),headers(),votes)
    assert not context['speed_hud_change_after_motion']
    votes[-1]['value']=121.3
    assert pitcher_context(samples(),headers(),votes)['speed_hud_change_after_motion']


def test_longer_clip_metadata_supported_without_unbounded_frame_probe(tmp_path):
    import subprocess
    from app.validation.runner import metadata
    path=tmp_path/'longer.mp4'
    subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i','color=c=black:s=96x80:r=2','-t','40','-c:v','mpeg4',str(path)],check=True)
    meta=metadata(path)
    assert meta['duration_seconds']==40 and len(meta['frame_pts'])==80
    path2=tmp_path/'too-long.mp4'
    subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i','color=c=black:s=96x80:r=2','-t','121','-c:v','mpeg4',str(path2)],check=True)
    with pytest.raises(ValueError,match='120 seconds'):metadata(path2)


def test_preview_storage_uses_paths_not_resident_images(tmp_path):
    from app.validation.frames import PreviewFrames
    from pathlib import Path
    previews=PreviewFrames(tmp_path/'frames');image=np.zeros((80,96,3),dtype=np.uint8)
    for i in range(10):previews.append((i*.1,image))
    assert len(previews)==10 and all(isinstance(path,Path) for _,path in previews.items)
    assert list(previews)[-1][1].shape==image.shape


def test_role_context_does_not_validate_release_or_pitch_phases():
    from app.validation.quality import gate_pitcher_phases
    from app.visualization.keyframes import select_keyframes
    from app.analysis.engine import analyze_role
    s=samples();context=pitcher_context(s,headers(),[])
    result=analyze_role(s,'auto',scene_context={'sbo_pitcher':context})
    assert result['role']=='pitcher'
    gate_pitcher_phases(result,s,context)
    assert result['events']==[] and result['metrics']['release_time']['value'] is None
    assert all(v['value'] is None for v in result['metrics'].values())
    assert not result['phase_evidence_gate']['allow_phase_candidates']
    keys=select_keyframes(dict(enumerate(s)),result)
    assert [k['stage'] for k in keys]==['pose_reference']
    assert not any(k['phase_detected'] for k in keys)
