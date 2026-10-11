"""Provider-independent watch worker, bounded acquisition, common analysis bridge."""
import json
import threading
import time
from copy import deepcopy
from datetime import datetime,timezone,timedelta
from uuid import uuid4
from fastapi import HTTPException
from app.models.storage import data_dir
from app.live.state import LiveState
from app.segments.detection import SignalDetector,probe,evidence
from app.source.file import FileSource
from app.source.stream import StreamSource
from app.segments.execution import analyze_clip

RUNTIME={};LOCK=threading.Lock()


def root():
    p=data_dir()/'live';p.mkdir(exist_ok=True);return p


def persist(session):
    with LOCK:
        path=root()/session['id']/'session.json';tmp=path.with_suffix('.tmp')
        tmp.write_text(json.dumps(session,allow_nan=False),encoding='utf-8');tmp.replace(path)


def load(session_id):
    path=root()/str(session_id)/'session.json'
    if not path.exists():raise HTTPException(404,'Live session not found')
    with LOCK:session=json.loads(path.read_text())
    if session['status']=='running' and str(session_id) not in RUNTIME:
        session.update(status='interrupted',error='Worker stopped; automatic reconnect/resume is not implemented')
    return session


def start(config,url=None,path=None,metadata=None):
    source=StreamSource(url) if url else FileSource(path)
    duration=probe(path) if path else None
    session_id=str(uuid4());folder=root()/session_id
    with LOCK:
        if RUNTIME:raise HTTPException(503,'One live session at a time')
        stop=threading.Event();RUNTIME[session_id]={'stop':stop,'role':config['role']}
    folder.mkdir()
    if path:
        import shutil
        shutil.move(str(path),str(folder/'source.upload'));source=FileSource(folder/'source.upload')
    session={'id':session_id,'status':'running','state':'IDLE','input_mode':'live','source_type':'stream' if url else 'file_replay',
        'created_at':datetime.now(timezone.utc).isoformat(),'elapsed_seconds':0,'confidence':0,'estimated':True,
        'role':config['role'],'role_source':'manual_hint' if config['role']!='unknown' else 'unknown',
        'baseball_segments':[],'current_segment':None,'transitions':[],'analyses':[], 'config':config,'metadata':metadata or {},
        'progress':{'sampled_frames':0,'analysis_clips':0},'synthetic_demo':False,
        'warnings':['Confidence is heuristic. Color-only candidates never activate detailed analysis.',
            'Role is unknown or an operator hint, not automatic role classification.',
            'Stream sampling/capture reconnect independently and source timestamps are approximate session elapsed seconds.',
            'No platform-specific adapter. Redirects/manifests require network egress controls before public deployment.',
            'Analysis coverage is bounded. Unknown role, weak evidence and silent ending grace do not run pose/scouting.']}
    persist(session);snapshot=deepcopy(session)
    threading.Thread(target=run,args=(session,source,duration,metadata or {},stop),daemon=True).start()
    return snapshot


def attach(session,machine):
    session.update(state=machine.state,confidence=machine.confidence,current_segment=deepcopy(machine.current),
                   baseball_segments=deepcopy(machine.segments),transitions=deepcopy(machine.transitions))
    origin=datetime.fromisoformat(session['created_at'])
    for segment in session['baseball_segments']+([session['current_segment']] if session['current_segment'] else []):
        segment['start_datetime']=(origin+timedelta(seconds=segment['start'])).isoformat()
        if 'end' in segment:segment['end_datetime']=(origin+timedelta(seconds=segment['end'])).isoformat()


def close_segment(session,machine,t):
    if machine.current:
        machine.change('BASEBALL_ENDING',t);attach(session,machine);persist(session)
        machine.change('REPORT_GENERATING',t)
        segment=machine.current
        # Reuse the reports already produced by the engine, never invent LIVE scores.
        segment['report']={'analysis_ids':[a['analysis_id'] for a in segment['analyses']],
            'ratings':{r:None for r in ['batting','defense','catching','pitching','baserunning']},
            'summary':'Video-based observations only; consult each referenced scouting_report', 'estimated':True}
        attach(session,machine);persist(session)
        machine.finish(t);attach(session,machine);persist(session)


