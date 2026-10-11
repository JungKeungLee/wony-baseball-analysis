"""Synthetic fixtures test plumbing/heuristic gates, not real baseball accuracy."""
import copy
import json
import subprocess
import threading
from contextlib import contextmanager
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from functools import partial
from pathlib import Path
from uuid import uuid4
import numpy as np
import pytest
from .test_roles import client, poses
from app.analysis.shared.role_classifier import classify_role
from app.analysis.engine import analyze_role
from app.segments.detection import evidence, probe, scan
from app.segments.jobs import defaults
from app.source.remote import open_remote, source_kind


def swing_poses(poses):
    frames=copy.deepcopy(poses)
    for i,sample in enumerate(frames):
        p=sample['landmarks'];x=.3+i*.065
        p[15].update(x=x,y=.45);p[16].update(x=x+.05,y=.46)
        p[23]['x']=.4;p[24]['x']=.6
    return frames


def test_auto_temporal_swing_routes_existing_engine(poses):
    frames=swing_poses(poses)
    r=analyze_role(frames,'auto')
    assert r['role']=='batter' and r['requested_role']=='auto'
    assert r['role_estimate']['estimated'] and .7<=r['role_estimate']['confidence']<.9
    assert r['events'] and r['metrics'] and r['status']=='completed'


def test_single_frame_static_and_occluded_stay_unknown(poses):
    assert classify_role(poses[:1])['value']=='unknown'
    static=[dict(copy.deepcopy(poses[0]),time_seconds=i*.1) for i in range(8)]
    assert classify_role(static)['value']=='unknown'
    frames=swing_poses(poses)
    frames[3]['landmarks'][15]['visibility']=.1
    frames=frames[:4]
    assert classify_role(frames)['value']=='unknown'


def test_context_affects_role_confidence_and_candidates(poses):
    samples=swing_poses(poses)
    plain=classify_role(samples);context=classify_role(samples,{'bat_detected':.95})
    assert context['confidence']>plain['confidence']
    assert {c['role'] for c in context['candidates']}=={'batter','defense','catcher','pitcher','baserunning'}
    json.dumps(context,allow_nan=False)


@pytest.mark.parametrize('signals',[
    {'field_color_candidate':.6}, {'batter_motion':.9}, {'scoreboard_detected':.95},
    {'sports_ball_candidate':.99,'field_color_candidate':.5},
    {'batter_motion':.9,'field_color_candidate':.5},
])
def test_single_or_generic_signals_never_confirm(signals):
    assert not evidence(signals)[1]


def test_live_motion_object_context_can_confirm_without_both_objects():
    assert evidence({'pitcher_motion':.81,'glove_detected':.95,'field_color_candidate':.4})[1]
    assert evidence({'batter_motion':.8,'bat_detected':.9,'baseball_ui':.9})[1]
    assert not evidence({'pitcher_motion':.81,'glove_detected':.95})[1]


def test_url_contract_and_platform_page_rejection(client,monkeypatch):
    monkeypatch.setattr('app.source.remote.validate_url',lambda x:x)
    assert source_kind('https://example.com/video.mp4?token=test')=='mp4'
    assert source_kind('https://example.com/archive.m3u8')=='hls'
    with pytest.raises(ValueError,match='provider adapter'):source_kind('https://example.com/watch/123')
    assert client.post('/api/vod').status_code==422
    assert client.post('/api/vod',data={'source_url':'https://example.com/a.mp4'},files={'video':('v.mp4',b'v')}).status_code==422
    assert client.post('/api/vod',data={'source_url':'https://example.com/watch/123'}).status_code==422


def test_vod_url_approximate_passes_plan_without_upload(client,monkeypatch):
    monkeypatch.setattr('app.source.remote.source_kind',lambda x:'mp4')
    seen={}
    def create(path,config,segments,metadata,options):
        seen.update(path=path,options=options)
        return {'id':str(uuid4()),'status':'queued'}
    monkeypatch.setattr('app.segments.jobs.create',create)
    response=client.post('/api/vod',data={'source_url':'https://example.com/v.mp4','mode':'approximate',
        'center_time':'05:00:00','search_window_minutes':60,'role':'auto'})
    assert response.status_code==202
    assert seen['path']=={'url':'https://example.com/v.mp4'}
    assert seen['options']['center_time']=='05:00:00' and seen['options']['role']=='unknown'


