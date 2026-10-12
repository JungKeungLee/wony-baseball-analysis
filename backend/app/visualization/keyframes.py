import numpy as np
from app.analysis.shared.angles import angle
from app.analysis.shared.confidence import metric
from app.analysis.shared.pose_metrics import pose_rows, max_motion, range_rotation
from .joints import JOINTS

PHASES = {
    'batter': ['stance', 'load', 'front_foot_landing', 'swing_start', 'estimated_impact', 'follow_through'],
    'pitcher': ['setup', 'leg_lift', 'stride', 'arm_cocking', 'release', 'follow_through'],
}
HIGHLIGHT_JOINTS = {
    'head_stability_score': ['head'],
    'balance': ['left_hip', 'right_hip', 'left_ankle', 'right_ankle'],
}


def qualified_highlights(result):
    """Only engine-supported weaknesses with high confidence can produce warning colors."""
    highlights = []
    for issue in result.get('weaknesses', []):
        key = issue.get('metric')
        m = result.get('metrics', {}).get(key, {})
        score = min(issue.get('confidence', 0), m.get('confidence', 0))
        if key in HIGHLIGHT_JOINTS and m.get('value') is not None and score >= .75:
            highlights.append(dict(metric=key, joints=HIGHLIGHT_JOINTS[key],
                                   confidence=score, estimated=True, text=issue['text']))
    return highlights


def keyframe_angles(sample, first_sample, hand):
    rows = pose_rows([sample], hand, profile='pitcher')
    if not rows:
        return {}
    r = rows[0]
    c = min(r['visibility'] * .6, .6)
    knees = [angle(r['xy'][a], r['xy'][b], r['xy'][d]) for a, b, d in [(23,25,27),(24,26,28)]]
    output = {
        'shoulder_angle': metric(r['shoulder'], 'degrees', '2D hip/throwing-shoulder/elbow angle', c),
        'elbow_angle': metric(r['elbow'], 'degrees', '2D throwing-arm elbow angle', c),
        'knee_flexion': metric(180-float(np.mean(knees)) if all(k is not None for k in knees) else None,
                               'degrees', 'Mean 2D knee flexion', c),
        'trunk_lean': metric(r['lean'], 'degrees', 'Projected torso inclination', c),
    }
    first_rows = pose_rows([first_sample], hand, profile='pitcher')
    rotation = range_rotation([first_rows[0], r], 23, 24) if first_rows else None
    output['hip_rotation'] = metric(rotation, 'degrees', 'Projected hip-line change from first frame; not axial 3D rotation', .2)
    return output


def select_keyframes(samples_by_frame, result):
    role, hand = result['role'], result.get('throwing_hand', 'right')
    samples = list(samples_by_frame.values())
    rows = pose_rows(samples, hand, profile='pitcher' if role == 'pitcher' else 'general')
    stages = PHASES.get(role, ['ready', 'action', 'finish'])
    phases_allowed=result.get('phase_evidence_gate',{}).get('allow_phase_candidates',True)
    if not phases_allowed:
        stages=['pose_reference'];rows=pose_rows(samples,hand)
    selected = {stage: None for stage in stages}
    methods = {}
    reference = set()
    if not phases_allowed:reference.add('pose_reference')
    if rows:
        selected[stages[0]] = rows[0]
        methods[stages[0]] = 'First usable pose; phase is an unverified candidate'
    peak = max_motion(rows)
    if phases_allowed and peak is not None and role in PHASES:
        before = rows[:peak+1]
        if role == 'batter':
            load = int(np.argmax([r['knee'] for r in before]))
            selected.update(load=before[load], front_foot_landing=rows[max(load, peak-1)],
                            swing_start=rows[max(load, peak-1)], estimated_impact=rows[peak])
            methods.update(load='Largest pre-swing projected knee flexion',
                           front_foot_landing='Reference frame only; lead foot and landing are not detected',
                           swing_start='Frame before fastest hand-center motion; not verified swing onset',
                           estimated_impact='Reference at fastest hand motion; bat/ball contact not detected')
            reference.update(['front_foot_landing', 'estimated_impact'])
        else:
            lift = int(np.argmax([float(np.max(r['hips'][1]-r['ankles'][:,1])) for r in before]))
            stride = lift+int(np.argmax([r['stance'] for r in before[lift:]]))
            cocking = stride+int(np.argmin([r['elbow'] if r['elbow'] is not None else 180 for r in before[stride:]]))
            selected.update(leg_lift=before[lift], stride=before[stride], arm_cocking=before[cocking], release=rows[peak])
            methods.update(leg_lift='Highest ankle relative to hip before hand-motion peak',
                           stride='Largest ankle separation after lift candidate',
                           arm_cocking='Smallest projected throwing-elbow angle after stride candidate',
                           release='Fastest throwing-wrist motion; ball release not detected')
        if peak < len(rows)-1:
            selected['follow_through'] = rows[-1]
            methods['follow_through'] = 'Last usable pose after hand-motion peak'
    elif rows and role not in PHASES:
        if result.get('events'):
            timestamp = result['events'][0]['timestamp']
            selected['action'] = min(rows, key=lambda r: abs(r['t']-timestamp))
            methods['action'] = 'Nearest pose to unverified action event candidate'
        if len(rows) > 1:
            selected['finish'] = rows[-1]
            methods['finish'] = 'Last usable pose; no play-success inference'
    first_sample = samples[0] if samples else None
    output = []
    highlights = qualified_highlights(result)
    for stage, row in selected.items():
        entry = dict(stage=stage, frame=None, timestamp=None, estimated=True,
                     confidence=0.0, confidence_grade='low', phase_detected=False,
                     status='unavailable', reason='Insufficient pose or motion for phase candidate',
                     angles={}, highlights=[], image_url=None)
        if row is not None:
            index = min(samples_by_frame, key=lambda i: abs(samples_by_frame[i]['time_seconds']-row['t']))
            entry.update(frame=index, timestamp=row['t'], status='reference_only' if stage in reference else 'candidate',
                         confidence=0.0 if stage in reference else .2,
                         reason=methods[stage], angles=keyframe_angles(samples_by_frame[index], first_sample, hand),
                         highlights=[h for h in highlights if
                                     (h['metric'] == 'balance' and row is rows[-1]) or
                                     (h['metric'] == 'head_stability_score' and row is max(rows, key=lambda r: np.linalg.norm(r['head']-rows[0]['head'])))])
        output.append(entry)
    return output
