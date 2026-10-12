"""Single-process bounded background jobs; disk snapshots, retained source for correction."""
import json
import os
import shutil
import subprocess
import threading
from copy import deepcopy
from datetime import datetime, timezone
from uuid import uuid4
from pathlib import Path
from fastapi import HTTPException
from app.models.storage import data_dir
from app.segments.detection import probe, scan, manual_segments

LOCK=threading.Lock()
ACTIVE=set()
STAGES=['SCAN','BASEBALL_SEGMENT_DETECTION','SEGMENT_EXTRACTION','ROLE_ANALYSIS','POSE_ANALYSIS','SCOUTING_REPORT','COMPLETE']


def root():
    p=data_dir()/'broadcasts';p.mkdir(exist_ok=True);return p


def load(job_id):
    p=root()/str(job_id)/'job.json'
    if not p.exists(): raise HTTPException(404,'Broadcast job not found')
    with LOCK:
        job=json.loads(p.read_text(encoding='utf-8'))
    if job['status'] in ['queued','running'] and str(job_id) not in ACTIVE:
        job.update(status='interrupted',error='Worker stopped; source retained for manual correction')
    return job


def persist(job):
    with LOCK:
        p=root()/job['id']/'job.json';temp=p.with_suffix('.tmp')
        temp.write_text(json.dumps(job,allow_nan=False),encoding='utf-8');temp.replace(p)
        if job['status'] in {'completed','failed'}:ACTIVE.discard(job['id'])


def update(job,stage,**values):
    job.update(stage=stage,**values)
    if not job['stage_history'] or job['stage_history'][-1]!=stage:
        job['stage_history'].append(stage)
    persist(job)


def create(path,config,segments=None,metadata=None,vod_options=None):
    remote=isinstance(path,dict)
    if remote:
        from app.source.remote import open_remote
        with open_remote(path['url']) as source:duration=probe(source.path)
    else:duration=probe(path)
    selected=manual_segments(segments,duration) if segments is not None else None
    discovery=None
    if vod_options is not None:
        from app.segments.vod import discovery_plan
        discovery,selected=discovery_plan(duration,**vod_options)
        config=dict(config,search_start=discovery['search_start'],search_end=discovery['search_end'])
    job_id=str(uuid4());folder=root()/job_id;folder.mkdir()
    if remote:
        descriptor=folder/'remote.json'
        descriptor.write_text(json.dumps(path),encoding='utf-8')
        descriptor.chmod(0o600)
    else:shutil.move(str(path),str(folder/'source.upload'))
    job={'id':job_id,'status':'queued','stage':'SCAN','stage_history':[], 'progress':{'current':0,'total':None},
         'video_duration':duration,'baseball_segments':selected or [],'config':config,'analyses':[],
         'created_at':datetime.now(timezone.utc).isoformat(),'source_url':None if remote else f'/api/broadcasts/{job_id}/source',
         'discovery':discovery,'input_mode':'vod','synthetic_demo':False,'metadata':metadata or {},'warnings':[
             'Only confirmed segments enter bounded pose classification; ambiguous roles do not receive scouting evaluations. Buffers may contain adjacent non-baseball content.',
             'Bounded clip coverage is explicit; this is not exhaustive play detection. Single subject/action engine limitations remain.',
             'Uploaded sources are retained; URL inputs retain a private descriptor and processed clips only. Corrections require a valid URL; derived analyses have separate retention.']}
    with LOCK:
        if ACTIVE:
            shutil.rmtree(folder)
            raise HTTPException(503, 'A broadcast job is already running')
        ACTIVE.add(job_id)
    persist(job)
    snapshot=deepcopy(job)
    threading.Thread(target=run,args=(job,selected is None),daemon=True).start()
    return snapshot


def restart(job_id,items):
    if ACTIVE: raise HTTPException(409,'A broadcast job is still running')
    job=load(job_id)
    if job.get('synthetic_demo'):raise HTTPException(422,'DEMO has no source; upload a real video')
    selected=manual_segments(items,job['video_duration'])
    job.update(baseball_segments=selected,status='queued',analyses=[],stage_history=[],error=None)
    with LOCK:
        if ACTIVE:raise HTTPException(409, 'A broadcast job is already running')
        ACTIVE.add(str(job_id))
    persist(job)
    snapshot=deepcopy(job)
    threading.Thread(target=run,args=(job,False),daemon=True).start()
    return snapshot


