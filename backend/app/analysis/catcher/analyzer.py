import numpy as np
from app.analysis.shared.confidence import metric, missing, feedback
from app.analysis.shared.pose_metrics import pose_rows
from app.analysis.shared.fielding import fielding_metrics
from app.analysis.shared.event_utils import event

METRICS = ['ready_stance','knee_flexion','center_height','center_position','trunk_height',
           'mitt_start_position','receiving_posture','mitt_movement','framing',
           'low_blocking_posture','lateral_blocking','throwing_preparation','standing_up',
           'transition_time','upper_body_rotation','balance','receive_success',
           'blocking_success','throw_start_time','second_base_preparation','glove_tracking']
UNSUPPORTED = ['receiving_posture','framing','throwing_preparation','transition_time',
               'receive_success','blocking_success','throw_start_time','second_base_preparation']


def analyze(samples, throwing_hand='right', **kwargs):
    rows = pose_rows(samples,throwing_hand)
    m = missing(METRICS)
    for key in UNSUPPORTED:
        m[key] = metric(reason='Ball/mitt detection, catch event or target calibration required; not supported')
    # mitt_* values below come from the glove-side wrist. They are hand observations, never glove tracking.
    m['glove_tracking'] = metric(reason='No glove/mitt object detector; mitt_* metrics are glove-side wrist observations, not glove positions')
    events = []
    if len(rows)>=3:
        common, idx = fielding_metrics(rows)
        for k in ['ready_stance','knee_flexion','center_height','center_position','balance','upper_body_rotation']:
            m[k] = common[k]
        m['mitt_start_position'], m['mitt_movement'] = common['glove_position'], common['glove_movement']
        first,last = rows[0],rows[-1]
        c = min(r['confidence'] for r in rows)
        m['trunk_height'] = metric(float((np.mean(first['ankles'][:,1])-first['shoulders'][1])/first['torso']),
                                  'torso_lengths','Image shoulder height relative to ankles', c)
        m['standing_up'] = metric(float((first['hips'][1]-min(r['hips'][1] for r in rows))/first['torso']),
                                 'torso_lengths','Image-up hip displacement; not verified stand-up event', .25)
        # A catcher's ready stance is already a deep crouch, and settling into it from a higher stance shows
        # the same 2D change (more knee flexion, lower hip) as dropping to block. Without ball/bounce evidence
        # pose alone cannot tell them apart, so no blocking candidate is produced (real clips: all false positives).
        m['low_blocking_posture'] = metric(reason='Blocking cannot be separated from a normal crouch or settling into the '
            'ready stance from pose alone; ball/bounce evidence required. Knee flexion and hip height are reported separately')
        m['lateral_blocking'] = common['lateral_movement']
        if idx is not None:
            events.append(event(rows[idx],'catcher','receive',{'mitt_movement':m['mitt_movement']}, .15))
    summary = {k:m[k] for k in ['ready_stance','knee_flexion','balance']}
    return dict(role='catcher',summary=summary,
                receiving={k:m[k] for k in ['receiving_posture','mitt_start_position','mitt_movement','glove_tracking','framing','receive_success']},
                blocking={k:m[k] for k in ['low_blocking_posture','lateral_blocking','blocking_success']},
                throwing_transition={k:m[k] for k in ['standing_up','throwing_preparation','transition_time','throw_start_time','second_base_preparation']},
                metrics=m,events=events,usable_pose_frames=len(rows), **feedback(m))