def run(session,source,duration,metadata,stop):
    machine=LiveState(session['config']);config=session['config'];started=time.monotonic();failures=0
    try:
        detector=SignalDetector()
        while not stop.is_set():
            t=time.monotonic()-started
            if t>=config['max_session_seconds'] or (duration is not None and t>=duration):break
            frame=None
            try:
                frame=source.sample(t);signals=detector(frame);failures=0
            except Exception:
                signals={};failures+=1
            session['elapsed_seconds']=t;session['progress']['sampled_frames']+=1
            action=machine.tick(t,signals)
            with LOCK:role=RUNTIME[session['id']]['role']
            session['role']=role;session['role_source']='manual_hint' if role!='unknown' else 'unknown'
            attach(session,machine);persist(session)
            if action=='close':close_segment(session,machine,t)
            elif action=='analyze' and role!='unknown' and session['progress']['analysis_clips']<config['max_analysis_clips']:
                clip=root()/session['id']/'active-clip.mp4'
                try:
                    length=min(config['clip_seconds'],duration-t) if duration is not None else config['clip_seconds']
                    offset=source.capture(clip,t,length)
                    # The captured clip can differ from the watch frame. Recheck before any pose.
                    captured=FileSource(clip);actual_duration=min(length,probe(clip))
                    check_times=list(range(0,max(1,int(actual_duration)),5))+[max(0,actual_duration-.1)]
                    supported=all(evidence(detector(captured.sample(moment)),config['threshold'])[1] for moment in check_times)
                    if supported and not stop.is_set():
                        result=analyze_clip(clip,role,metadata,lambda stage:record_stage(session,stage))
                        reference={'analysis_id':result['id'],'analysis_url':f"/api/analysis/{result['id']}",
                            'start':offset,'end':offset+actual_duration,'role':role,'role_source':'manual_hint',
                            'status':result['status'],'timestamp_origin':'clip_relative','broadcast_offset_seconds':offset}
                        machine.current['analyses'].append(reference);session['analyses'].append(reference)
                        if role not in machine.current['roles']:machine.current['roles'].append(role)
                        session['progress']['analysis_clips']+=1;machine.current['review_required']=False
                        machine.last_hit=offset+actual_duration;machine.current['last_signal']=machine.last_hit
                finally:clip.unlink(missing_ok=True)
            if machine.current and session['progress']['analysis_clips']>=config['max_analysis_clips']:
                machine.current['coverage']='partial_budgeted';machine.current['review_required']=True
            if failures>=6:raise RuntimeError('Repeated source acquisition failures')
            attach(session,machine);persist(session)
            # Stop remains responsive during wait. Subprocess operations have bounded timeouts.
            stop.wait(config['sample_interval'])
        close_segment(session,machine,time.monotonic()-started)
        session.update(status='stopped',stage='COMPLETE');persist(session)
    except Exception:
        close_segment(session,machine,time.monotonic()-started)
        session.update(status='failed',error='Stream acquisition or analysis failed; completed results remain available');persist(session)
    finally:
        with LOCK:RUNTIME.pop(session['id'],None)


def record_stage(session,stage):
    session['analysis_stage']=stage;persist(session)


def stop_session(session_id):
    session=load(session_id)
    with LOCK:
        runtime=RUNTIME.get(str(session_id))
        if runtime:runtime['stop'].set()
    return {'id':str(session_id),'stop_requested':bool(runtime),'status':session['status']}


def set_role(session_id,role):
    load(session_id)
    with LOCK:
        if str(session_id) not in RUNTIME:raise HTTPException(409,'Session is not running')
        RUNTIME[str(session_id)]['role']=role
    return {'role':role,'role_source':'manual_hint' if role!='unknown' else 'unknown'}