@contextmanager
def fixture_server(directory):
    class Quiet(SimpleHTTPRequestHandler):
        def log_message(self,*args):pass
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(Quiet,directory=str(directory)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    try:yield f'http://127.0.0.1:{server.server_port}'
    finally:server.shutdown();server.server_close()


@pytest.mark.parametrize('kind',['mp4','hls'])
def test_real_ffmpeg_remote_probe_seek_scan_and_clip(tmp_path,monkeypatch,kind):
    # Localhost is permitted ONLY in this isolated integration fixture.
    monkeypatch.setattr('app.source.remote.validate_url',lambda x:x)
    monkeypatch.setattr('app.source.remote.pinned_request',lambda client,url,headers:client.build_request('GET',url,headers=headers))
    mp4=tmp_path/'video.mp4'
    subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i','color=c=black:s=160x120:r=10',
        '-t','8','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-movflags','+faststart',str(mp4)],check=True)
    if kind=='hls':
        subprocess.run(['ffmpeg','-v','error','-y','-i',str(mp4),'-c','copy','-hls_time','2',
            '-hls_playlist_type','vod',str(tmp_path/'archive.m3u8')],check=True)
    with fixture_server(tmp_path) as base:
        with open_remote(base+('/video.mp4' if kind=='mp4' else '/archive.m3u8')) as source:
            duration=probe(source.path);assert 7.9<=duration<=8.1
            timestamps=[]
            original=source.sample
            def sample(t):timestamps.append(t);return original(t)
            # scan uses FileSource against the same validated gateway URL.
            from app.source.file import FileSource
            previous=FileSource.sample
            def traced(self,t):timestamps.append(t);return previous(self,t)
            monkeypatch.setattr(FileSource,'sample',traced)
            _,stats=scan(source.path,duration,dict(defaults(),search_start=2,search_end=6),lambda *_:None,lambda _:{})
            assert timestamps==[2] and stats['search_start']==2 and stats['search_end']==6
            clip=tmp_path/'clip.mp4';assert source.capture(clip,3,2)==3
            assert 1.9<=probe(clip)<=2.1


def test_gateway_rejects_private_redirect_before_fetch(monkeypatch,tmp_path):
    import httpx
    from app.source.remote import Gateway
    calls=[]
    def validate(url):
        if '127.0.0.2' in url:raise ValueError('private')
        return url
    monkeypatch.setattr('app.source.remote.validate_url',validate)
    monkeypatch.setattr('app.source.remote.pinned_request',lambda client,url,headers:client.build_request('GET',url,headers=headers))
    original=httpx.Client.send
    def send(self,request,*args,**kwargs):
        if request.url.host=='example.com':
            calls.append(str(request.url))
            return httpx.Response(302,headers={'Location':'http://127.0.0.2/secret'},request=request)
        return original(self,request,*args,**kwargs)
    monkeypatch.setattr(httpx.Client,'send',send)
    with Gateway('https://example.com/v.mp4') as gateway:
        assert httpx.get(gateway.url,trust_env=False).status_code==502
    assert len(calls)==1

@pytest.mark.parametrize('role',['batter','pitcher','catcher','defense','baserunning'])
def test_all_roles_temporal_signatures(poses,role):
    samples=copy.deepcopy(poses)
    for i,sample in enumerate(samples):
        p=sample['landmarks'];p[23].update(x=.4,y=.6);p[24].update(x=.6,y=.6)
        if role=='batter':
            p[15].update(x=.3+i*.065,y=.45);p[16].update(x=.35+i*.065,y=.46)
        elif role=='pitcher':
            p[15].update(x=.35,y=.2)
            p[16].update(x=.6+i*.04,y=.1+i*.08);p[25].update(y=.5);p[26].update(y=.75)
        elif role=='catcher':
            p[25].update(x=.15,y=.65);p[26].update(x=.85,y=.65);p[27].update(x=.35,y=.9);p[28].update(x=.65,y=.9)
            p[15].update(x=.4+i*.01,y=.7);p[16].update(x=.6+i*.01,y=.7)
        elif role=='defense':
            for k in [0,11,12,13,14,15,16,23,24,25,26,27,28]:p[k]['x']+=i*.04
            p[25].update(x=.15+i*.04,y=.7);p[26].update(x=.85+i*.04,y=.7)
        else:
            for k in [0,11,12,13,14,15,16,23,24,25,26,27,28]:p[k]['x']+=i*.08
            p[27]['y']=.9+(.08 if i%2 else -.08);p[28]['y']=.9-(.08 if i%2 else -.08)
    result=classify_role(samples)
    assert result['value']==role and result['estimated'] and result['confidence']>=.7


def test_dns_connection_is_pinned_and_tls_name_preserved(monkeypatch):
    import httpx
    from app.source.remote import pinned_request
    monkeypatch.setattr('app.source.remote.validate_url',lambda x:x)
    monkeypatch.setattr('app.source.remote.socket.getaddrinfo',lambda *a,**kw:[(2,1,6,'',('93.184.216.34',443))])
    with httpx.Client() as client:
        request=pinned_request(client,'https://example.com/v.mp4?token=test',{})
    assert request.url.host=='93.184.216.34' and request.headers['host']=='example.com'
    assert request.extensions['sni_hostname']=='example.com'
    monkeypatch.setattr('app.source.remote.socket.getaddrinfo',lambda *a,**kw:[(2,1,6,'',('127.0.0.1',443))])
    with httpx.Client() as client,pytest.raises(ValueError):pinned_request(client,'https://example.com/v.mp4',{})

