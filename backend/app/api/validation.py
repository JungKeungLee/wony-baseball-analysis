"""Opt-in experimental target validation, separate from production player history."""
import json
import logging
import re
import shutil
import subprocess
from uuid import UUID,uuid4
from fastapi import APIRouter,File,Form,UploadFile,HTTPException,Query
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool
from app.models.storage import data_dir
from app.validation.target import TargetSelection
from app.validation.runner import validate_clip
from app.validation.records import list_reports,save_source_name,summarize
from app.validation.display import SelectionInputError,probe,to_source

router=APIRouter()
logger=logging.getLogger('uvicorn.error').getChild('wony.validation')  # shown in the server console


def reject(code,message,status=422):
    """One cause per error: '[code] message' keeps detail a string for existing clients."""
    logger.warning('validation rejected: %s - %s',code,message)
    raise HTTPException(status,f'[{code}] {message}')


def parse_selection(raw):
    try:data=json.loads(raw)
    except ValueError:reject('selection_invalid_json','Selection is not valid JSON')
    try:return TargetSelection.model_validate(data)
    except ValueError as exc:
        text=str(exc)
        if 'outside the source frame' in text:reject('selection_out_of_frame',text)
        if 'bbox' in text:reject('selection_missing','A source-pixel bbox [x,y,width,height] of at least 10px is required: '+text)
        reject('selection_invalid',text)


def root():
    folder=data_dir()/'validation';folder.mkdir(parents=True,exist_ok=True);return folder


@router.post('/validation')
async def validate_target(video:UploadFile=File(...),selection:str=Form(...,max_length=2000),hud_regions:str|None=Form(None,max_length=1500),batter_review:str|None=Form(None,max_length=3000)):
    from app.api.routes import processing_lock
    target=parse_selection(selection)
    try:
        hud=json.loads(hud_regions) if hud_regions else None
        review=None
        if batter_review:
            from app.validation.batter_review import BatterReview
            review=BatterReview.model_validate(json.loads(batter_review)).model_dump()
        if hud is not None and (not isinstance(hud,dict) or len(hud)>2):raise ValueError('Invalid HUD regions')
    except (ValueError,TypeError) as exc:reject('request_invalid',f'Invalid HUD/review JSON: {exc}')
    if not target.confirmed_by_user:reject('not_confirmed','Confirm the selected avatar is WONY before analysis')
    if not processing_lock.acquire(blocking=False):reject('engine_busy','Analysis engine busy',503)
    identifier=str(uuid4());path=root()/f'{identifier}.upload';size=0
    try:
        with path.open('wb') as output:
            while block:=await video.read(1024*1024):
                size+=len(block)
                if size>128*1024**2:reject('video_too_large','Validation maximum 128 MiB',413)
                output.write(block)
        if not size:reject('video_empty','Empty video')
        meta=await run_in_threadpool(probe,path)
        source,conversion=to_source(target,meta)
        logger.info('validation selection: video %sx%s SAR %s %.3fs | sent %sx%s bbox %s | source bbox %s',meta['width'],meta['height'],meta['sample_aspect_ratio'],meta['duration'],
                    target.source_width,target.source_height,list(target.bbox),list(source.bbox))
        await run_in_threadpool(validate_clip,path,source,root(),identifier,hud,review)
        save_source_name(root()/identifier,video.filename)
        if conversion:(root()/identifier/'selection_input.json').write_text(json.dumps(conversion),encoding='utf-8')
        return {'id':identifier,'validation_only':True,'report_url':f'/demo/validation/report/{identifier}'}
    except SelectionInputError as exc:
        shutil.rmtree(root()/identifier,ignore_errors=True)
        reject(exc.code,str(exc).split('] ',1)[-1])
    except (ValueError,IndexError,KeyError,subprocess.SubprocessError) as exc:
        shutil.rmtree(root()/identifier,ignore_errors=True)
        logger.exception('validation input rejected by the runner')
        reject('analysis_input_rejected',f'{type(exc).__name__}: {exc}')
    except Exception:
        shutil.rmtree(root()/identifier,ignore_errors=True)
        raise
    finally:path.unlink(missing_ok=True);await video.close();processing_lock.release()


@router.get('/validation/reports')
def validation_reports(offset:int=Query(0,ge=0),limit:int=Query(30,ge=1,le=100)):
    """Stored WONY validation summaries; separate from /api/reports and growth history."""
    return list_reports(root(),offset,limit)


@router.get('/validation/reports/{identifier}')
def validation_report_summary(identifier:UUID):
    folder=root()/str(identifier)
    if not (folder/'analysis.json').is_file():raise HTTPException(404,'Validation report not found')
    try:return summarize(folder)
    except (OSError,ValueError,TypeError,KeyError,AttributeError) as exc:raise HTTPException(422,'Stored validation result is unreadable') from exc


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
