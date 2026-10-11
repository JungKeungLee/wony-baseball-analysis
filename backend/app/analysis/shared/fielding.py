import numpy as np
from .confidence import metric
from .pose_metrics import max_motion, range_rotation


def fielding_metrics(rows):
    first, last = rows[0], rows[-1]
    c = min(r['confidence'] for r in rows)
    def m(value, unit, method, score=c):
        return metric(value, unit, method, score)
    hip_delta = last['hips']-first['hips']
    moves = [np.linalg.norm(r['hips']-first['hips'])/first['torso'] for r in rows]
    first_step = next((i for i,v in enumerate(moves) if v > .1), None)
    direction = None
    if first_step is not None:
        delta = rows[first_step]['hips'] - first['hips']
        if abs(delta[0]) >= abs(delta[1]):
            direction = 'image_right' if delta[0] > 0 else 'image_left'
        else:
            direction = 'image_down' if delta[1] > 0 else 'image_up'
    idx = max_motion(rows, 'glove')
    return {
        'ready_stance': m(first['stance'],'torso_lengths','Initial ankle separation'),
        'knee_flexion': m(first['knee'],'degrees','Initial mean 2D knee flexion'),
        'center_height': m(float((np.mean(first['ankles'][:,1])-first['hips'][1])/first['torso']),
                           'torso_lengths','Hip height relative to ankles in image'),
        'center_position': m(first['balance'],'torso_lengths','Hip horizontal offset from ankle midpoint'),
        'lateral_movement': m(float(hip_delta[0]/first['torso']),'torso_lengths','Signed image-horizontal hip displacement', .3),
        'depth_movement': metric(reason='Forward/back direction requires calibrated camera and field; unavailable'),
        'first_step_direction': m(direction,
                                  None,'Hip displacement beyond 0.1 torso lengths; image coordinates', .25)
                                  if first_step is not None else metric(reason='No significant hip movement'),
        'first_step_time': m(rows[first_step]['t'],'seconds','First hip motion relative to clip; not stimulus reaction time', .25)
                           if first_step is not None else metric(reason='No significant hip movement'),
        'reaction_time': metric(reason='Ball contact/stimulus timestamp is not detected'),
        'glove_position': m(float(np.linalg.norm(first['glove']-first['hips'])/first['torso']),
                             'torso_lengths','Non-throwing wrist relative to hip; glove not detected', .25),
        'glove_movement': m(max(float(np.linalg.norm(r['glove']-first['glove'])/first['torso']) for r in rows),
                             'torso_lengths','Non-throwing wrist movement proxy', .25),
        'balance': m(last['balance'],'torso_lengths','Final hip offset from ankle midpoint'),
        'end_stability': m(max(float(np.linalg.norm(r['hips']-last['hips'])/last['torso']) for r in rows[-3:]),
                           'torso_lengths','Hip spread over final three usable frames'),
        'footwork': m(sum(float(np.linalg.norm(b['ankles']-a['ankles'])/first['torso'])
                          for a,b in zip(rows,rows[1:])), 'torso_lengths','Accumulated 2D ankle motion; not step count', .3),
        'upper_body_rotation': m(range_rotation(rows,11,12),'degrees','Image-plane shoulder-line range', .2),
    }, idx
