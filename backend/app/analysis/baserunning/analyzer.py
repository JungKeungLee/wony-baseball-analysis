"""Single-camera posture observations; no field-calibrated running performance."""
from app.analysis.shared.confidence import metric, missing, feedback
from app.analysis.shared.pose_metrics import pose_rows, max_motion
from app.analysis.shared.fielding import fielding_metrics
from app.analysis.shared.event_utils import event

METRICS = ['start_reaction', 'acceleration', 'running_posture', 'direction_change',
           'base_approach', 'sliding', 'decision_making', 'balance', 'first_movement_time']


def analyze(samples, throwing_hand='right', **kwargs):
    rows = pose_rows(samples, throwing_hand)
    metrics = missing(METRICS)
    reasons = {
        'start_reaction': 'Start stimulus is not detected',
        'acceleration': 'Calibrated distance, camera motion compensation and tracked runner required',
        'direction_change': 'Field/world direction is not calibrated',
        'base_approach': 'Base positions and approach event are not detected',
        'sliding': 'No validated sliding classifier',
        'decision_making': 'Game situation, ball and other runners are not tracked',
    }
    for key, reason in reasons.items():
        metrics[key] = metric(reason=reason)
    events = []
    if len(rows) >= 3:
        common, _ = fielding_metrics(rows)
        metrics['running_posture'] = metric(rows[0]['lean'], 'degrees',
            'Initial image-plane torso inclination; not confirmed running form', rows[0]['confidence'])
        metrics['balance'] = common['balance']
        metrics['first_movement_time'] = common['first_step_time']
        index = max_motion(rows, 'hips')
        if index is not None:
            events.append(event(rows[index], 'baserunning', 'run',
                                {'running_posture': metrics['running_posture']}, .2))
    return dict(role='baserunning', metrics=metrics,
        summary={key: metrics[key] for key in ['running_posture', 'balance', 'first_movement_time']},
        events=events, usable_pose_frames=len(rows), **feedback(metrics))
