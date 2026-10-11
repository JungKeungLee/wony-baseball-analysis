import copy
import json
import subprocess
import cv2
import numpy as np
import pytest
from .test_roles import poses, client
from app.analysis.engine import analyze_role
from app.visualization.builder import align_samples
from app.visualization.demo import synthetic_clip
from app.visualization.joints import JOINTS
from app.visualization.keyframes import select_keyframes, qualified_highlights
from app.visualization.overlay import draw_overlay
from app.visualization.pose3d import project_pose, pose3d_sequence


def test_3d_is_centered_finite_and_explicitly_estimated(poses):
    frame=project_pose(poses[0],0,0)
    assert set(frame['joints'])==set(JOINTS)
    assert frame['estimated'] and frame['confidence_grade']=='low'
    assert 0 < frame['confidence'] <= .35
    for coords in frame['joints'].values():
        assert len(coords)==3 and np.isfinite(coords).all()
    midpoint=(np.array(frame['joints']['left_hip'])+np.array(frame['joints']['right_hip']))/2
    assert midpoint==pytest.approx(np.zeros(3))
    assert frame['joints']['head'][1] > frame['joints']['left_ankle'][1]
    assert frame['joint_confidence']['left_wrist'] <= .35


def test_missing_pose_preserves_frame_timeline(poses):
    frames=[(i*.1,np.zeros((120,160,3),dtype=np.uint8)) for i in range(4)]
    aligned=align_samples(frames,[poses[0],poses[2],{},dict(poses[0],time_seconds=float('nan'))])
    sequence=pose3d_sequence(frames,aligned)
    assert [f['frame'] for f in sequence['frames']]==[0,1,2,3]
    assert sequence['frames'][1]['joints']=={}
    assert sequence['frames'][1]['confidence']==0
    assert sequence['frames'][2]['joints']
    assert sequence['estimated'] and sequence['confidence']<=.35


def test_low_visibility_and_degenerate_depth_anchor(poses):
    bad=copy.deepcopy(poses[0]);bad['landmarks'][11]['visibility']=.1
    assert project_pose(bad,0,0)['joints']=={}
    bad=copy.deepcopy(poses[0])
    for i in [11,12,23,24]:
        bad['landmarks'][i].update(x=.5,y=.5)
    assert project_pose(bad,0,0)['confidence']==0


@pytest.mark.parametrize('role',['batter','pitcher'])
def test_phase_keyframes_and_unverified_impact(role):
    frames,samples=synthetic_clip(role)
    result=dict(analyze_role(samples,role),throwing_hand='right')
    keys=select_keyframes(align_samples(frames,samples),result)
    assert len(keys)==6
    assert all(k['estimated'] and not k['phase_detected'] for k in keys)
    assert all(k['frame'] is not None for k in keys)
    assert all('elbow_angle' in k['angles'] for k in keys)
    if role=='batter':
        for k in keys:
            if k['stage'] in ['front_foot_landing','estimated_impact']:
                assert k['status']=='reference_only' and k['confidence']==0


def test_static_pose_does_not_create_fake_phases(poses):
    samples=[dict(poses[0],time_seconds=n*.1) for n in range(8)]
    frames=[(n*.1,np.zeros((100,100,3),dtype=np.uint8)) for n in range(8)]
    result=dict(analyze_role(samples,'batter'),throwing_hand='right')
    keys=select_keyframes(align_samples(frames,samples),result)
    assert keys[0]['status']=='candidate'
    assert all(k['status']=='unavailable' and k['frame'] is None for k in keys[1:])


def test_warning_colors_require_both_metric_and_issue_confidence(poses):
    result={'metrics':{'balance':{'value':.5,'confidence':.9}},
            'weaknesses':[{'metric':'balance','confidence':.2,'text':'test'}]}
    assert qualified_highlights(result)==[]
    result['weaknesses'][0]['confidence']=.9
    highlights=qualified_highlights(result)
    assert highlights and highlights[0]['confidence']==.9
    frame=np.zeros((200,300,3),dtype=np.uint8)
    sample=poses[0]
    neutral=draw_overlay(frame,sample,0,highlights=[dict(highlights[0],confidence=.74)])
    warning=draw_overlay(frame,sample,0,highlights=highlights)
    pixel=(int(sample['landmarks'][27]['y']*400),int(sample['landmarks'][27]['x']*600))
    assert warning[pixel][2]>neutral[pixel][2]
    assert neutral[pixel][1]>neutral[pixel][2]


