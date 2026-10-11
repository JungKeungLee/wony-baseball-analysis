from app.analysis.shared.confidence import metric, missing, feedback
from app.analysis.shared.pose_metrics import pose_rows
from app.analysis.shared.fielding import fielding_metrics
from app.analysis.shared.event_utils import event
from . import infielder, outfielder

METRICS = ['ready_stance','knee_flexion','center_height','center_position','first_step_direction',
           'first_step_time','reaction_time','lateral_movement','depth_movement','ball_direction_response',
           'fielding_center','glove_position','glove_movement','catch_in_front','forehand_backhand',
           'throwing_transition','throwing_preparation','footwork','balance','end_stability','upper_body_rotation']
UNSUPPORTED = ['ball_direction_response','fielding_center','catch_in_front','forehand_backhand',
               'throwing_transition','throwing_preparation']


def analyze(samples, throwing_hand='right', position_type='auto', **kwargs):
    rows = pose_rows(samples,throwing_hand)
    m = missing(METRICS)
    for key in UNSUPPORTED:
        m[key]=metric(reason='Ball/glove/field calibration or verified catch required; not supported')
    events=[]
    if len(rows)>=3:
        common,idx=fielding_metrics(rows)
        m.update(common)
        if idx is not None:
            events.append(event(rows[idx],'defense','fielding',{'glove_position':m['glove_position']}, .15))
    # Pose alone cannot reliably distinguish infield from outfield.
    position = position_type if position_type != 'auto' else 'unknown'
    return dict(role='defense',position_type=position,
                position_estimate=metric(position,None,'Manual position hint' if position!='unknown' else 'Pose-only position inference unavailable', .0),
                position_source='manual' if position!='unknown' else 'unknown',
                position_candidates=[] if position!='unknown' else [metric('infielder',confidence=.0),metric('outfielder',confidence=.0)],
                summary={k:m[k] for k in ['first_step_direction','knee_flexion','balance','end_stability']},
                fielding={k:m[k] for k in ['first_step_direction','glove_position','catch_in_front','forehand_backhand','throwing_transition']},
                tracking=outfielder.details(), catching={'catch_in_front':m['catch_in_front']},
                throwing_transition={'preparation':m['throwing_preparation'],'transition':m['throwing_transition']},
                infield=infielder.details(), metrics=m,events=events,usable_pose_frames=len(rows), **feedback(m))
