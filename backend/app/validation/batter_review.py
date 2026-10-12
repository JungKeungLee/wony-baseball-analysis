"""Manual swing review windows and visible-joint inputs, never ability ratings.

No bat/trail detector is introduced. A wrist path is not a bat swing path.
Manual review ranges are not precise swing onset/end or verified contact events.
"""
import math
import numpy as np
from pydantic import BaseModel,Field,model_validator
from app.validation.quality import visible_joint
from app.analysis.shared.angles import angle


class ReviewWindow(BaseModel):
    start:float=Field(ge=0)
    end:float=Field(gt=0)
    @model_validator(mode='after')
    def ordered(self):
        if not math.isfinite(self.start) or not math.isfinite(self.end) or self.end<=self.start:raise ValueError('Finite ordered source-time review window required')
        return self


class BatterReview(BaseModel):
    windows:list[ReviewWindow]=Field(min_length=1,max_length=20)
    @model_validator(mode='after')
    def disjoint(self):
        ordered=sorted(self.windows,key=lambda w:w.start)
        if any(a.end>b.start for a,b in zip(ordered,ordered[1:])):raise ValueError('Review windows must not overlap')
        return self


def withheld(reason):
    return {'value':None,'estimated':True,'confidence':0.0,'confidence_grade':'low','reason':reason}


def observed(value,unit,method):
    return {'value':value,'unit':unit,'estimated':True,'confidence':.25,'confidence_grade':'low',
        'method':method,'accuracy_verified':False}


def continuous(rows):
    return len(rows)>=5 and rows[-1][0]-rows[0][0]>=.4-1e-8 and max((b[0]-a[0] for a,b in zip(rows,rows[1:])),default=99)<=.25


def review_batter(result,review:BatterReview):
    duration=result['validation_summary']['metadata']['duration_seconds']
    if any(w.end>duration for w in review.windows):raise ValueError('Review window exceeds source duration')
    mappings={m['clip_time']:m for m in result['source_time_mapping']}
    body_allowed=(result['target_tracking']['selection']['confirmed_by_user'] and
        result['target_tracking']['selection']['viewpoint']=='third_person')
    plays=[]
    for number,w in enumerate(review.windows,1):
        core=[];hands=[];both=[];elbows=[]
        for s in result['pose'] if body_allowed else []:
            m=mappings.get(s['time_seconds'])
            if not m or not w.start<=m['source_time']<=w.end:continue
            p=s['landmarks'];aspect=s['aspect_ratio']
            if not all(visible_joint(s,i) for i in [0,11,12,23,24]):continue
            xy=np.array([[v['x']*aspect,v['y']] for v in p])
            shoulders=(xy[11]+xy[12])/2;hips=(xy[23]+xy[24])/2
            scale=float(np.linalg.norm(shoulders-hips))
            if scale<1e-5:continue
            core.append((m['source_time'],(xy[0]-shoulders)/scale,m['frame_index']))
            if all(visible_joint(s,i) for i in [12,14,16]):
                hands.append((m['source_time'],(xy[16]-shoulders)/scale,m['frame_index']))
                a=angle(xy[12],xy[14],xy[16])
                if a is not None:elbows.append((m['source_time'],a,m['frame_index']))
            if all(visible_joint(s,i) for i in [13,14,15,16]):both.append(m['source_time'])
        reason='Insufficient continuous visible-joint pose in manual review window'
        head=withheld(reason);hand=withheld(reason);elbow=withheld(reason)
        if continuous(core):
            head=observed(float(max(np.linalg.norm(r[1]-core[0][1]) for r in core)),
                'projected_torso_lengths','Max head relative to shoulder-center displacement; camera rotation/perspective uncorrected, not head-stability grade')
        if continuous(hands):
            hand=observed([{'source_time':t,'xy':xy.tolist(),'frame':i} for t,xy,i in hands],
                'projected_torso_lengths','Visible right wrist relative to shoulders; not bat path or bat speed')
        if continuous(elbows):
            elbow=observed(float(np.ptp([r[1] for r in elbows])),'degrees','Visible right-arm 2D elbow angle range; not physical power')
        frame_numbers=[r[2] for r in core]
        three=result['visualization']['pose3d']['frames']
        available=[f['frame'] for f in three if f['frame'] in frame_numbers and f['joints']]
        plays.append({'number':number,'role':'batter','role_source':'manual_visual_review',
            'review_window':w.model_dump(),'estimated':True,'confidence':.5,'confidence_grade':'low',
            'swing_start':withheld('Manual review envelope is not detected swing onset'),
            'swing_end':withheld('Manual review envelope is not detected swing end'),
            'swing_path':withheld('No verified bat object tracking; hand path is not bat path'),
            'swing_type':withheld('No verified bat swing path or calibrated view'),
            'head_displacement_2d_proxy':head,'right_hand_path_2d_proxy':hand,
            'right_elbow_angle_range_2d':elbow,'both_arm_visible_samples':len(both),
            'contact':withheld('Ball/bat collision and contact outcome unverified'),
            'contact_score':None,'power_score':None,
            'lower_body_power_proxy':withheld('Insufficient full-body pose; no force inference'),
            'references':{'source_start':w.start,'source_end':w.end,'source_frames':[mappings[s['time_seconds']]['source_frame_index'] for s in result['pose'] if s['time_seconds'] in mappings and mappings[s['time_seconds']]['frame_index'] in frame_numbers],
                'overlay_video_url':result['visualization']['overlay_video_url'],'estimated_3d_frames':available}})
    return {'source':'manual_visual_review_windows_visible_joint_diagnostics_v1',
        'estimated':True,'accuracy_verified':False,'manual_role':'batter',
        'automatic_role':result['automatic_role_estimate'],
        'bat_trail':withheld('Colored effects have not been identified as bat trail; no trail detector'),
        'bat_object_tracking':withheld('Visible wooden bat was manually observed; no automatic object tracker'),
        'bat_speed':None,'contact_score':None,'power_score':None,
        'swing_consistency':withheld('Insufficient verified bat/two-hand trajectories; repeated visible movements alone do not establish consistency'),
        'plays':plays,'warning':'Review windows/upper-body image inputs only. No new performance assessment, precise swing timing, actual contact, bat path or real 3D reconstruction.'}
