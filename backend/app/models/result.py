from typing import Any, Literal
from pydantic import BaseModel, ConfigDict, Field


class Metric(BaseModel):
    value: float | str | bool | None = None
    unit: str | None = None
    estimated: Literal[True] = True
    confidence: float = Field(ge=0, le=1)
    confidence_grade: Literal['high','medium','low']
    method: str | None = None
    reason: str | None = None


class AnalysisEvent(BaseModel):
    timestamp: float = Field(ge=0)
    role: Literal['batter','defense','catcher','pitcher','baserunning']
    type: Literal['swing','receive','fielding','release','run']
    estimated: Literal[True]
    confidence: float = Field(ge=0, le=1)
    confidence_grade: Literal['high','medium','low']
    candidate: Literal[True]
    metrics: dict[str, Metric]


class PoseFrame3D(BaseModel):
    frame: int = Field(ge=0)
    timestamp: float = Field(ge=0)
    estimated: Literal[True]
    confidence: float = Field(ge=0, le=.35)
    confidence_grade: Literal['low']
    joints: dict[str, tuple[float, float, float]]
    joint_confidence: dict[str, float]
    reason: str | None = None


class PoseSequence3D(BaseModel):
    estimated: Literal[True]
    confidence: float = Field(ge=0, le=.35)
    confidence_grade: Literal['low']
    units: str
    coordinate_system: str
    method: str
    warning: str
    edges: list[tuple[str, str]]
    frames: list[PoseFrame3D]


class Keyframe(BaseModel):
    stage: str
    frame: int | None
    timestamp: float | None
    estimated: Literal[True]
    confidence: float = Field(ge=0, le=1)
    confidence_grade: Literal['high', 'medium', 'low']
    phase_detected: Literal[False]
    status: Literal['candidate', 'reference_only', 'unavailable']
    reason: str
    angles: dict[str, Metric]
    highlights: list[dict[str, Any]]
    image_url: str | None


class Visualization(BaseModel):
    model_config = ConfigDict(extra='allow')
    overlay_video_url: str | None
    keyframes: list[Keyframe]
    pose3d: PoseSequence3D
    frame_count: int = Field(ge=0)
    sample_fps: int = Field(gt=0)
    warning_threshold: float = Field(ge=.75, le=1)


class ScoutingCriterion(BaseModel):
    score: float | None = Field(default=None, ge=0, le=100)
    grade: str | None = None
    estimated: Literal[True]
    confidence: float = Field(ge=0, le=1)
    confidence_grade: Literal['high', 'medium', 'low']
    reason: str
    observation: Metric | None
    evidence_metric: str | None


class RoleEvaluation(BaseModel):
    analyzed: bool
    rating: float | None
    metrics: dict[str, ScoutingCriterion]
    strengths: list[dict[str, Any]]
    development_areas: list[dict[str, Any]]
    coaching: list[dict[str, Any]]


class PlayEvaluation(BaseModel):
    id: str
    role: str
    event: AnalysisEvent
    timestamp: float
    estimated: Literal[True]
    confidence: float = Field(ge=0, le=1)
    confidence_grade: Literal['high', 'medium', 'low']
    candidate: Literal[True]
    metrics: dict[str, Metric]
    strengths: list[dict[str, Any]]
    weaknesses: list[dict[str, Any]]
    coaching: list[dict[str, Any]]
    assessment_reason: str
    context_feedback: dict[str, Any]
    keyframe: Keyframe | None
    visualization_reference: dict[str, Any]


class ScoutingReport(BaseModel):
    player_id: str | None
    analysis_date: str
    synthetic_demo: bool
    estimated: Literal[True]
    rating_label: str
    scoring_policy: str
    strengths: list[dict[str, Any]]
    development_areas: list[dict[str, Any]]
    traits: list[dict[str, Any]]
    overall_summary: str
    ratings: dict[str, float | None]
    rating_reasons: dict[str, str]
    role_evaluations: dict[str, RoleEvaluation]
    plays: list[PlayEvaluation]


class AnalysisResult(BaseModel):
    model_config = ConfigDict(extra='allow')
    id: str
    schema_version: Literal['0.2.0', '0.3.0', '0.4.0']
    role: Literal['batter','defense','catcher','pitcher','baserunning','unknown']
    requested_role: Literal['batter','defense','catcher','pitcher','baserunning','auto']
    status: Literal['completed','insufficient_pose','unknown_role']
    summary: dict[str, Metric]
    metrics: dict[str, Metric]
    events: list[AnalysisEvent]
    usable_pose_frames: int
    strengths: list[dict[str, Any]]
    weaknesses: list[dict[str, Any]]
    coaching: list[dict[str, Any]]
    visualization: Visualization | None = None
    player_id: str | None = None
    analysis_date: str | None = None
    created_at: str | None = None
    comparison_context: str | None = None
    scouting_report: ScoutingReport | None = None
