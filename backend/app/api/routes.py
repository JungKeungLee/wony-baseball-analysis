import json
import logging
import shutil
import threading
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo
from typing import Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.concurrency import run_in_threadpool
from app.analysis.engine import analyze_role
from app.models.storage import data_dir, save_result, player_records
from app.scouting.report import build_report, aggregate_player_report
from app.scouting.growth import compare_records, illustrative_demo_growth
from app.models.result import AnalysisResult
from app.pose.extractor import extract_pose
from app.video.frames import InvalidVideo, extract_frames
from app.visualization.builder import build_visualization

router = APIRouter()
processing_lock = threading.Lock()
MAX_BYTES = 100 * 1024 * 1024
logger = logging.getLogger(__name__)


def process(path, analysis_id, hand, role='pitcher', position_type='auto', player_id=None, analysis_date=None, comparison_context=None):
    frames = extract_frames(path)
    samples = extract_pose(frames)
    return process_frames(frames, samples, analysis_id, hand, role, position_type, player_id=player_id, analysis_date=analysis_date, comparison_context=comparison_context)


def process_frames(frames, samples, analysis_id, hand, role='pitcher', position_type='auto', synthetic=False, player_id=None, analysis_date=None, comparison_context=None, stage_callback=None):
    if stage_callback:
        stage_callback('ROLE_ANALYSIS')
    result = {
        'id': analysis_id, 'schema_version': '0.4.0',
        'throwing_hand': hand, 'sample_fps': 10,
        'sampled_frames': len(frames), 'detected_pose_frames': len(samples),
        'pose': samples, 'ball_speed': None, 'batted_ball_speed': None,
        'synthetic_demo': synthetic,
        'player_id': player_id,
        'analysis_date': (analysis_date or datetime.now(ZoneInfo('Asia/Seoul')).date()).isoformat(),
        'date_source': 'user_provided' if analysis_date else 'server_date_Asia/Seoul',
        'created_at': datetime.now(timezone.utc).isoformat(),
        'comparison_context': comparison_context, 'observation_method_version': 'pose-proxies-v1',
        **analyze_role(samples, role, hand, position_type),
        'warnings': [
            'Single-camera 2D estimates; camera angle and occlusion affect all metrics.',
            'Confidence is a heuristic score, not a calibrated probability.',
            'Release is a wrist-motion candidate; ball speed is not measured.',
            'Input should contain one full-body subject and one action; events are unverified candidates.',
            'VR avatar animation may differ from actual human biomechanics.',
            'No actual force, foot pressure, ball speed or exit velocity is measured.',
        ],
    }
    if result['usable_pose_frames'] < 3:
        result['status'] = 'insufficient_pose'
    try:
        result['visualization'] = build_visualization(frames, samples, result, data_dir())
        if stage_callback:
            stage_callback('SCOUTING_REPORT')
        result['scouting_report'] = build_report(result)
        result = AnalysisResult.model_validate(result).model_dump(mode='json')
        save_result(result)
    except Exception:
        shutil.rmtree(data_dir() / f'{analysis_id}-assets', ignore_errors=True)
        raise
    return result


@router.post('/demo/{role}', response_model=AnalysisResult)
async def create_demo(role: Literal['batter', 'defense', 'catcher', 'pitcher', 'baserunning'],
    player_id: str | None = Form(None, pattern=r'^[A-Za-z0-9_-]{1,64}$'),
    analysis_date: date | None = Form(None),
    comparison_context: str | None = Form(None, min_length=1, max_length=80)):
    from app.visualization.demo import synthetic_clip
    if not processing_lock.acquire(blocking=False):
        raise HTTPException(503, 'Another analysis is running; retry later')
    try:
        def run():
            frames, samples = synthetic_clip(role)
            return process_frames(frames, samples, str(uuid4()), 'right', role, synthetic=True, player_id=player_id, analysis_date=analysis_date, comparison_context=comparison_context)
        return await run_in_threadpool(run)
    except Exception as exc:
        logger.exception('Synthetic demo generation failed')
        raise HTTPException(500, {'code': 'analysis_failed', 'message': 'Demo generation failed'}) from exc
    finally:
        processing_lock.release()


