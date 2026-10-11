import numpy as np
from .angles import angle, inclination


def pose_rows(samples, hand='right', profile='general'):
    rows = []
    for s in samples:
        try:
            p = s['landmarks']
            xy = np.array([[v['x'] * s['aspect_ratio'], v['y']] for v in p], dtype=float)
            required = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]
            ids = [12,14,16] if hand == 'right' else [11,13,15]
            if profile == 'pitcher':
                required = [11,12,23,24,27,28]+ids
            visibility = min(p[i]['visibility'] for i in required)
            t = float(s['time_seconds'])
            if len(p) != 33 or not np.isfinite(xy).all() or not np.isfinite(t) or t < 0 or not np.isfinite(visibility) or visibility < .6 or s['aspect_ratio'] <= 0:
                continue
            shoulders, hips = (xy[11]+xy[12])/2, (xy[23]+xy[24])/2
            torso = float(np.linalg.norm(shoulders-hips))
            knees = [angle(xy[a], xy[b], xy[c]) for a,b,c in [(23,25,27),(24,26,28)]]
            if torso < 1e-5 or (profile != 'pitcher' and any(k is None for k in knees)):
                continue
            if rows and t <= rows[-1]['t']:
                continue
            wrist = xy[ids[2]] if profile == 'pitcher' else (xy[15]+xy[16])/2
            glove = xy[15 if hand == 'right' else 16]
            rows.append(dict(t=t, xy=xy, torso=torso, hips=hips, shoulders=shoulders,
                             wrist=wrist, glove=glove, head=xy[0], ankles=xy[[27,28]],
                             knee=180-float(np.mean(knees)) if all(k is not None for k in knees) else None, lean=inclination(shoulders-hips),
                             stance=float(np.linalg.norm(xy[27]-xy[28])/torso),
                             balance=float(abs(hips[0]-np.mean(xy[[27,28],0]))/torso),
                             confidence=min(float(visibility)*.6, .6),
                             visibility=float(visibility),
                             hip_x=float(hips[0]),
                             arm=float(np.degrees(np.arctan2(-(wrist-xy[ids[0]])[1],abs((wrist-xy[ids[0]])[0])))),
                             elbow=angle(xy[ids[0]],xy[ids[1]],xy[ids[2]]),
                             shoulder=angle(hips,xy[ids[0]],xy[ids[1]]),
                             pitcher_knee=angle(xy[23],xy[25],xy[27])))
        except (KeyError, IndexError, TypeError, ValueError):
            continue
    return rows


def max_motion(rows, key='wrist', threshold=.5):
    """Require visible movement; coordinates are normalized by initial torso."""
    if len(rows) < 3:
        return None
    speeds = [np.linalg.norm(b[key]-a[key]) / rows[0]['torso'] / (b['t']-a['t'])
              for a,b in zip(rows, rows[1:])]
    i = int(np.argmax(speeds))+1
    return i if speeds[i-1] >= threshold else None


def range_rotation(rows, a, b):
    if any(np.linalg.norm(r['xy'][b]-r['xy'][a]) < 1e-6 for r in rows):
        return None
    values = np.unwrap([np.arctan2((r['xy'][b]-r['xy'][a])[1],
                                  (r['xy'][b]-r['xy'][a])[0]) for r in rows])
    return float(np.degrees(np.ptp(values)))