def test_overlay_video_jpegs_pose_and_result_roundtrip(client,monkeypatch,tmp_path,poses):
    frames=[(n*.1,np.zeros((160,240,3),dtype=np.uint8)) for n in range(8)]
    monkeypatch.setattr('app.api.routes.extract_frames',lambda _:frames)
    monkeypatch.setattr('app.api.routes.extract_pose',lambda _:poses)
    response=client.post('/api/analyze',data={'role':'batter'},files={'video':('clip.mp4',b'fixture')})
    assert response.status_code==200,response.text
    result=response.json();vis=result['visualization']
    assert result['schema_version']=='0.4.0'
    assert vis['frame_count']==len(frames)==len(vis['pose3d']['frames'])
    assert client.get('/api/analysis/'+result['id']).json()==result
    asset=client.get(vis['overlay_video_url'])
    assert asset.status_code==200 and asset.headers['content-type']=='video/mp4'
    partial=client.get(vis['overlay_video_url'],headers={'Range':'bytes=0-99'})
    assert partial.status_code==206 and len(partial.content)==100
    video_path=tmp_path/'overlay.mp4';video_path.write_bytes(asset.content)
    metadata=json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0',
        '-show_entries','stream=codec_name,nb_frames','-of','json',str(video_path)]))
    assert metadata['streams'][0]['codec_name']=='h264'
    assert int(metadata['streams'][0]['nb_frames'])==8
    for key in vis['keyframes']:
        if key['image_url']:
            response=client.get(key['image_url'])
            assert response.status_code==200 and cv2.imdecode(np.frombuffer(response.content,dtype=np.uint8),1) is not None
    assert not list((tmp_path/'results').glob('.visual-*'))
    assert client.get('/api/analysis/'+result['id']+'/assets/result.json').status_code==404


def test_visualization_encoding_failure_cleans_artifacts(client,monkeypatch,tmp_path,poses):
    monkeypatch.setattr('app.api.routes.extract_frames',lambda _:[(0,np.zeros((100,100,3),dtype=np.uint8))])
    monkeypatch.setattr('app.api.routes.extract_pose',lambda _:poses)
    def fail(*args,**kwargs):
        raise subprocess.TimeoutExpired('ffmpeg',90)
    monkeypatch.setattr('app.visualization.builder.subprocess.run',fail)
    response=client.post('/api/analyze',files={'video':('clip.mp4',b'fixture')})
    assert response.status_code==500
    assert list((tmp_path/'results').iterdir())==[]


def test_demo_is_explicitly_synthetic_and_static_frontend_is_served(client):
    response=client.post('/api/demo/batter')
    assert response.status_code==200,response.text
    result=response.json()
    assert result['synthetic_demo'] is True
    assert all(p['source']=='synthetic_demo' for p in result['pose'])
    assert client.get('/demo/').status_code==200
    assert client.get('/demo/vendor/three.module.js').status_code==200
    assert client.post('/api/demo/auto').status_code==422


def test_save_failure_removes_completed_visual_assets(client,monkeypatch,tmp_path,poses):
    monkeypatch.setattr('app.api.routes.extract_frames',lambda _:[(0,np.zeros((100,100,3),dtype=np.uint8))])
    monkeypatch.setattr('app.api.routes.extract_pose',lambda _:poses)
    def fail(_):
        raise OSError('simulated result save failure')
    monkeypatch.setattr('app.api.routes.save_result',fail)
    response=client.post('/api/analyze',files={'video':('clip.mp4',b'fixture')})
    assert response.status_code==500
    assert list((tmp_path/'results').iterdir())==[]
