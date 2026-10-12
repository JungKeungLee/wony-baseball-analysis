"""Pose availability diagnostics, separate from anatomical accuracy."""
import math
from collections import Counter
from app.analysis.shared.pose_metrics import pose_rows

JOINTS={'head':0,'left_shoulder':11,'right_shoulder':12,'left_elbow':13,
 'right_elbow':14,'left_wrist':15,'right_wrist':16,'left_hip':23,'right_hip':24,
 'left_knee':25,'right_knee':26,'left_ankle':27,'right_ankle':28}


def visible_joint(sample,index,threshold=.6):
    try:
        p=sample['landmarks'][index]
        return all(math.isfinite(p[k]) for k in ('x','y','visibility')) and p['visibility']>=threshold and 0<=p['x']<=1 and 0<=p['y']<=1
    except (KeyError,IndexError,TypeError):return False


def quality_report(samples,sampled_frames):
    """All rates use sampled source frames as denominator, not detections only."""
    def rate(n):return round(n/sampled_frames,4) if sampled_frames else 0.0
    full=len(pose_rows(samples));pitcher=len(pose_rows(samples,profile='pitcher'))
    return {'visibility_threshold':.6,'denominator':sampled_frames,
        'pose_detection_rate':rate(len(samples)),'full_body_usable_rate':rate(full),
        'full_body_usable_frames':full,'pitcher_profile_usable_frames':pitcher,
        'joint_detection_rates':{name:{'usable_frames':sum(visible_joint(s,i) for s in samples),
            'rate':rate(sum(visible_joint(s,i) for s in samples)),
            'criterion':'finite in-frame landmark with visibility >= 0.6; not accuracy'} for name,i in JOINTS.items()},
        'outside_crop_predictions':sum(p.get('outside_pose_crop',False) for s in samples for p in s['landmarks']),
        'accuracy':None,'accuracy_verified':False}


def restrict_3d(visualization,samples):
    """Require the unchanged general pose gate. No filling missing limbs."""
    allowed={r['t'] for r in pose_rows(samples)}
    sequence=visualization['pose3d'];available=0
    for frame in sequence['frames']:
        accepted=any(abs(t-frame['timestamp'])<1e-6 for t in allowed)
        if not accepted:
            frame.update(joints={},joint_confidence={},confidence=0.0,
                reason='Full-body pose quality insufficient for estimated 3D visualization')
        elif frame['joints']:available+=1
        frame['visualization_available']=bool(frame['joints'])
        frame['accuracy']=None;frame['accuracy_verified']=False
    sequence.update(confidence=min((f['confidence'] for f in sequence['frames'] if f['joints']),default=0),
        available_frames=available,availability_rate=available/len(sequence['frames']) if sequence['frames'] else 0,
        accuracy=None,accuracy_verified=False,quality_gate='general pose_rows visibility >= 0.6; no imputation')
    return available


def gate_pitcher_phases(result,samples,context):
    """A recognized role is not evidence of a release or complete pitching phases."""
    if result['role']!='pitcher':return
    from app.analysis.shared.confidence import metric
    action=context.get('throwing_sequence',{}).get('evidence')
    rows=pose_rows([s for s in samples if action and action['start']<=s['time_seconds']<=action['end']])
    sufficient=(len(rows)>=5 and rows[-1]['t']-rows[0]['t']>=.4 and
        max((b['t']-a['t'] for a,b in zip(rows,rows[1:])),default=99)<=.25)
    result['phase_evidence_gate']={'allow_phase_candidates':sufficient,
        'full_body_action_samples':len(rows),'action_window':action,
        'release_verified':False,'estimated':True,
        'reason':None if sufficient else 'Insufficient continuous full-body pose during the detected arm sequence; role context alone cannot validate release/phases'}
    if not sufficient:
        reason=result['phase_evidence_gate']['reason']
        result['metrics']={name:metric(reason=reason) for name in result['metrics']}
        result['summary']={name:result['metrics'][name] for name in result['summary'] if name in result['metrics']}
        result.update(events=[],strengths=[],weaknesses=[],coaching=[])
