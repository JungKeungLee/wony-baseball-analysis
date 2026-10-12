"""Opt-in experimental target validation, separate from production player history."""
import json
import re
import shutil
import subprocess
from uuid import UUID,uuid4
from fastapi import APIRouter,File,Form,UploadFile,HTTPException
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool
from app.models.storage import data_dir
from app.validation.target import TargetSelection
from app.validation.runner import validate_clip

router=APIRouter()


def root():
    folder=data_dir()/'validation';folder.mkdir(parents=True,exist_ok=True);return folder


@router.post('/validation')
async def validate_target(video:UploadFile=File(...),selection:str=Form(...,max_length=2000),hud_regions:str|None=Form(None,max_length=1500),batter_review:str|None=Form(None,max_length=3000)):
    from app.api.routes import processing_lock
    try:
        target=TargetSelection.model_validate(json.loads(selection))
        hud=json.loads(hud_regions) if hud_regions else None
        review=None
        if batter_review:
            from app.validation.batter_review import BatterReview
            review=BatterReview.model_validate(json.loads(batter_review)).model_dump()
        if hud is not None and (not isinstance(hud,dict) or len(hud)>2):raise ValueError('Invalid HUD regions')
    except (ValueError,TypeError) as exc:raise HTTPException(422,'Invalid manual selection JSON') from exc
    if not target.confirmed_by_user:raise HTTPException(422,'Confirm the selected avatar is WONY before analysis')
    if not processing_lock.acquire(blocking=False):raise HTTPException(503,'Analysis engine busy')
    identifier=str(uuid4());path=root()/f'{identifier}.upload';size=0
    try:
        with path.open('wb') as output:
            while block:=await video.read(1024*1024):
                size+=len(block)
                if size>128*1024**2:raise HTTPException(413,'Validation maximum 128 MiB')
                output.write(block)
        if not size:raise HTTPException(422,'Empty video')
        await run_in_threadpool(validate_clip,path,target,root(),identifier,hud,review)
        return {'id':identifier,'validation_only':True,'report_url':f'/demo/validation/report/{identifier}'}
    except (ValueError,IndexError,KeyError,subprocess.SubprocessError) as exc:
        shutil.rmtree(root()/identifier,ignore_errors=True)
        raise HTTPException(422,'Video metadata or target selection could not be validated') from exc
    except Exception:
        shutil.rmtree(root()/identifier,ignore_errors=True)
        raise
    finally:path.unlink(missing_ok=True);await video.close();processing_lock.release()


def load(identifier):
    path=root()/str(identifier)/'analysis.json'
    if not path.is_file():raise HTTPException(404,'Validation report not found')
    return json.loads(path.read_text(encoding='utf-8'))


@router.get('/validation/{identifier}')
def report(identifier:UUID):
    result=load(identifier);mapping=result['source_time_mapping']
    return {'id':str(identifier),'kind':'validation','synthetic_demo':False,
        'analysis_date':result['analysis_date'],'player_tools':result['scouting_report']['player_tools'],
        'best_tool':None,'development_area':None,'play_style':None,
        'entries':[{'analysis':result,'start':mapping[0]['source_time'] if mapping else 0,
            'end':result['validation_summary']['metadata']['duration_seconds'],
            'source_start':mapping[0]['source_time'] if mapping else 0,
            'source_url':f'/api/validation/{identifier}/source','timestamp_origin':'source_pts_mapped'}]}


@router.get('/validation/{identifier}/analysis')
def analysis(identifier:UUID):return load(identifier)


@router.get('/validation/{identifier}/source')
def source(identifier:UUID):
    load(identifier);return FileResponse(root()/str(identifier)/'source.mp4',media_type='video/mp4')


@router.get('/validation/{identifier}/assets/{filename}')
def asset(identifier:UUID,filename:str):
    if not re.fullmatch(r'overlay\.mp4|keyframe-\d{4}\.jpg',filename):raise HTTPException(404)
    path=root()/str(identifier)/f'{identifier}-assets'/filename
    if not path.is_file():raise HTTPException(404)
    return FileResponse(path)


@router.get('/validation/{identifier}/evidence/{filename}')
def evidence(identifier:UUID,filename:str):
    if not re.fullmatch(r'(?:hud_original_speed|hud_converted_speed)-\d{4}\.png|evidence-\d{4}\.jpg',filename):raise HTTPException(404)
    load(identifier);path=root()/str(identifier)/filename
    if not path.is_file():raise HTTPException(404)
    return FileResponse(path)
