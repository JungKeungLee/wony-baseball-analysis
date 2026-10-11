from .batter.analyzer import analyze as batter
from .defense.analyzer import analyze as defense
from .catcher.analyzer import analyze as catcher
from .pitcher.analyzer import analyze as pitcher
from .baserunning.analyzer import analyze as baserunning
from .shared.confidence import metric, feedback
from .shared.pose_metrics import pose_rows, max_motion
from .shared.event_utils import event

ANALYZERS = {'batter':batter,'defense':defense,'catcher':catcher,'pitcher':pitcher,'baserunning':baserunning}


def analyze_role(samples, role='pitcher', hand='right', position_type='auto'):
    if role == 'auto':
        return dict(role='unknown',requested_role='auto',status='unknown_role',
                    role_candidates=[metric(name,confidence=0,reason=None) for name in ANALYZERS],
                    summary={},metrics={},events=[],strengths=[],weaknesses=[],coaching=[],
                    usable_pose_frames=len(pose_rows(samples,hand)),
                    role_estimate=metric('unknown',method='Automatic role classification is not implemented'))
    if role not in ANALYZERS:
        raise ValueError('Unsupported role')
    result = ANALYZERS[role](samples,hand) if role=='pitcher' else ANALYZERS[role](samples,hand,position_type=position_type)
    if role=='pitcher':
        result['role']='pitcher'
        result['summary']={k:result['metrics'][k] for k in ['pitching_style','balance']}
        result.update(feedback(result['metrics']))
        rows=pose_rows(samples,hand,profile='pitcher')
        idx=max_motion(rows)
        result['events']=[]
        if idx is not None and result['metrics']['release_time']['value'] is not None:
            value=result['metrics']['release_time']['value']
            result['events']=[event({'t':value},'pitcher','release',{'release_time':result['metrics']['release_time']})]
    result['requested_role']=role
    result['status']='completed' if result['usable_pose_frames']>=3 else 'insufficient_pose'
    return result
