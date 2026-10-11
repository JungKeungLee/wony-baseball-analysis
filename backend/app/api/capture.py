import json
from fastapi import Form, HTTPException
from app.scouting.context import CaptureContext


def capture_metadata(capture_context: str | None = Form(None, max_length=1500)):
    if capture_context is None:
        return None
    try:
        return CaptureContext.model_validate(json.loads(capture_context)).model_dump()
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, 'Invalid capture_context JSON: declare camera_angle, environment, video_quality and camera_motion') from exc
