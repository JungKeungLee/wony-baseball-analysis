"""Read-only UI composition. Analysis algorithms and stored results stay unchanged."""
import json
from uuid import UUID
from fastapi import APIRouter,HTTPException,Query
from fastapi.responses import FileResponse
from app.models.storage import data_dir

router=APIRouter()


def read(path):
    try:
        value=json.loads(path.read_text(encoding='utf-8'))
        return value if isinstance(value,dict) else None
    except (OSError,ValueError):return None


def bundle(report_id):
    root=data_dir();key=str(report_id)
    raw=read(root/f'{key}.json')
    if raw and raw.get('id')==key and 'metrics' in raw:
        return {'id':key,'kind':'analysis','synthetic_demo':bool(raw.get('synthetic_demo')),
            'analysis_date':raw.get('analysis_date') or (raw.get('created_at') or '')[:10],
            'entries':[{'analysis':raw,'start':0,'end':raw.get('visualization',{}).get('frame_count',0)/raw.get('sample_fps',10),
                        'source_url':None,'timestamp_origin':'clip_relative'}]}
    for kind,folder,file in [('vod','broadcasts','job.json'),('live','live','session.json')]:
        manifest=read(root/folder/key/file)
        if not manifest:continue
        entries=[]
        for ref in manifest.get('analyses',[]):
            try:aid=str(UUID(ref['analysis_id']))
            except (KeyError,ValueError,TypeError):continue
            analysis=read(root/f'{aid}.json')
            if analysis:
                source=root/folder/key/'source.upload'
                entries.append({'analysis':analysis,'start':ref.get('start',0),'end':ref.get('end'),
                    'source_url':f'/api/reports/{key}/source' if source.is_file() else None,
                    'timestamp_origin':'broadcast_relative' if kind=='vod' else 'session_elapsed'})
        if not entries:raise HTTPException(404,'No completed analyses for this report')
        return {'id':key,'kind':kind,'synthetic_demo':bool(manifest.get('synthetic_demo')),
            'analysis_date':entries[0]['analysis'].get('analysis_date') or (manifest.get('created_at') or '')[:10],
            'segments':manifest.get('baseball_segments',[]),'entries':entries}
    raise HTTPException(404,'Report not found')


@router.get('/reports/{report_id}')
def get_report(report_id:UUID):return bundle(report_id)


@router.get('/reports/{report_id}/source')
def get_source(report_id:UUID):
    bundle(report_id)
    for folder in ['broadcasts','live']:
        path=data_dir()/folder/str(report_id)/'source.upload'
        if path.is_file():return FileResponse(path,media_type='video/mp4')
    raise HTTPException(404,'Original video is not retained')


@router.get('/reports')
def report_list(source:str=Query('real',pattern='^(real|demo)$'),offset:int=Query(0,ge=0),limit:int=Query(30,ge=1,le=100)):
    root=data_dir();groups=[];linked=set();skipped=0
    for folder,file in [('broadcasts','job.json'),('live','session.json')]:
        for path in (root/folder).glob(f'*/{file}'):
            try:identifier=UUID(path.parent.name);group=bundle(identifier)
            except (ValueError,HTTPException):continue
            linked.update(e['analysis']['id'] for e in group['entries']);groups.append(group)
    for path in root.glob('*.json'):
        if path.stem in linked:continue
        try:groups.append(bundle(UUID(path.stem)))
        except (ValueError,HTTPException):skipped+=1
    items=[]
    for group in groups:
        if group['synthetic_demo']!=(source=='demo'):continue
        entries=group['entries'];roles=sorted({e['analysis']['role'] for e in entries})
        # Only processed clip coverage, never label the entire candidate segment as analyzed.
        duration=sum(max(0,(e.get('end') or e['start'])-e['start']) for e in entries)
        items.append({'id':group['id'],'kind':group['kind'],'analysis_date':group['analysis_date'],
                      'roles':roles,'analyzed_seconds':duration,'clip_count':len(entries),
                      'synthetic_demo':group['synthetic_demo'],'report_url':f"/demo/analysis/{group['id']}"})
    items.sort(key=lambda item:(item['analysis_date'],item['id']),reverse=True)
    return {'items':items[offset:offset+limit],'total':len(items),'offset':offset,'limit':limit,'source':source,'skipped':skipped}