def run(job,do_scan):
    from app.source.file import FileSource
    from app.segments.execution import analyze_clip
    path=root()/job['id']/'source.upload'
    from contextlib import ExitStack
    resources=ExitStack()
    try:
        remote=root()/job['id']/'remote.json'
        if remote.exists():
            from app.source.remote import open_remote
            source=resources.enter_context(open_remote(json.loads(remote.read_text(encoding='utf-8'))['url']))
            path=source.path
        else:source=FileSource(path)
        job['status']='running'
        if do_scan:
            update(job,'SCAN')
            segments,stats=scan(path,job['video_duration'],job['config'],lambda n,total:update(job,'SCAN',progress={'current':n,'total':total}))
            job.update(baseball_segments=segments,scan=stats)
        update(job,'BASEBALL_SEGMENT_DETECTION')
        config=job['config'];plans=[]
        for segment in job['baseball_segments']:
            segment['role_segments']=[] if segment['role']=='unknown' else [{'start':segment['start'],'end':segment['end'],'role':segment['role'],
                'confidence':segment['role_confidence'],'estimated':True,'source':segment['source']}]
            if segment['review_required']:
                segment['analysis_status']='review_required';continue
            segment['analysis_status']='planned'
            cursor=segment['start']
            while cursor < segment['end'] and len(plans)<config['max_analysis_clips']:
                end=min(segment['end'],cursor+config['clip_seconds'])
                # Buffers are preview context only: do not analyze outside confirmed core bounds.
                start=max(cursor,segment['core_start']);end=min(end,segment['core_end'])
                if end>start:plans.append((segment,start,end))
                cursor+=config['clip_seconds']
            segment['coverage']='partial_budgeted' if cursor < segment['end'] else 'all_selected_clips'
        job['planned_clips']=len(plans)
        for index,(segment,start,end) in enumerate(plans):
            update(job,'SEGMENT_EXTRACTION',progress={'current':index,'total':len(plans)})
            clip=root()/job['id']/f'clip-{index}.mp4'
            try:
                source.capture(clip,start,end-start)
                result=analyze_clip(clip,segment['role'],job['metadata'],lambda stage:update(job,stage))
                inferred=result.get('role',segment['role'])
                segment['role_segments'].append({'start':start,'end':end,'role':inferred,
                    'confidence':result.get('role_estimate',{}).get('confidence'), 'estimated':True,'source':'automatic' if segment['role']=='unknown' else 'manual'})
                if inferred=='unknown':
                    segment['role_selection_required']=True
                    segment['analysis_status']='review_required'
                    persist(job);continue
                if segment['role']=='unknown':segment['role_confidence']=result.get('role_estimate',{}).get('confidence')
                job['analyses'].append({'segment_id':segment['id'],'start':start,'end':end,'role':inferred,
                    'analysis_id':result['id'],'analysis_url':f"/api/analysis/{result['id']}", 'status':result['status'],
                    'timestamp_origin':'clip_relative','broadcast_offset_seconds':start})
                if remote.exists():
                    assets=data_dir()/f"{result['id']}-assets"
                    if assets.is_dir():
                        shutil.copyfile(clip,assets/'original.mp4')
                        job['analyses'][-1].update(source_url=f"/api/analysis/{result['id']}/assets/original.mp4",source_start=0)
                if not segment.get('role_selection_required'):segment['analysis_status']='analyzed'
                roles={a['role'] for a in job['analyses'] if a['segment_id']==segment['id']}
                if len(roles)==1:segment['display_role']=next(iter(roles))
                persist(job)
            finally:clip.unlink(missing_ok=True)
        for segment in job['baseball_segments']:
            roles={a['role'] for a in job['analyses'] if a['segment_id']==segment['id']}
            if len(roles)==1 and segment.get('analysis_status')!='review_required':segment['role']=next(iter(roles))
        needs_review=any(s['analysis_status']=='review_required' or s.get('coverage')=='partial_budgeted' for s in job['baseball_segments'])
        resources.close()
        update(job,'COMPLETE',status='completed',review_required=needs_review,progress={'current':len(plans),'total':len(plans)})
    except Exception:
        import logging
        logging.getLogger(__name__).exception('Broadcast job failed: %s',job['id'])
        resources.close()
        update(job,'FAILED',status='failed',error='Scan/extraction/analysis failed; partial results and retained source remain available')
    finally:
        resources.close()
        if job['status'] not in {'completed','failed'}:ACTIVE.discard(job['id'])


def defaults(sample_interval=10,merge_gap=20,buffer=10,threshold=.8,max_scan_frames=10000,max_analysis_clips=20,clip_seconds=10):
    return dict(sample_interval=sample_interval,merge_gap=merge_gap,buffer=buffer,threshold=threshold,
                max_scan_frames=max_scan_frames,max_analysis_clips=max_analysis_clips,clip_seconds=clip_seconds)
