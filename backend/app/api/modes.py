import json
import shutil
import socket
from uuid import UUID,uuid4
from typing import Literal
from fastapi import APIRouter,UploadFile,File,Form,HTTPException
from pydantic import BaseModel,Field
from starlette.concurrency import run_in_threadpool
from app.api.broadcasts import submit
from app.segments.jobs import defaults
from app.segments import jobs
from app.live import sessions
from app.video.frames import InvalidVideo

router=APIRouter()
Role=Literal['batter','defense','catcher','pitcher','baserunning','unknown']


@router.post('/vod')
async def vod(video:UploadFile=File(...),mode:Literal['exact','approximate','auto']=Form('auto'),
    start:str|None=Form(None),end:str|None=Form(None),center_time:str|None=Form(None),
    buffer_minutes:float=Form(10,ge=0,le=120),search_window_minutes:float=Form(60,ge=1,le=720),
    role:Role=Form('unknown'),segments:str|None=Form(None),
    sample_interval:float=Form(10,ge=5,le=60),max_scan_frames:int=Form(10000,ge=2,le=10000),
    max_analysis_clips:int=Form(20,ge=1,le=200),clip_seconds:float=Form(10,ge=1,le=30),
    player_id:str|None=Form(None,pattern=r'^[A-Za-z0-9_-]{1,64}$')):
    options=None if segments is not None else dict(mode=mode,start=start,end=end,center_time=center_time,
        buffer_minutes=buffer_minutes,search_window_minutes=search_window_minutes,role=role)
    return await submit(video,defaults(sample_interval=sample_interval,max_scan_frames=max_scan_frames,
        max_analysis_clips=max_analysis_clips,clip_seconds=clip_seconds),segments,{'player_id':player_id},options)


class LiveConfig(BaseModel):
    role:Role='unknown'
    sample_interval:float=Field(10,ge=5,le=10)
    confirmation_seconds:float=Field(30,ge=10,le=120)
    minimum_hits:int=Field(3,ge=2,le=20)
    ending_seconds:float=Field(240,ge=180,le=600)
    threshold:float=Field(.8,ge=.8,le=1)
    clip_seconds:float=Field(10,ge=1,le=30)
    max_analysis_clips:int=Field(20,ge=1,le=200)
    max_session_seconds:float=Field(86400,ge=10,le=86400)


@router.post('/live',status_code=202)
async def live(source_url:str|None=Form(None,max_length=4096),video:UploadFile|None=File(None),
               config:str=Form('{}'),player_id:str|None=Form(None,pattern=r'^[A-Za-z0-9_-]{1,64}$')):
    if bool(source_url)==bool(video):raise HTTPException(422,'Provide exactly one source_url or video replay')
    path=None
    try:
        settings=LiveConfig.model_validate(json.loads(config)).model_dump()
        if video:
            path=sessions.root()/f'{uuid4()}.upload';size=0
            with path.open('wb') as target:
                while chunk:=await video.read(1024*1024):
                    size+=len(chunk)
                    if size>100*1024**2:raise HTTPException(413,'File replay maximum 100 MiB; use VOD for long files')
                    target.write(chunk)
        return await run_in_threadpool(sessions.start,settings,source_url,path,{'player_id':player_id})
    except (ValueError,TypeError,InvalidVideo,socket.gaierror) as exc:
        raise HTTPException(422,'Invalid LIVE config, public stream URL or replay video') from exc
    finally:
        if path:path.unlink(missing_ok=True)
        if video:await video.close()


@router.get('/live/{session_id}')
def live_status(session_id:UUID):return sessions.load(session_id)


@router.post('/live/{session_id}/stop',status_code=202)
def live_stop(session_id:UUID):return sessions.stop_session(session_id)


class RoleHint(BaseModel):role:Role


@router.patch('/live/{session_id}/role')
def live_role(session_id:UUID,hint:RoleHint):return sessions.set_role(session_id,hint.role)


@router.post('/live/{session_id}/segments',status_code=202)
def live_correction(session_id:UUID,correction:dict):
    session=sessions.load(session_id)
    if str(session_id) in sessions.RUNTIME:raise HTTPException(409,'Stop the live session before correction')
    path=sessions.root()/str(session_id)/'source.upload'
    if not path.exists():raise HTTPException(422,'URL source has no retained full VOD. Upload recorded VOD to correct intervals')
    copy=path.with_name(f'{uuid4()}.upload')
    try:
        shutil.copyfile(path,copy)
        return jobs.create(copy,defaults(),correction['segments'],session.get('metadata',{}))
    except (ValueError,TypeError,KeyError) as exc:raise HTTPException(422,'Invalid segments') from exc
    finally:copy.unlink(missing_ok=True)


@router.delete('/live/{session_id}')
def live_delete(session_id:UUID):
    if str(session_id) in sessions.RUNTIME:raise HTTPException(409,'Stop the live session first')
    sessions.load(session_id);shutil.rmtree(sessions.root()/str(session_id))
    return {'deleted':True,'derived_analyses_deleted':False}
