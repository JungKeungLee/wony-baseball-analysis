"""DEMO fixtures for object/effect guards; real accuracy is reported separately."""
import json
from pathlib import Path
import cv2
import numpy as np
import pytest
from app.validation.bat_tracking import SeededBatTracker,effect_candidates,swing_candidates
from app.validation.bat_hybrid import HybridBatTracker,expanded_search_bbox
from app.validation.bat_sequence import BatConfig,validate_bat_sequence,digest
from .test_target_validation import clip


@pytest.fixture
def textured():
    image=np.full((180,240,3),20,dtype=np.uint8)
    mask=np.zeros(image.shape[:2],dtype=np.uint8)
    cv2.fillConvexPoly(mask,np.array([[50,60],[140,90],[140,110],[50,80]],np.int32),255)
    noise=np.random.default_rng(7).integers(60,190,image.shape[:2],dtype=np.uint8)
    for c in range(3):image[:,:,c][mask>0]=noise[mask>0]
    return image


def test_manual_texture_track_moves_object_without_wrist(textured):
    tracker=SeededBatTracker((55,70),(135,100),18)
    first=tracker.update(textured);assert first['status']=='tracking'
    moved=cv2.warpAffine(textured,np.float32([[1,0,1],[0,1,0]]),(240,180))
    r=tracker.update(moved)
    assert r['status']=='tracking' and r['tip_xy'][0]==pytest.approx(56,abs=.5)
    assert not r['wrist_fallback_used'] and r['bat_speed'] is None


def test_feature_loss_is_terminal_even_if_new_object_appears(textured):
    tracker=SeededBatTracker((55,70),(135,100),18)
    r=tracker.update(np.zeros_like(textured));assert r['status']=='tracking_lost'
    assert tracker.update(textured)['status']=='tracking_lost'
    assert tracker.record()['tip_xy'] is None


def test_disappearing_object_does_not_reacquire_wrist(textured):
    tracker=SeededBatTracker((55,70),(135,100),18);tracker.update(textured)
    assert tracker.update(np.zeros_like(textured))['status']=='tracking_lost'
    assert not tracker.update(textured)['wrist_fallback_used']


@pytest.mark.parametrize('tip,shaft,width',[((0,0),(0,0),10),((0,0),(50,50),0),((0,0),(50,50),40)])
def test_invalid_manual_axes(tip,shaft,width):
    with pytest.raises(ValueError):SeededBatTracker(tip,shaft,width)


def test_color_line_is_candidate_not_confirmed_trail():
    image=np.zeros((180,240,3),dtype=np.uint8);cv2.rectangle(image,(40,50),(140,60),(255,0,0),-1)
    candidates,mask=effect_candidates(image,(0,0,240,180))
    assert candidates and all(not c['confirmed_bat_trail'] and c['semantic_type']=='unknown_colored_effect' for c in candidates)


def test_field_green_and_white_are_not_color_candidates():
    image=np.zeros((180,240,3),dtype=np.uint8)
    cv2.rectangle(image,(20,50),(140,60),(0,255,0),-1);cv2.rectangle(image,(20,90),(140,100),(255,255,255),-1)
    assert effect_candidates(image,(0,0,240,180))[0]==[]


def test_effect_region_bounds_are_checked():
    with pytest.raises(ValueError):effect_candidates(np.zeros((10,10,3),np.uint8),(0,0,11,10))


def motion_records():
    records=[]
    for i in range(30):
        a=np.deg2rad(min(i,8)*4)
        records.append({'timestamp':i/60,'status':'tracking','tip_xy':[100+80*np.cos(a),100+80*np.sin(a)],'shaft_reference_xy':[100,100]})
    return records


def test_candidate_start_end_from_actual_object_points_not_score():
    events=swing_candidates(motion_records())
    assert len(events)==1 and events[0]['end'] is not None
    assert events[0]['path'][0]['timestamp']==events[0]['start']
    assert events[0]['path'][-1]['timestamp']<=events[0]['end']
    assert events[0]['swing_type'] is None and events[0]['contact'] is None and events[0]['bat_speed'] is None
    assert not events[0]['verified_swing']


def test_loss_mid_swing_has_no_invented_end():
    rows=motion_records()[:7];rows.append({'timestamp':7/60,'status':'tracking_lost'})
    e=swing_candidates(rows)[0]
    assert e['end'] is None and e['status']=='incomplete_tracking_lost'


def test_sampling_gap_cannot_complete_a_swing():
    rows=motion_records()[:7]+[dict(r,timestamp=r['timestamp']+1) for r in motion_records()[7:]]
    e=swing_candidates(rows)[0]
    assert e['end'] is None and e['status']=='incomplete_sampling_gap'


def test_static_object_is_not_swing():
    rows=[{'timestamp':i/60,'status':'tracking','tip_xy':[80,80],'shaft_reference_xy':[100,100]} for i in range(30)]
    assert swing_candidates(rows)==[]


def test_clip_end_cannot_invent_swing_end():
    e=swing_candidates(motion_records()[:7])[0]
    assert e['end'] is None and e['status']=='incomplete_clip_end'


