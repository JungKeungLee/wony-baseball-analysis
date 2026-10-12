from copy import deepcopy
from pathlib import Path
import json,subprocess
import cv2
import numpy as np
import pytest
from pydantic import ValidationError
from .test_roles import client
from app.validation.target import TargetSelection,ManualTargetTracker,map_pose_to_source
from app.validation.runner import validate_clip,metadata
from app.validation.hud import numeric_hud


def selection(**overrides):
    return TargetSelection.model_validate(dict(player_id='wony',confirmed_by_user=True,
        viewpoint='third_person',source_width=96,source_height=80,bbox=[20,10,30,60])|overrides)


class FakeTracker:
    def __init__(self,box=(20,10,30,60),ok=True):self.box=box;self.ok=ok;self.updates=0
    def init(self,frame,bbox):self.initial=bbox
    def update(self,frame):self.updates+=1;return self.ok,self.box


@pytest.fixture
def image():return np.random.default_rng(1).integers(40,170,(80,96,3),dtype=np.uint8)


def test_manual_confirmation_required_before_tracker(image):
    s=selection();s.confirmed_by_user=False
    def forbidden():raise AssertionError('Tracker must not initialize without confirmation')
    r=ManualTargetTracker(s,forbidden).update(image,0)
    assert not r['analysis_allowed'] and r['bbox'] is None and r['status']=='user_confirmation_required'


@pytest.mark.parametrize('view',['first_person','unknown'])
def test_viewpoint_blocks_body_tracking(image,view):
    s=selection();s.viewpoint=view
    def forbidden():raise AssertionError('No body tracker for first-person/unknown')
    r=ManualTargetTracker(s,forbidden).update(image,0)
    assert not r['analysis_allowed'] and r['bbox'] is None


def test_loss_is_terminal_no_replacement(image):
    backend=FakeTracker(ok=False);tracker=ManualTargetTracker(selection(),lambda:backend)
    assert tracker.update(image,0)['status']=='confirmed'
    assert tracker.update(image,.1)['status']=='tracking_lost'
    for t in [.2,1,10]:
        r=tracker.update(image,t);assert r['status']=='tracking_lost' and r['bbox'] is None and not r['analysis_allowed']
    assert backend.updates==1 and r['lost_at']==.1 and r['reidentification_required']


def test_scene_change_stops_before_tracker_search(image):
    backend=FakeTracker();tracker=ManualTargetTracker(selection(),lambda:backend);tracker.update(image,0)
    r=tracker.update(np.full_like(image,255),.1)
    assert r['status']=='tracking_lost' and backend.updates==0


@pytest.mark.parametrize('box',[(-1,10,30,60),(80,10,30,60),(55,10,30,60)])
def test_exit_or_abrupt_displacement_loses_target(image,box):
    tracker=ManualTargetTracker(selection(),lambda:FakeTracker(box));tracker.update(image,0)
    r=tracker.update(image,.1);assert not r['analysis_allowed'] and r['status']=='tracking_lost'


def test_changed_appearance_loses_target(image):
    tracker=ManualTargetTracker(selection(),lambda:FakeTracker());tracker.update(image,0)
    other=image.copy();other[10:70,20:50]=(0,0,240)
    r=tracker.update(other,.1)
    assert r['status']=='tracking_lost' and 'Appearance' in r['reason']


def test_successful_update_is_not_identity_probability(image):
    tracker=ManualTargetTracker(selection(),lambda:FakeTracker());tracker.update(image,0)
    r=tracker.update(image,.1)
    assert r['status']=='tracking' and r['analysis_allowed'] and r['confidence']<=.6
    assert not r['identity_verified_automatically']


@pytest.mark.parametrize('box',[[20,10,0,60],[20,10,300,60],[float('nan'),0,20,20]])
def test_invalid_selection(box):
    with pytest.raises(ValidationError):selection(bbox=box)


def test_roi_coordinates_restore_source_contract():
    sample={'aspect_ratio':1,'time_seconds':0,'landmarks':[{'x':.5,'y':.5,'z':.2,'visibility':.9}]}
    mapped=map_pose_to_source(sample,(100,50,200,400),1000,800)
    assert mapped['landmarks'][0]['x']==pytest.approx(.2)
    assert mapped['landmarks'][0]['y']==pytest.approx(.3125)
    assert mapped['landmarks'][0]['z']==pytest.approx(.04)
    assert mapped['aspect_ratio']==1.25 and sample['landmarks'][0]['x']==.5


def test_validation_api_rejects_unconfirmed_target(client):
    s=selection();s.confirmed_by_user=False
    r=client.post('/api/validation',data={'selection':s.model_dump_json()},files={'video':('x.mp4',b'fake')})
    assert r.status_code==422 and 'Confirm' in r.json()['detail']