@router.post('/analyze', response_model=AnalysisResult)
async def create_analysis(
    video: UploadFile = File(...),
    throwing_hand: Literal['left', 'right'] = Form('right'),
    role: Literal['batter', 'defense', 'catcher', 'pitcher', 'baserunning', 'auto'] = Form('pitcher'),
    position_type: Literal['auto', 'infielder', 'outfielder'] = Form('auto'),
    player_id: str | None = Form(None, pattern=r'^[A-Za-z0-9_-]{1,64}$'),
    analysis_date: date | None = Form(None),
    comparison_context: str | None = Form(None, min_length=1, max_length=80),
    mode: Literal['single', 'auto_segments'] = Form('single'),
    segments: str | None = Form(None),
):
    if mode == 'auto_segments' or segments is not None:
        from app.api.broadcasts import submit
        from app.segments.jobs import defaults
        return await submit(video, defaults(), segments, {
            'throwing_hand': throwing_hand, 'position_type': position_type, 'player_id': player_id,
            'analysis_date': analysis_date.isoformat() if analysis_date else None,
            'comparison_context': comparison_context})
    if not processing_lock.acquire(blocking=False):
        raise HTTPException(503, 'Another video is being analyzed; retry later')
    analysis_id = str(uuid4())
    path = None
    try:
        path = data_dir() / f'{analysis_id}.upload'
        size = 0
        with path.open('wb') as target:
            while chunk := await video.read(1024 * 1024):
                size += len(chunk)
                if size > MAX_BYTES:
                    raise HTTPException(413, 'Maximum upload size is 100 MiB')
                target.write(chunk)
        if size == 0:
            raise HTTPException(422, 'Empty upload')
        return await run_in_threadpool(process, path, analysis_id, throwing_hand, role, position_type, player_id, analysis_date, comparison_context)
    except InvalidVideo as exc:
        raise HTTPException(422, str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception('Analysis failed for %s', analysis_id)
        raise HTTPException(500, {'code': 'analysis_failed', 'message': 'Analysis failed; no result was saved'}) from exc
    finally:
        if path is not None:
            path.unlink(missing_ok=True)
        await video.close()
        processing_lock.release()


@router.get('/analysis/{analysis_id}')
def get_analysis(analysis_id: UUID):
    path = data_dir() / f'{analysis_id}.json'
    if not path.exists():
        raise HTTPException(404, 'Analysis not found')
    return json.loads(path.read_text(encoding='utf-8'))


@router.get('/analysis/{analysis_id}/assets/{filename}')
def get_asset(analysis_id: UUID, filename: str):
    import re
    if not re.fullmatch(r'overlay\.mp4|keyframe-\d{4}\.jpg', filename):
        raise HTTPException(404, 'Asset not found')
    root = data_dir()
    path = root / f'{analysis_id}-assets' / filename
    if not (root / f'{analysis_id}.json').exists() or not path.is_file():
        raise HTTPException(404, 'Asset not found')
    return FileResponse(path, media_type='video/mp4' if filename.endswith('.mp4') else 'image/jpeg')


@router.get('/demo/growth')
def demo_growth():
    return illustrative_demo_growth()


@router.get('/players/{player_id}/history')
def player_history(player_id: str, source: Literal['real', 'demo'] = 'real'):
    import re
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', player_id):
        raise HTTPException(422, 'Invalid player_id')
    records, skipped = player_records(player_id, source)
    return {'player_id': player_id, 'source': source, 'synthetic_demo': source == 'demo',
        'points': compare_records(records), 'count': len(records), 'skipped_records': skipped,
        'rating_label': '영상 기반 참고 지표 — 공식 점수 아님',
        'warning': 'Same comparison_context is user-declared, not verified camera calibration. Proxy deltas do not establish improvement.'}


@router.get('/players/{player_id}/scouting-report')
def player_report(player_id: str, source: Literal['real', 'demo'] = 'real'):
    import re
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', player_id):
        raise HTTPException(422, 'Invalid player_id')
    records, skipped = player_records(player_id, source)
    report = aggregate_player_report(player_id, records, source)
    report['skipped_records'] = skipped
    return report