@pytest.mark.parametrize('seeds',[[{'source_time':0,'tip':[1,float('nan')],'shaft':[20,20],'width':10}],
 [{'source_time':1,'tip':[10,10],'shaft':[40,40],'width':5},{'source_time':0,'tip':[10,10],'shaft':[40,40],'width':5}]])
def test_seed_config_invalid(seeds):
    with pytest.raises(ValueError):BatConfig.model_validate({'effect_region':[0,0,96,80],'seeds':seeds})


def test_source_hash_rejects_different_video(clip,tmp_path):
    report=tmp_path/'report.json';report.write_text('{}');(tmp_path/'source.mp4').write_bytes(b'other')
    with pytest.raises(ValueError,match='exact video'):validate_bat_sequence(clip,BatConfig(effect_region=(0,0,96,80)),tmp_path/'out',report)


def test_first_person_cannot_attribute_target_object(clip,tmp_path):
    import shutil
    shutil.copyfile(clip,tmp_path/'source.mp4')
    report=tmp_path/'report.json';report.write_text(json.dumps({'target_tracking':{'selection':{'confirmed_by_user':True,'viewpoint':'first_person'}}}))
    with pytest.raises(ValueError,match='third-person'):validate_bat_sequence(clip,BatConfig(effect_region=(0,0,96,80)),tmp_path/'out',report)


def test_seed_cannot_run_without_target_lock(clip,tmp_path):
    c=BatConfig.model_validate({'effect_region':[0,0,96,80],'seeds':[{'source_time':0,'tip':[20,20],'shaft':[50,50],'width':8}]})
    with pytest.raises(ValueError,match='target lock'):validate_bat_sequence(clip,c,tmp_path/'out')


def test_anonymous_effect_scan_never_rates_player(clip,tmp_path):
    r,_=validate_bat_sequence(clip,BatConfig(effect_region=(0,0,96,80)),tmp_path/'out')
    assert r['player_id'] is None and r['trail_confirmed'] is False
    assert r['bat_speed'] is None and r['swing_type'] is None and r['path_consistency'] is None
    assert r['scouting_inputs']['contact']['score'] is None and r['scouting_inputs']['power']['lower_body_proxy'] is None


def test_target_loss_stops_scene_and_object_scan(clip,tmp_path):
    import shutil
    shutil.copyfile(clip,tmp_path/'source.mp4');report=tmp_path/'report.json'
    report.write_text(json.dumps({'id':'test','player_id':'wony','target_tracking':{'selection':{'confirmed_by_user':True,'viewpoint':'third_person'},
        'frames':[{'source_time':0,'analysis_allowed':True,'status':'tracking','bbox':[20,10,30,60]}, {'source_time':.3,'analysis_allowed':False,'status':'tracking_lost'}]}}))
    r,_=validate_bat_sequence(clip,BatConfig(effect_region=(0,0,96,80)),tmp_path/'out',report)
    assert all(e['source_time']<.3 for e in r['effect_candidates'])


def test_duplicate_file_hash_is_same_content(clip,tmp_path):
    import shutil
    other=tmp_path/'duplicate.mp4';shutil.copyfile(clip,other)
    assert digest(clip)==digest(other)


def test_manual_seed_near_another_actor_is_rejected(clip,tmp_path):
    import shutil
    shutil.copyfile(clip,tmp_path/'source.mp4');report=tmp_path/'report.json'
    report.write_text(json.dumps({'id':'test','player_id':'wony','target_tracking':{'selection':{'confirmed_by_user':True,'viewpoint':'third_person'},
        'frames':[{'source_time':0,'analysis_allowed':True,'status':'tracking','bbox':[20,10,30,60]}]}}))
    c=BatConfig.model_validate({'effect_region':[0,0,96,80],'seeds':[{'source_time':0,'tip':[40,15],'shaft':[75,45],'width':6}]})
    with pytest.raises(ValueError,match='shaft anchor'):validate_bat_sequence(clip,c,tmp_path/'out',report)


def reviewed_path(dx=100,dy=0,epoch=0):
    from app.validation.bat_path import OBJECT_SOURCE
    return {'source':OBJECT_SOURCE,'verified_bat_path':True,'status':'complete_candidate','start':0,'end':.2,'epoch':epoch,'source_sha256':'DEMO',
        'path':[{'timestamp':i/60,'tip_xy':[i*dx/12,i*dy/12]} for i in range(13)]}


@pytest.mark.parametrize('dy,kind',[(60,'downswing'),(0,'level'),(-60,'uppercut')])
def test_projected_labels_require_review_and_declared_side_view(dy,kind):
    from app.validation.bat_path import projected_type
    e=reviewed_path(dy=dy)
    assert projected_type(e) is None
    assert projected_type(e,calibrated_side_view=True)['value']==kind
    e['verified_bat_path']=False
    assert projected_type(e,calibrated_side_view=True) is None


