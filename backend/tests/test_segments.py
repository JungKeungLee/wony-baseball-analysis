import json
import subprocess
from uuid import uuid4
import numpy as np
import pytest
from .test_roles import client
from app.segments.detection import seconds, evidence, merge_samples, manual_segments, scan
from app.segments import jobs


def test_multisignal_gate_never_accepts_field_ball_or_single_object():
    for signals in [{'field_color_candidate':.6},{'sports_ball_candidate':.99},
                    {'bat_detected':.99,'field_color_candidate':.6}, {'bat_detected':.9,'glove_detected':.9}]:
        assert not evidence(signals)[1]
    assert evidence({'bat_detected':.91,'glove_detected':.94,'field_color_candidate':.4})==(.91,True)


def test_merge_gap_buffer_clamp_and_confidence_partition():
    signals={'bat_detected':.91,'glove_detected':.95,'field_color_candidate':.4}
    samples=[{'timestamp':t,'signals':signals} for t in [10,20,40]]
    segments=merge_samples(samples,60,10,gap=10,buffer=10)
    assert len(segments)==1 and segments[0]['start']==0 and segments[0]['end']==55
    assert segments[0]['role']=='unknown' and not segments[0]['review_required']
    samples.append({'timestamp':50,'signals':{'field_color_candidate':.4}})
    assert len(merge_samples(samples,60,10))==2


@pytest.mark.parametrize('items',[[{'start':-1,'end':10}],[{'start':0,'end':61}],
    [{'start':1,'end':1}],[{'start':0,'end':2,'role':'talk'}],
    [{'start':0,'end':5},{'start':4,'end':8}],[{'start':True,'end':2}]])
def test_manual_invalid(items):
    with pytest.raises((ValueError,TypeError)):manual_segments(items,60)


def test_manual_timestamps_and_roles():
    s=manual_segments([{'start':'03:05:00','end':'04:02:00','role':'batter'}],20000)[0]
    assert s['start']==11100 and s['end']==14520 and s['confidence'] is None
    assert not s['review_required'] and s['source']=='manual'
    with pytest.raises(ValueError):seconds('01:60:00')


def test_bounded_scan_no_pose_and_single_signal_review(tmp_path,monkeypatch):
    import cv2
    ok,encoded=cv2.imencode('.jpg',np.zeros((12,12,3),dtype=np.uint8))
    calls=[]
    def ffmpeg(args,**kwargs):
        calls.append(args)
        class Result:stdout=encoded.tobytes()
        return Result()
    monkeypatch.setattr('app.segments.detection.subprocess.run',ffmpeg)
    segments,stats=scan(tmp_path/'fake',36000,jobs.defaults(max_scan_frames=8),lambda *_:None,
                        detector=lambda _:{'field_color_candidate':.5})
    assert len(calls)<=8 and stats['effective_interval']>10
    assert all(s['review_required'] for s in segments)
    assert all('-frames:v' in args for args in calls)


class ImmediateThread:
    def __init__(self,target,args,**kwargs):self.target=target;self.args=args
    def start(self):self.target(*self.args)


def test_auto_and_unknown_never_call_engine_and_correction_bounds(client,monkeypatch):
    monkeypatch.setattr(jobs,'probe',lambda _:100)
    monkeypatch.setattr(jobs.threading,'Thread',ImmediateThread)
    monkeypatch.setattr(jobs,'scan',lambda *_:([{'id':'s1','start':10,'end':20,'core_start':10,'core_end':20,
        'duration':10,'review_required':True,'role':'unknown','role_confidence':0,'source':'automatic'}],{}))
    monkeypatch.setattr('app.api.routes.process_frames',lambda *_,**__:pytest.fail('Non-baseball/unknown must not enter engine'))
    r=client.post('/api/analyze',data={'mode':'auto_segments'},files={'video':('long.mp4',b'video')})
    assert r.status_code==202,r.text
    job=client.get('/api/broadcasts/'+r.json()['id']).json()
    assert job['status']=='completed' and job['analyses']==[] and job['review_required']
    assert job['stage_history']==['SCAN','BASEBALL_SEGMENT_DETECTION','COMPLETE']
    bad=client.post(f"/api/broadcasts/{job['id']}/segments",json={'segments':[{'start':1,'end':101,'role':'batter'}]})
    assert bad.status_code==422
    good=client.post(f"/api/broadcasts/{job['id']}/segments",json={'segments':[{'start':1,'end':20,'role':'unknown'}]})
    assert good.status_code==202 and good.json()['analyses']==[]
    assert client.get(job['source_url']).content==b'video'
    assert client.delete(f"/api/broadcasts/{job['id']}").status_code==200
    assert client.get(f"/api/broadcasts/{job['id']}").status_code==404


def test_manual_only_selected_core_bounded_analysis_and_offsets(client,monkeypatch):
    monkeypatch.setattr(jobs,'probe',lambda _:100)
    monkeypatch.setattr(jobs.threading,'Thread',ImmediateThread)
    monkeypatch.setattr(jobs,'scan',lambda *_:pytest.fail('Manual segments must bypass scan'))
    extracted=[]
    def ffmpeg(args,**kwargs):extracted.append((float(args[args.index('-ss')+1]),float(args[args.index('-t')+1])))
    monkeypatch.setattr(jobs.subprocess,'run',ffmpeg)
    monkeypatch.setattr('app.video.frames.extract_frames',lambda _:[(0,np.zeros((8,8,3)))])
    monkeypatch.setattr('app.pose.extractor.extract_pose',lambda _:[])
    def process(*args,**kwargs):
        kwargs['stage_callback']('ROLE_ANALYSIS');kwargs['stage_callback']('SCOUTING_REPORT')
        return {'id':str(uuid4()),'status':'insufficient_pose'}
    monkeypatch.setattr('app.api.routes.process_frames',process)
    response=client.post('/api/broadcasts',data={'segments':json.dumps([{'start':20,'end':80,'role':'defense'}]),
        'max_analysis_clips':2,'clip_seconds':10},files={'video':('long.mp4',b'video')})
    assert response.status_code==202,response.text
    job=client.get('/api/broadcasts/'+response.json()['id']).json()
    assert job['status']=='completed' and extracted==[(20,10),(30,10)]
    assert job['baseball_segments'][0]['coverage']=='partial_budgeted'
    assert job['analyses'][0]['broadcast_offset_seconds']==20
    assert all(stage in job['stage_history'] for stage in jobs.STAGES[1:])
    assert job['review_required']


def test_failure_progress_demo_and_invalid_config(client,monkeypatch):
    monkeypatch.setattr(jobs,'probe',lambda _:100)
    monkeypatch.setattr(jobs.threading,'Thread',ImmediateThread)
    def fail(*_):raise RuntimeError('decoder failed')
    monkeypatch.setattr(jobs,'scan',fail)
    r=client.post('/api/broadcasts',files={'video':('video.mp4',b'video')})
    assert client.get('/api/broadcasts/'+r.json()['id']).json()['status']=='failed'
    assert not jobs.ACTIVE
    assert client.post('/api/broadcasts',data={'sample_interval':0},files={'video':('x',b'x')}).status_code==422
    demo=client.get('/api/broadcast-demo').json()
    assert demo['synthetic_demo'] and demo['analyses']==[]
