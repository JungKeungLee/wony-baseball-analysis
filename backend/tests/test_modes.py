from pathlib import Path
from uuid import uuid4
import json
import numpy as np
import pytest
from .test_roles import client
from app.segments.vod import discovery_plan
from app.segments.detection import scan
from app.segments.jobs import defaults
from app.live.state import LiveState
from app.api.modes import LiveConfig
from app.live import sessions
from app.source.stream import validate_url

STRONG={'bat_detected':.93,'glove_detected':.95,'field_color_candidate':.4}


def test_vod_exact_approximate_center_and_auto():
    plan,segments=discovery_plan(36000,'exact','04:25:00','05:10:00',role='batter')
    assert (plan['search_start'],plan['search_end'])==(15900,18600)
    assert segments[0]['role']=='batter'
    plan,segments=discovery_plan(36000,'approximate','04:20:00','05:30:00',buffer_minutes=10)
    assert (plan['search_start'],plan['search_end'])==(15000,20400) and segments is None
    plan,_=discovery_plan(36000,'approximate',center_time='05:00:00',search_window_minutes=60)
    assert (plan['search_start'],plan['search_end'])==(16200,19800)
    assert discovery_plan(36000)[0]['search_end']==36000


@pytest.mark.parametrize('options',[{'mode':'exact'},{'mode':'exact','center_time':'01:00:00'},
    {'mode':'approximate','start':20,'end':10},{'mode':'auto','start':10},
    {'mode':'approximate','center_time':40000},{'mode':'approximate','start':-1,'end':10}])
def test_vod_invalid(options):
    with pytest.raises(ValueError):discovery_plan(36000,**options)


def test_range_scan_only_requested_window(monkeypatch):
    times=[]
    monkeypatch.setattr('app.source.file.FileSource.sample',lambda self,t:(times.append(t) or np.zeros((2,2,3),dtype=np.uint8)))
    segments,stats=scan(Path('unused'),36000,dict(defaults(),search_start=16200,search_end=19800),lambda *_:None,
                         detector=lambda _:STRONG)
    assert min(times)==16200 and max(times)<19800 and len(times)==360
    assert all(16200<=s['start']<s['end']<=19800 for s in segments)
    assert stats['search_start']==16200


def test_live_confirmation_jitter_pause_end_and_multiple_segments():
    machine=LiveState(LiveConfig().model_dump())
    assert machine.tick(0,{}) is None and machine.state=='WATCHING'
    assert machine.tick(10,STRONG) is None and machine.state=='BASEBALL_CANDIDATE'
    machine.tick(20,{})
    assert machine.state=='WATCHING'
    for t in [30,40.01,50.02]:assert machine.tick(t,STRONG) is None
    assert machine.tick(60.03,STRONG)=='analyze'
    assert machine.state=='BASEBALL_ANALYZING'
    machine.tick(100,{})
    assert machine.state=='BASEBALL_ANALYZING'
    assert machine.tick(300.04,{})=='close' and machine.state=='BASEBALL_ENDING'
    machine.finish(300.04)
    assert machine.state=='WATCHING' and len(machine.segments)==1
    for t in [400,410,420,430]:machine.tick(t,STRONG)
    assert machine.current is not None
    machine.finish(440)
    assert len(machine.segments)==2 and machine.segments[1]['start']==400
    assert any(t['state']=='REPORT_GENERATING' for t in machine.transitions)


def test_live_single_field_or_one_hit_never_activates():
    machine=LiveState(LiveConfig().model_dump())
    for t in range(0,400,10):machine.tick(t,{'field_color_candidate':.6})
    assert machine.current is None
    machine.tick(400,STRONG);machine.tick(410,{})
    assert machine.current is None
    with pytest.raises(ValueError):machine.tick(1,{})


def test_stream_url_validation_rejects_local_and_credentials(monkeypatch):
    with pytest.raises(ValueError):validate_url('file:///etc/passwd')
    with pytest.raises(ValueError):validate_url('https://user:secret@example.com/live')
    monkeypatch.setattr('app.source.stream.socket.getaddrinfo',lambda *a,**k:[(2,1,6,'',('127.0.0.1',80))])
    with pytest.raises(ValueError):validate_url('http://localhost/live')
    monkeypatch.setattr('app.source.stream.socket.getaddrinfo',lambda *a,**k:[(2,1,6,'',('8.8.8.8',443))])
    assert validate_url('https://example.com/live.m3u8').startswith('https')


