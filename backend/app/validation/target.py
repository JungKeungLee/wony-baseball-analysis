"""Manually initialized ROI lock. Loss is terminal until a new human selection.

Appearance/scene guards are heuristics, not identity recognition. Successful CSRT
updates cannot certify identity through occlusion or similar-looking avatars.
"""
from collections import deque
from copy import deepcopy
import math
import cv2
import numpy as np
from pydantic import BaseModel, Field, model_validator
from typing import Literal


class TargetSelection(BaseModel):
    player_id: Literal['wony'] = 'wony'
    confirmed_by_user: bool = False
    viewpoint: Literal['third_person', 'first_person', 'unknown'] = 'unknown'
    source_time: float = Field(default=0, ge=0)
    source_width: int = Field(gt=0)
    source_height: int = Field(gt=0)
    bbox: tuple[float, float, float, float]
    source: Literal['manual_selection'] = 'manual_selection'
    pose_margin: float = Field(default=0, ge=0, le=.5)
    role_hint: Literal['auto','pitcher','batter','defense','catcher','baserunning'] = 'auto'

    @model_validator(mode='after')
    def bounds(self):
        x,y,w,h = self.bbox
        if not all(math.isfinite(v) for v in self.bbox) or min(x,y)<0 or min(w,h)<10:
            raise ValueError('Finite source-pixel bbox [x,y,width,height] required')
        if x+w>self.source_width or y+h>self.source_height:
            raise ValueError('Selection extends outside the source frame')
        return self


def crop(frame,bbox):
    x,y,w,h = (int(round(v)) for v in bbox)
    return frame[y:y+h,x:x+w]


def expanded_roi(bbox,width,height,margin):
    """Expand pose context, never tracker identity ROI; return exact clipped pixels."""
    x,y,w,h=bbox
    left=max(0,math.floor(x-w*margin));top=max(0,math.floor(y-h*margin))
    right=min(width,math.ceil(x+w*(1+margin)));bottom=min(height,math.ceil(y+h*(1+margin)))
    return (left,top,right-left,bottom-top)


