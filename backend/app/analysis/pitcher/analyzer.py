"""Single-camera 2D proxies, not biomechanical or ball-speed measurements."""
import numpy as np
from app.analysis.shared.angles import angle
from app.analysis.shared.confidence import metric, missing
from app.analysis.shared.pose_metrics import pose_rows, max_motion


METRICS = ['ready_stance', 'arm_angle', 'elbow_angle', 'shoulder_angle',
           'torso_lean', 'stride', 'lower_body_use', 'weight_transfer',
           'release_time', 'follow_through', 'balance', 'pitching_style']


def analyze(samples, throwing_hand='right'):
    metrics = missing(METRICS)
    rows = pose_rows(samples, throwing_hand, profile='pitcher')
    if len(rows) < 3:
        return {'metrics': metrics, 'ball_speed': None, 'usable_pose_frames': len(rows)}
    motion_index = max_motion(rows)
    index = motion_index if motion_index is not None else 0
    release = rows[index]
    confidence = float(min(r['visibility'] for r in rows) * 0.65)

    def put(name, value, unit, method, certainty=confidence):
        metrics[name] = metric(value, unit, method, certainty)

    put('ready_stance', rows[0]['stance'], 'torso_lengths', 'First usable frame ankle separation')
    for name, key in [('arm_angle', 'arm'), ('elbow_angle', 'elbow'),
                      ('shoulder_angle', 'shoulder'), ('torso_lean', 'lean')]:
        put(name, release[key], 'degrees', '2D angle at wrist-motion candidate or first frame if no motion')
    put('stride', max(r['stance'] for r in rows), 'torso_lengths', 'Maximum ankle separation / torso length')
    knees = [r['pitcher_knee'] for r in rows if r['pitcher_knee'] is not None]
    put('lower_body_use', max(knees)-min(knees) if knees else None, 'degrees', 'Left knee angle range; motion proxy only')
    put('weight_transfer', (release['hip_x']-rows[0]['hip_x'])/rows[0]['torso'],
        'torso_lengths', 'Horizontal hip displacement; not force or actual weight distribution', 0.2)
    if motion_index is not None:
        put('release_time', release['t'], 'seconds', 'Maximum sampled 2D wrist speed; ball release unverified', 0.2)
    else:
        metrics['release_time'] = metric(reason='No significant wrist motion; release candidate unavailable')
    after = rows[index+1:]
    if after:
        put('follow_through', float(np.linalg.norm(after[-1]['wrist']-release['wrist'])/release['torso']),
            'torso_lengths', 'Wrist displacement after candidate release', 0.25)
    put('balance', float(abs(release['hips'][0]-np.mean(release['ankles'][:, 0]))/release['torso']),
        'torso_lengths', 'Hip offset from ankle midpoint; smaller is more centered', 0.25)
    arm = release['arm']
    style = 'overhand' if arm > 60 else 'three_quarter' if arm > 30 else 'sidearm' if arm > -10 else 'submarine'
    put('pitching_style', style, None, 'Heuristic throwing-arm elevation in image plane', 0.2)
    return {'metrics': metrics, 'ball_speed': None, 'usable_pose_frames': len(rows)}
