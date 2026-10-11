import numpy as np
from app.analysis.shared.angles import angle
from app.analysis.shared.confidence import metric, missing, feedback
from app.analysis.shared.pose_metrics import pose_rows, max_motion, range_rotation
from app.analysis.shared.event_utils import event

METRICS = ['stance_type','stance_width','knee_flexion','trunk_lean','bat_start_position',
           'leg_kick','front_foot_landing_time','weight_transfer_score','hip_rotation',
           'shoulder_rotation','head_stability_score','hands_lead','swing_type',
           'impact_time','elbow_angle','wrist_angle','follow_through','balance',
           'whiff','contact','foul_or_in_play','pull_or_opposite']
UNSUPPORTED = ['stance_type','bat_start_position','front_foot_landing_time','hands_lead',
               'impact_time','wrist_angle','whiff','contact','foul_or_in_play','pull_or_opposite']


def analyze(samples, throwing_hand='right', **kwargs):
    rows = pose_rows(samples, throwing_hand)
    m = missing(METRICS)
    for key in UNSUPPORTED:
        m[key] = metric(reason='Requires calibrated field direction, bat/ball detection, or hand landmarks; not supported')
    events = []
    if len(rows) >= 3:
        first, last = rows[0], rows[-1]
        c = min(r['confidence'] for r in rows)
        def put(k, v, unit, method, score=c):
            m[k] = metric(v, unit, method, score)
        put('stance_width', first['stance'], 'torso_lengths', 'First usable ankle separation')
        put('knee_flexion', first['knee'], 'degrees', '180 minus mean 2D knee angle')
        put('trunk_lean', first['lean'], 'degrees', 'Image-plane torso inclination')
        ankle_rise = max(float(np.max(first['ankles'][:,1]-r['ankles'][:,1]))/first['torso'] for r in rows)
        put('leg_kick', ankle_rise > .2, None, 'Any ankle image-up movement > 0.2 torso lengths; camera-sensitive', .25)
        put('weight_transfer_score', float(np.linalg.norm(last['hips']-first['hips'])/first['torso']),
            'torso_lengths', 'Hip displacement proxy; not actual weight distribution', .2)
        put('hip_rotation', range_rotation(rows,23,24), 'degrees', 'Image-plane hip-line orientation range; not axial 3D rotation', .2)
        put('shoulder_rotation', range_rotation(rows,11,12), 'degrees', 'Image-plane shoulder-line orientation range', .2)
        put('head_stability_score', max(float(np.linalg.norm(r['head']-first['head'])/first['torso']) for r in rows),
            'torso_lengths', 'Maximum image-plane head displacement; camera must be fixed')
        put('balance', last['balance'], 'torso_lengths', 'Final hip offset from ankle midpoint')
        idx = max_motion(rows)
        if idx is not None:
            r, prev = rows[idx], rows[idx-1]
            delta = r['wrist']-prev['wrist']
            slope = -delta[1]/max(abs(delta[0]),1e-6)
            kind = 'uppercut' if slope > .3 else 'downswing' if slope < -.3 else 'level'
            put('swing_type', kind, None, 'Fastest hand-center segment vertical slope; bat path unverified', .2)
            a,b,d = (12,14,16) if throwing_hand=='right' else (11,13,15)
            put('elbow_angle', angle(r['xy'][a],r['xy'][b],r['xy'][d]), 'degrees', '2D throwing-side elbow at swing candidate')
            if idx < len(rows)-1:
                put('follow_through', float(np.linalg.norm(last['wrist']-r['wrist'])/r['torso']),
                    'torso_lengths', 'Hand-center displacement after candidate swing', .25)
            events.append(event(r,'batter','swing',{'swing_type':m['swing_type']}, .2))
    summary = {k:m[k] for k in ['stance_type','swing_type']}
    head = m['head_stability_score']
    summary['head_stability'] = metric('stable_in_image' if head['value'] <= .15 else 'moving_in_image',
        method='Threshold on head displacement', confidence=head['confidence']) if head['value'] is not None else metric(reason='Insufficient pose')
    summary['weight_transfer'] = m['weight_transfer_score']
    return dict(role='batter',summary=summary,metrics=m,events=events,
                usable_pose_frames=len(rows), **feedback(m))