def appearance(frame,bbox):
    image = crop(frame,bbox)
    # Central body region reduces the influence of the surrounding field.
    h,w = image.shape[:2]
    image = image[h//8:7*h//8,w//5:4*w//5]
    hsv = cv2.cvtColor(image,cv2.COLOR_BGR2HSV)
    histogram = cv2.calcHist([hsv],[0,1],None,[16,16],[0,180,0,256])
    return cv2.normalize(histogram,None).astype(np.float32)


# Short visual-effect grace (catch glow, dirt, SBO target overlays). Real catcher clips lost WONY for
# 1-2 samples while position/size stayed continuous. The appearance threshold (0.65) is unchanged; the
# grace only applies when geometry is *stricter* than normal tracking, never certifies the target, and
# pauses analysis. Anything else, or a longer dip, is still terminal tracking_lost.
GRACE_SECONDS = .35
GRACE_MIN_IOU = .8
GRACE_MAX_MOVE = .05      # of the last confirmed bbox diagonal, per decision
GRACE_AREA = (.8, 1.25)
GRACE_PREDICTION_GATE = .08  # predicted-center search radius, fraction of bbox diagonal


def box_iou(a, b):
    ax, ay, aw, ah = a; bx, by, bw, bh = b
    ix = max(0.0, min(ax+aw, bx+bw)-max(ax, bx)); iy = max(0.0, min(ay+ah, by+bh)-max(ay, by))
    inter = ix*iy
    return inter/(aw*ah+bw*bh-inter) if aw*ah+bw*bh-inter > 0 else 0.0


class ManualTargetTracker:
    def __init__(self,selection:TargetSelection,factory=None):
        self.selection=selection
        self.factory=factory or cv2.TrackerCSRT_create
        self.tracker=None;self.bbox=None;self.reference=None;self.previous=None
        self.status='user_confirmation_required';self.reason=None;self.lost_at=None
        self.previous_time=None
        self.history=deque(maxlen=4)  # confirmed (time, bbox) for motion prediction
        self.grace_start=None;self.candidate=None

    def record(self,t):
        return {'player_id':'wony','source_time':float(t),'status':self.status,
            'bbox':list(self.bbox) if self.bbox is not None and self.status in ('confirmed','tracking','low_confidence') else None,
            'confidence':self.confidence if self.status in ('confirmed','tracking','low_confidence') else 0.0,
            'estimated':True,'source':'manual_selection_csrt_appearance_guard',
            'identity_source':'user_confirmation','identity_verified_automatically':False,
            'reason':self.reason,'lost_at':self.lost_at,
            'analysis_allowed':self.status in ('confirmed','tracking'),
            'reidentification_required':self.lost_at is not None,
            'next_state':'reidentification_required' if self.lost_at is not None else None,
            # During temporary_occlusion the CSRT box is only a candidate/search region, not a confirmed WONY.
            'candidate_bbox':list(self.candidate) if self.status=='temporary_occlusion' and self.candidate else None,
            'grace_started_at':self.grace_start if self.status=='temporary_occlusion' else None}

    def require_reidentification(self):
        """Explicit recovery state, never search/reinitialize automatically."""
        if self.lost_at is not None:self.status='reidentification_required'

    def predicted_center(self,t):
        """Constant-velocity center from the last confirmed boxes; a search gate, not a detection."""
        if len(self.history)<2:return None
        (t0,a),(t1,b)=self.history[-2],self.history[-1]
        if t1<=t0:return None
        c0=np.array(a[:2])+np.array(a[2:])/2;c1=np.array(b[:2])+np.array(b[2:])/2
        return c1+(c1-c0)/(t1-t0)*(t-t1)

    def grace(self,t,bbox):
        """Allow a brief appearance dip only with strict continuity to the last confirmed WONY box."""
        start=self.grace_start if self.grace_start is not None else t
        if t-start>GRACE_SECONDS+1e-6:return None
        previous=np.array(self.bbox,dtype=float);current=np.array(bbox,dtype=float)
        diagonal=float(np.linalg.norm(previous[2:]));center=current[:2]+current[2:]/2
        move=float(np.linalg.norm(center-previous[:2]-previous[2:]/2))/diagonal
        area=float(current[2]*current[3]/(previous[2]*previous[3]))
        if box_iou(previous,current)<GRACE_MIN_IOU or move>GRACE_MAX_MOVE or not GRACE_AREA[0]<=area<=GRACE_AREA[1]:return None
        predicted=self.predicted_center(t)
        if predicted is not None and float(np.linalg.norm(center-predicted))/diagonal>GRACE_PREDICTION_GATE:return None
        return start

    def lose(self,t,reason):
        self.status='tracking_lost';self.reason=reason;self.lost_at=float(t)
        self.bbox=None
        return self.record(t)

    def update(self,frame,t):
        if not self.selection.confirmed_by_user:
            self.reason='User must confirm the selected avatar is WONY'
            return self.record(t)
        if self.selection.viewpoint!='third_person':
            self.reason='Full-body ROI pose is disabled for first-person/unknown viewpoint'
            return self.record(t)
        if self.lost_at is not None:
            return self.record(t)  # Never initialize/search another target after loss.
        if not math.isfinite(t) or t<0 or (self.previous_time is not None and (t<=self.previous_time or t-self.previous_time>1.0)):
            return self.lose(t if math.isfinite(t) else 0,'Invalid sampling time or tracking gap; human reselection required')
        self.previous_time=t
        if frame.shape[:2]!=(self.selection.source_height,self.selection.source_width):
            return self.lose(t,'Source dimensions changed; new manual selection required')
        gray=cv2.resize(cv2.cvtColor(frame,cv2.COLOR_BGR2GRAY),(160,90))
        if self.tracker is None:
            self.bbox=tuple(int(round(v)) for v in self.selection.bbox)
            x,y,w,h=self.bbox
            if x+w>frame.shape[1] or y+h>frame.shape[0]:
                return self.lose(t,'Rounded selection exceeds source pixels')
            self.tracker=self.factory();self.tracker.init(frame,self.bbox)
            self.reference=appearance(frame,self.bbox);self.previous=gray
            self.confidence=.6;self.status='confirmed';self.history.append((t,self.bbox))
            return self.record(t)
        # A broad scene change interrupts attribution rather than guessing a new avatar.
        scene_change=float(np.mean(np.abs(gray.astype(float)-self.previous.astype(float)))/255)
        self.previous=gray
        if scene_change>.20:
            return self.lose(t,'Abrupt scene/camera change')
        ok,bbox=self.tracker.update(frame)
        if not ok or not all(math.isfinite(v) for v in bbox):
            return self.lose(t,'CSRT update failed')
        x,y,w,h=bbox;fh,fw=frame.shape[:2]
        if min(x,y)<0 or min(w,h)<10 or x+w>fw or y+h>fh:
            return self.lose(t,'Target left the visible frame')
        previous=np.array(self.bbox,dtype=float);current=np.array(bbox,dtype=float)
        travel=np.linalg.norm(current[:2]+current[2:]/2-previous[:2]-previous[2:]/2)
        area_ratio=w*h/(previous[2]*previous[3])
        if travel>np.linalg.norm(previous[2:])*.25 or not .5<=area_ratio<=1.8:
            return self.lose(t,'Abrupt target displacement/scale change')
        similarity=1-float(cv2.compareHist(self.reference,appearance(frame,bbox),cv2.HISTCMP_BHATTACHARYYA))
        if similarity<.65:
            start=self.grace(t,bbox)
            if start is None:
                reason=('Appearance stayed below threshold beyond the short-occlusion grace; human reselection required'
                        if self.grace_start is not None else 'Appearance confidence dropped; human reselection required')
                return self.lose(t,reason)
            self.grace_start=start;self.candidate=tuple(float(v) for v in bbox)
            self.status='temporary_occlusion';self.confidence=0.0
            self.reason='Brief visual effect/overlay: appearance below threshold with continuous position; analysis paused, not confirmed as WONY'
            return self.record(t)
        self.grace_start=None;self.candidate=None
        self.bbox=tuple(float(v) for v in bbox);self.confidence=round(min(.6,.6*similarity),3)
        self.status='low_confidence' if self.confidence<.45 else 'tracking'
        self.reason='Appearance confidence marginal; pose paused' if self.status=='low_confidence' else None
        self.history.append((t,self.bbox))
        return self.record(t)


def map_pose_to_source(sample,bbox,width,height):
    """Restore ROI-normalized x/y/z to the existing source-normalized pose contract."""
    output=deepcopy(sample);x,y,w,h=bbox
    output['aspect_ratio']=width/height
    output['source']='manual_target_roi_mediapipe'
    output['target_bbox']=list(bbox)
    for joint in output['landmarks']:
        outside=not (0<=joint['x']<=1 and 0<=joint['y']<=1)
        joint['outside_pose_crop']=outside
        if outside:
            joint['model_visibility']=joint['visibility'];joint['visibility']=0.0
        joint['x']=(x+joint['x']*w)/width
        joint['y']=(y+joint['y']*h)/height
        joint['z']=joint.get('z',0)*w/width
    return output


def pose_in_target(sample,bbox,width,height):
    """Expanded context cannot attribute a neighboring body's core to WONY."""
    x,y,w,h=bbox
    try:
        core=[sample['landmarks'][i] for i in [11,12,23,24]]
        if any(not math.isfinite(p['visibility']) or p['visibility']<.6 for p in core):return False
        cx=float(np.mean([p['x'] for p in core]))*width
        cy=float(np.mean([p['y'] for p in core]))*height
        return math.isfinite(cx) and math.isfinite(cy) and x<=cx<=x+w and y<=cy<=y+h
    except (KeyError,IndexError,TypeError):return False