class DormantThread:
    def __init__(self,*a,**k):pass
    def start(self):pass


def test_live_api_lifecycle_role_stop_unknown_config(client,monkeypatch):
    monkeypatch.setattr(sessions.threading,'Thread',DormantThread)
    monkeypatch.setattr('app.live.sessions.StreamSource',lambda _:object())
    try:
        r=client.post('/api/live',data={'source_url':'https://example.com/live','config':'{"role":"unknown"}'})
        assert r.status_code==202,r.text
        sid=r.json()['id'];assert client.get('/api/live/'+sid).json()['state']=='IDLE'
        assert client.patch('/api/live/'+sid+'/role',json={'role':'batter'}).json()['role_source']=='manual_hint'
        assert client.patch('/api/live/'+sid+'/role',json={'role':'talk'}).status_code==422
        assert client.delete('/api/live/'+sid).status_code==409
        assert client.post('/api/live/'+sid+'/stop').json()['stop_requested']
        assert client.post('/api/live',data={'source_url':'https://example.com','config':'{"ending_seconds":5}'}).status_code==422
        assert client.post('/api/live').status_code==422
    finally:sessions.RUNTIME.clear()
    assert client.get('/api/live/'+sid).json()['status']=='interrupted'
    assert client.delete('/api/live/'+sid).status_code==200


@pytest.mark.parametrize('role,signal,clip_supported,expected',[('batter',STRONG,True,2),('unknown',STRONG,True,0),('batter',{'field_color_candidate':.6},True,0),('batter',STRONG,False,0)])
def test_live_worker_common_engine_gated_and_multiple_clips(client,monkeypatch,role,signal,clip_supported,expected):
    # Accelerate only the acquisition clock; worker still executes real gating/state/report logic.
    config=LiveConfig(role=role,sample_interval=5,confirmation_seconds=10,minimum_hits=2,max_analysis_clips=2,max_session_seconds=60).model_dump()
    sid=str(uuid4());folder=sessions.root()/sid;folder.mkdir()
    session={'id':sid,'config':config,'created_at':'2026-10-12T00:00:00+00:00','status':'running','analyses':[],
        'progress':{'sampled_frames':0,'analysis_clips':0}}
    class Stop:
        def is_set(self):return False
        def wait(self,_):pass
    class Source:
        def sample(self,t):return np.zeros((2,2,3),dtype=np.uint8)
        def capture(self,path,t,d):path.write_bytes(b'clip');return t
    ticks=iter(range(0,100,5))
    monkeypatch.setattr(sessions.time,'monotonic',lambda:next(ticks))
    monkeypatch.setattr(sessions,'SignalDetector',lambda:lambda frame:signal if frame[0,0,0]==0 else {})
    class ClipSource(Source):
        def sample(self,t):return np.zeros((2,2,3),dtype=np.uint8) if clip_supported else np.ones((2,2,3),dtype=np.uint8)
    monkeypatch.setattr(sessions,'FileSource',lambda _:ClipSource())
    monkeypatch.setattr(sessions,'probe',lambda _:10)
    calls=[]
    def analyze(path,role,meta,callback):
        calls.append(role);callback('SCOUTING_REPORT');return {'id':str(uuid4()),'status':'completed'}
    monkeypatch.setattr(sessions,'analyze_clip',analyze)
    sessions.RUNTIME[sid]={'role':role,'stop':Stop()}
    sessions.run(session,Source(),None,{},Stop())
    assert session['status']=='stopped' and calls==[role]*expected
    if expected:
        assert session['baseball_segments'][0]['roles']==[role]
        assert len(session['baseball_segments'][0]['report']['analysis_ids'])==2
        assert session['baseball_segments'][0]['coverage']=='partial_budgeted'
    else:
        assert session['analyses']==[]
        assert all(segment['review_required'] for segment in session['baseball_segments'])
    assert not (folder/'active-clip.mp4').exists()


def test_vod_endpoint_range_validation_before_job(client,monkeypatch):
    from app.segments import jobs
    monkeypatch.setattr(jobs,'probe',lambda _:36000)
    assert client.post('/api/vod',data={'mode':'exact'},files={'video':('v',b'x')}).status_code==422
    assert client.post('/api/vod',data={'mode':'approximate','center_time':'99:00:00'},files={'video':('v',b'x')}).status_code==422
