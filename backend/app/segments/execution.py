"""The sole detailed-analysis bridge shared by LIVE and VOD discovery."""
from uuid import uuid4
from datetime import date


def analyze_clip(path,role,metadata,progress=lambda _:None):
    from app.api.routes import processing_lock,process_frames
    from app.pose.extractor import extract_pose
    from app.video.frames import extract_frames
    if role=='unknown':role='auto'
    if not processing_lock.acquire(timeout=60):raise RuntimeError('Analysis engine busy')
    try:
        # Selection is a discovery role/human hint, not a successful pose classification.
        progress('ROLE_ANALYSIS')
        frames=extract_frames(path)
        progress('POSE_ANALYSIS');samples=extract_pose(frames)
        from app.segments.detection import scene_context
        context=scene_context(frames) if role=='auto' else {}
        day=metadata.get('analysis_date')
        return process_frames(frames,samples,str(uuid4()),metadata.get('throwing_hand','right'),role,
            metadata.get('position_type','auto'),player_id=metadata.get('player_id'),
            analysis_date=date.fromisoformat(day) if day else None,comparison_context=metadata.get('comparison_context'),capture_context=metadata.get('capture_context'),
            stage_callback=lambda stage:progress(stage) if stage=='SCOUTING_REPORT' else None,scene_context=context)
    finally:processing_lock.release()