@pytest.mark.parametrize('kind',['mp4','hls'])
def test_url_vod_end_to_end_report_assets_and_correction(client,tmp_path,monkeypatch,poses,kind):
    import time
    from app.segments import jobs
    monkeypatch.setattr('app.source.remote.validate_url',lambda x:x)
    monkeypatch.setattr('app.source.remote.pinned_request',lambda client,url,headers:client.build_request('GET',url,headers=headers))
    # Synthetic landmarks exercise classification and existing metrics/visualization
    # atop an actual remotely fetched, decoded clip. Not an accuracy benchmark.
    monkeypatch.setattr('app.pose.extractor.extract_pose',lambda _:swing_poses(poses))
    mp4=tmp_path/'video.mp4'
    subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i','color=c=black:s=160x120:r=10',
        '-t','8','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-movflags','+faststart',str(mp4)],check=True)
    if kind=='hls':subprocess.run(['ffmpeg','-v','error','-y','-i',str(mp4),'-c','copy','-hls_playlist_type','vod',str(tmp_path/'archive.m3u8')],check=True)
    with fixture_server(tmp_path) as base:
        response=client.post('/api/vod',data={'source_url':base+('/video.mp4' if kind=='mp4' else '/archive.m3u8'),
            'mode':'exact','start':'00:00:01','end':'00:00:03','role':'auto','max_analysis_clips':1})
        assert response.status_code==202,response.text
        identifier=response.json()['id']
        def completed():
            for _ in range(150):
                job=client.get('/api/broadcasts/'+identifier).json()
                if job['status'] not in ('queued','running'):return job
                time.sleep(.05)
            pytest.fail('Remote job did not finish')
        job=completed();assert job['status']=='completed',job
        assert job['baseball_segments'][0]['role']=='batter' and len(job['analyses'])==1
        assert job['analyses'][0]['start']==1 and job['analyses'][0]['end']==3
        assert not (jobs.root()/identifier/'source.upload').exists()
        report=client.get('/api/reports/'+identifier).json();entry=report['entries'][0]
        assert entry['source_start']==0 and entry['start']==1
        assert entry['analysis']['role_estimate']['confidence']>=.7
        assert entry['analysis']['visualization']['pose3d']['estimated']
        assert client.get(entry['source_url']).status_code==200
        serialized=json.dumps(report)
        assert base not in serialized and 'remote.json' not in serialized
        corrected=client.post('/api/broadcasts/'+identifier+'/segments',json={'segments':[{'start':4,'end':6,'role':'auto'}]})
        assert corrected.status_code==202
        job=completed();assert job['status']=='completed' and job['analyses'][0]['start']==4


def test_sparse_pose_plus_bat_field_activates_without_glove(poses):
    from types import SimpleNamespace
    from app.segments.detection import SignalDetector
    class Net:
        def setInput(self,_):pass
        def forward(self):
            output=np.zeros((1,84,1),dtype=np.float32);output[0,4+34,0]=.95;return output
    samples=iter(swing_poses(poses))
    class Pose:
        def process(self,_):
            p=next(samples)['landmarks']
            return SimpleNamespace(pose_landmarks=SimpleNamespace(landmark=[SimpleNamespace(**item) for item in p]))
        def close(self):pass
    detector=SignalDetector();detector.net=Net();detector.pose=Pose()
    frame=np.zeros((100,100,3),dtype=np.uint8);frame[:,:,1]=255
    results=[detector(frame) for _ in range(8)]
    assert results[-1]['batter_motion']>=.7
    assert results[-1]['bat_detected']>=.9 and results[-1]['glove_detected']==0
    assert evidence(results[-1])[1]
    assert not evidence(results[0])[1]
    detector.close()


def test_scene_model_contract_and_single_scene_rejection():
    from app.segments.detection import SignalDetector
    class Scene:
        def setInput(self,_):pass
        def forward(self):return np.array([[[0],[0],[0],[0],[.9],[.95],[.92]]],dtype=np.float32)
    detector=SignalDetector(enable_pose=False);detector.scene=Scene()
    signals=detector(np.zeros((100,100,3),dtype=np.uint8))
    assert signals['field_detected']>.8 and signals['baseball_ui']>.8
    assert not evidence(signals)[1]
    signals['batter_motion']=.8
    assert evidence(signals)[1]
