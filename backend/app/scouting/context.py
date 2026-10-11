"""Declared capture conditions, not a claim of camera calibration."""
from typing import Literal
from pydantic import BaseModel, Field, model_validator


class CaptureContext(BaseModel):
    camera_angle: str = Field(min_length=1, max_length=80)
    environment: Literal['real', 'vr']
    vr_environment: str | None = Field(None, min_length=1, max_length=80)
    video_quality: Literal['good', 'fair', 'poor']
    camera_motion: Literal['fixed', 'moving', 'unknown'] = 'unknown'
    projection: Literal['flat', '360'] = 'flat'

    @model_validator(mode='after')
    def vr_requires_environment(self):
        if self.environment == 'vr' and not self.vr_environment:
            raise ValueError('VR comparisons require a declared vr_environment')
        return self


def comparison_reason(current, prior):
    if not prior:
        return 'No previous analysis for this role and source'
    if current.get('player_id') != prior.get('player_id') or not current.get('player_id'):
        return 'Same identified player required'
    if current.get('role') != prior.get('role') or bool(current.get('synthetic_demo')) != bool(prior.get('synthetic_demo')):
        return 'Role or real/DEMO source differs'
    if not current.get('comparison_context') or current['comparison_context'] != prior.get('comparison_context'):
        return 'Same explicit camera/task comparison_context required'
    a, b = current.get('capture_context'), prior.get('capture_context')
    if not a or not b:
        return 'Camera angle, environment and video quality must be declared for both captures'
    try:
        a = CaptureContext.model_validate(a).model_dump()
        b = CaptureContext.model_validate(b).model_dump()
    except ValueError:
        return 'Invalid capture conditions'
    if a != b:
        return 'Camera angle, VR environment, video quality or projection differs'
    if a['camera_motion'] != 'fixed' or a['video_quality'] == 'poor' or a['projection'] != 'flat':
        return 'Fixed camera, usable quality and flat projection required for image-proxy comparison'
    if current.get('status') != 'completed' or prior.get('status') != 'completed':
        return 'Both analyses must have sufficient pose'
    if not current.get('observation_method_version') or current['observation_method_version'] != prior.get('observation_method_version'):
        return 'Observation method versions differ or are unknown'
    if current.get('throwing_hand') != prior.get('throwing_hand') or current.get('position_type') != prior.get('position_type'):
        return 'Throwing hand or fielding position differs'
    a=(current.get('scouting_report') or {}).get('observation_window')
    b=(prior.get('scouting_report') or {}).get('observation_window')
    if not a or not b:
        return 'Observation duration and sample coverage are unknown'
    if min(a.get('duration_seconds',0),b.get('duration_seconds',0))<=0 or min(a.get('sample_count',0),b.get('sample_count',0))<5:
        return 'At least five usable samples and a positive observation window required'
    if max(a.get('max_gap_seconds',1),b.get('max_gap_seconds',1))>.25+1e-6:
        return 'Pose gaps prevent compatible image-motion comparison'
    for key in ('duration_seconds','sample_count'):
        if abs(a[key]-b[key])>min(a[key],b[key])*.1+1e-6:
            return 'Observation duration or usable sample coverage differs by more than 10%'
    return None
