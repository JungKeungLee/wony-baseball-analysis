import json
import os
import shutil
import threading
from uuid import UUID,uuid4
from fastapi import APIRouter, File, Form, UploadFile, HTTPException
from fastapi.responses import FileResponse,JSONResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool
from app.segments import jobs
from app.video.frames import InvalidVideo

router=APIRouter()
UPLOAD_GATE=threading.Lock()


async def submit(video,config,segments=None,metadata=None,vod_options=None):
    if not UPLOAD_GATE.acquire(blocking=False):raise HTTPException(503,'Another broadcast upload is running')
    if jobs.ACTIVE:
        UPLOAD_GATE.release()
        raise HTTPException(503,'One broadcast job at a time; retry later')
    path=jobs.root()/f'{uuid4()}.upload'
    try:
        limit=int(os.getenv('WONY_BROADCAST_MAX_BYTES',str(8*1024**3)));size=0
        with path.open('wb') as file:
            while chunk:=await video.read(1024*1024):
                size+=len(chunk)
                if size>limit:raise HTTPException(413,'Broadcast upload exceeds configured byte limit')
                file.write(chunk)
        if not size:raise HTTPException(422,'Empty upload')
        items=json.loads(segments) if segments is not None else None
        job=await run_in_threadpool(jobs.create,path,config,items,metadata,vod_options)
        return JSONResponse(job,status_code=202)
    except (ValueError,KeyError,TypeError,InvalidVideo) as exc:
        raise HTTPException(422,str(exc)) from exc
    finally:
        path.unlink(missing_ok=True);await video.close();UPLOAD_GATE.release()


@router.post('/broadcasts')
async def create_broadcast(video:UploadFile=File(...),segments:str|None=Form(None),
    sample_interval:float=Form(10,ge=5,le=60),merge_gap:float=Form(20,ge=0,le=120),
    buffer:float=Form(10,ge=0,le=60),threshold:float=Form(.8,ge=.8,le=1),
    max_scan_frames:int=Form(10000,ge=2,le=10000),max_analysis_clips:int=Form(20,ge=1,le=200),
    clip_seconds:float=Form(10,ge=1,le=30)):
    return await submit(video,jobs.defaults(sample_interval,merge_gap,buffer,threshold,max_scan_frames,max_analysis_clips,clip_seconds),segments)


@router.get('/broadcasts/{job_id}')
def get_broadcast(job_id:UUID):return jobs.load(job_id)


class Corrections(BaseModel):
    segments:list[dict]=Field(min_length=1,max_length=200)


@router.post('/broadcasts/{job_id}/segments',status_code=202)
def correct_broadcast(job_id:UUID,correction:Corrections):
    try:return jobs.restart(job_id,correction.segments)
    except (ValueError,KeyError,TypeError) as exc:raise HTTPException(422,str(exc)) from exc


@router.get('/broadcasts/{job_id}/source')
def source(job_id:UUID):
    jobs.load(job_id);path=jobs.root()/str(job_id)/'source.upload'
    if not path.exists():raise HTTPException(404,'No source video')
    return FileResponse(path,media_type='video/mp4')


@router.delete('/broadcasts/{job_id}')
def delete(job_id:UUID):
    if str(job_id) in jobs.ACTIVE:raise HTTPException(409,'Cannot delete a running job')
    jobs.load(job_id);shutil.rmtree(jobs.root()/str(job_id))
    return {'deleted':True,'derived_analyses_deleted':False}


@router.get('/broadcast-demo')
def demo():
    return {'synthetic_demo':True,'video_duration':36000,'status':'completed','stage':'COMPLETE','id':None,
      'baseball_segments':[{'id':'DEMO-1','start':11110,'end':14492,'duration':3382,'confidence':.91,'estimated':True,
        'signals':['DEMO_bat','DEMO_glove','DEMO_field'],'review_required':True,'role':'unknown','analysis_status':'DEMO_no_analysis'}],
      'analyses':[],'label':'DEMO · 임의 구간/신뢰도 예시, 실제 탐지·분석 결과 아님'}