def test_invalid_video_cleanup_and_metadata_mismatch(client):
    r=client.post('/api/validation',data={'selection':selection().model_dump_json()},files={'video':('x.mp4',b'not-media')})
    assert r.status_code==422
    from app.api.validation import root
    assert not list(root().glob('*.upload'))


@pytest.fixture
def clip(tmp_path):
    path=tmp_path/'black.mp4'
    subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i','color=c=black:s=96x80:r=10','-t','1','-c:v','mpeg4',str(path)],check=True)
    return path


def test_real_pts_and_first_person_never_extracts_body(clip,tmp_path,monkeypatch):
    s=selection();s.viewpoint='first_person'
    def forbidden(_):raise AssertionError('Body pose forbidden in first-person')
    monkeypatch.setattr('app.validation.runner.extract_pose',forbidden)
    r=validate_clip(clip,s,tmp_path/'reports')
    assert r['pose']==[] and r['usable_pose_frames']==0
    assert all(not f['joints'] for f in r['visualization']['pose3d']['frames'])
    assert all(t['score'] is None and t['status']=='insufficient_data' for t in r['scouting_report']['player_tools'].values())
    assert r['source_time_mapping']
    for m in r['source_time_mapping']:
        assert m['original_pts']>=0 and m['source_frame_index']>=0
        assert m['clip_time']==pytest.approx(m['source_time']-r['source_time_mapping'][0]['source_time'])


def test_existing_result_routes_not_polluted(client,clip,monkeypatch):
    def forbidden(_):raise AssertionError('No first-person body pose')
    monkeypatch.setattr('app.validation.runner.extract_pose',forbidden)
    s=selection();s.viewpoint='first_person'
    with clip.open('rb') as source:r=client.post('/api/validation',data={'selection':s.model_dump_json()},files={'video':('black.mp4',source,'video/mp4')})
    assert r.status_code==200,r.text
    identifier=r.json()['id'];bundle=client.get('/api/validation/'+identifier).json()
    assert bundle['kind']=='validation' and not bundle['synthetic_demo']
    assert client.get('/api/validation/'+identifier+'/source').status_code==200
    assert client.get('/api/validation/'+identifier+'/analysis').json()['validation_only']
    assert client.get('/api/validation/'+identifier+'/assets/overlay.mp4').status_code==200
    assert client.get('/api/reports').json()['total']==0
    assert client.get('/api/players/wony/history').json()['count']==0
    assert client.get('/demo/validation/report/'+identifier).status_code==200
    assert client.get('/api/validation/'+identifier+'/assets/private.json').status_code==404


def test_hud_unavailable_is_not_fabricated(monkeypatch,image):
    monkeypatch.setattr('app.validation.hud.shutil.which',lambda _:None)
    assert numeric_hud(image,'hud_original_speed',0)['value'] is None


def test_hud_digits_remain_review_only_game_values(monkeypatch,image):
    monkeypatch.setattr('app.validation.hud.shutil.which',lambda _:'/fake/tesseract')
    class Reply:stdout=b'text\tconf\n24.9\t91\n'
    monkeypatch.setattr('app.validation.hud.subprocess.run',lambda *a,**k:Reply())
    result=numeric_hud(image,'hud_original_speed',0)
    assert result['value'] is None and result['ocr_candidate']==24.9 and result['source']=='sbo_hud_estimated'
    assert result['confidence']==0 and result['ocr_confidence']==.91
    assert result['physical_velocity'] is None and result['event_id'] is None and result['review_required']


def test_ambiguous_hud_numbers_withheld(monkeypatch,image):
    monkeypatch.setattr('app.validation.hud.shutil.which',lambda _:'/fake/tesseract')
    class Reply:stdout=b'text\tconf\n24.9\t91\n113.6\t91\n'
    monkeypatch.setattr('app.validation.hud.subprocess.run',lambda *a,**k:Reply())
    assert numeric_hud(image,'hud_original_speed',0)['value'] is None


def test_rounded_selection_cannot_initialize_outside_pixels(image):
    s=selection(source_width=95,bbox=[75.5,10,19.5,60])
    def forbidden():raise AssertionError('Out-of-frame initialization forbidden')
    r=ManualTargetTracker(s,forbidden).update(image[:,:95],0)
    assert r['status']=='tracking_lost' and not r['analysis_allowed']


def test_selection_after_last_pts_never_extracts_pose(clip,tmp_path,monkeypatch):
    s=selection(source_time=.99)
    def forbidden(_):raise AssertionError('No pose without a source frame')
    monkeypatch.setattr('app.validation.runner.extract_pose',forbidden)
    with pytest.raises(ValueError,match='No source frame'):validate_clip(clip,s,tmp_path/'reports')