def test_wrist_cannot_be_classified_as_bat_path():
    from app.validation.bat_path import projected_type,compare_paths
    e=reviewed_path();e['source']='right_wrist'
    assert projected_type(e,calibrated_side_view=True) is None
    assert compare_paths([e]*3,camera_context='DEMO',reference_length=100) is None


def test_three_reviewed_compatible_paths_only_for_consistency():
    from app.validation.bat_path import compare_paths
    events=[reviewed_path(dx=100+i,epoch=i) for i in range(3)]
    assert compare_paths(events) is None
    r=compare_paths(events,camera_context='DEMO-fixed-view',reference_length=100)
    assert r['sample_count']==3 and r['value']>=0 and r['ability_score'] is None
    assert compare_paths([events[0]]*3,camera_context='DEMO-fixed-view',reference_length=100) is None


def test_incomplete_path_never_compared_or_typed():
    from app.validation.bat_path import compare_paths,projected_type
    e=reviewed_path();e['end']=None
    assert projected_type(e,calibrated_side_view=True) is None
    assert compare_paths([e]*3,camera_context='DEMO',reference_length=100) is None


def rendered_bat_frame(tip=(45,55),handle=(145,105),color=(255,80,0)):
    image=np.full((180,260,3),18,dtype=np.uint8)
    cv2.line(image,tuple(map(int,tip)),tuple(map(int,handle)),color,12,cv2.LINE_AA)
    cv2.circle(image,tuple(map(int,tip)),6,(220,180,80),-1)
    return image


def test_hybrid_tracker_records_detected_object_geometry_without_wrist_fallback():
    tracker=HybridBatTracker((45,55),(145,105),14)
    first=tracker.update(rendered_bat_frame(),search_bbox=(0,0,260,180),wrist_hint=(145,105))
    moved=tracker.update(rendered_bat_frame((50,58),(150,108)),search_bbox=(0,0,260,180),wrist_hint=(150,108))
    assert first['status'] in ('tracking','low_confidence') and moved['image_detection_supported']
    assert moved['path_point_xy']==moved['tip_xy'] and moved['handle_xy'] is not None
    assert moved['orientation_degrees_image'] is not None and moved['tracking_method']
    assert moved['wrist_constraint_used'] and not moved['wrist_fallback_used']
    assert moved['bat_speed'] is None and not moved['accuracy_verified']


def test_hybrid_tracker_wrist_cannot_create_missing_bat():
    tracker=HybridBatTracker((45,55),(145,105),14,max_flow_only=0)
    tracker.update(rendered_bat_frame(),search_bbox=(0,0,260,180),wrist_hint=(145,105))
    lost=tracker.update(np.full((180,260,3),18,np.uint8),search_bbox=(0,0,260,180),wrist_hint=(150,108))
    assert lost['status']=='tracking_lost' and lost['tip_xy'] is None
    assert not lost['wrist_fallback_used'] and not lost['automatic_reidentification']


def test_hybrid_tracker_rejects_distant_same_color_target_switch():
    tracker=HybridBatTracker((35,45),(105,80),10,max_flow_only=0)
    tracker.update(rendered_bat_frame((35,45),(105,80)),search_bbox=(0,0,260,180),wrist_hint=(105,80))
    other=rendered_bat_frame((170,100),(245,140))
    lost=tracker.update(other,search_bbox=(0,0,260,180),wrist_hint=(245,140))
    assert lost['status']=='tracking_lost'
    assert 'absent' in lost['reason'] and lost['tip_xy'] is None


def test_hybrid_edge_detection_can_support_visible_color_shift_only():
    tracker=HybridBatTracker((45,55),(145,105),14,max_flow_only=0)
    tracker.update(rendered_bat_frame(),search_bbox=(0,0,260,180),wrist_hint=(145,105))
    shifted=rendered_bat_frame((50,58),(150,108),color=(235,235,235))
    record=tracker.update(shifted,search_bbox=(0,0,260,180),wrist_hint=(150,108))
    assert record['status'] in ('tracking','low_confidence')
    assert record['detection_source']=='edge_line_near_visible_wrist'
    assert record['image_detection_supported'] and not record['wrist_fallback_used']


def test_expanded_bat_roi_is_clipped_to_source():
    assert expanded_search_bbox((10,20,40,80),(120,100,3),1)==(0,0,90,120)


def test_hybrid_swing_path_keeps_frame_evidence_fields():
    rows=motion_records()
    for row in rows:
        row.update(handle_xy=row['shaft_reference_xy'],path_point_xy=row['tip_xy'],confidence=.7,
                   image_detection_supported=True,tracking_method='appearance_detection_temporal_association',
                   detection_source='seed_appearance_component',wrist_constraint_used=True,
                   source='manual_bat_seed_detection_flow_association_v2')
    event=swing_candidates(rows)[0]
    assert event['image_detection_coverage']==1 and event['minimum_tracking_confidence']==.7
    assert event['path'][0]['detection_source']=='seed_appearance_component'
    assert event['path'][0]['handle_xy'] is not None and not event['verified_bat_path']
