import numpy as np
from .joints import JOINTS, EDGES


def project_pose(sample, frame, timestamp):
    """Illustrative lifting using MediaPipe relative z; no calibrated 3D reconstruction."""
    output = dict(frame=frame, timestamp=timestamp, estimated=True,
                  confidence=0.0, confidence_grade='low', joints={}, joint_confidence={})
    if sample is None:
        output['reason'] = 'No detected pose at this frame'
        return output
    points = sample['landmarks']
    if min(points[i]['visibility'] for i in (11, 12, 23, 24)) < .5:
        output['reason'] = 'Shoulder/hip visibility too low for a reliable visual anchor'
        return output
    aspect = sample['aspect_ratio']
    hips = np.mean([[points[i]['x'] * aspect, points[i]['y'],
                    points[i].get('z', 0) * aspect] for i in (23, 24)], axis=0)
    shoulders = np.mean([[points[i]['x'] * aspect, points[i]['y']] for i in (11, 12)], axis=0)
    scale = float(np.linalg.norm(shoulders - hips[:2]))
    if not np.isfinite(scale) or scale < 1e-5:
        output['reason'] = 'Degenerate torso scale'
        return output
    for name, index in JOINTS.items():
        p = points[index]
        values = np.array([p['x'] * aspect, p['y'], p.get('z', 0) * aspect]) - hips
        confidence = float(np.clip(p['visibility'], 0, 1) * .35)
        if not np.isfinite(values).all() or not np.isfinite(confidence) or p['visibility'] < .5:
            continue
        output['joints'][name] = [float(values[0]/scale), float(-values[1]/scale), float(-values[2]/scale)]
        output['joint_confidence'][name] = round(confidence, 3)
    output['confidence'] = min(output['joint_confidence'].values(), default=0.0)
    return output


def pose3d_sequence(frames, samples_by_frame):
    sequence = [project_pose(samples_by_frame.get(i), i, t) for i, (t, _) in enumerate(frames)]
    scores = [frame['confidence'] for frame in sequence if frame['joints']]
    return {
        'estimated': True, 'confidence': min(scores, default=0.0),
        'confidence_grade': 'low', 'units': 'visual_torso_lengths',
        'coordinate_system': 'Hip centered; x=image right, y=image up, z=toward camera',
        'method': 'Image x/y and MediaPipe relative z scaled by projected torso length; not true 3D or metric depth',
        'warning': 'Estimated illustrative pose. VR avatar animation is not actual human biomechanics.',
        'edges': EDGES,
        'frames': sequence,
    }
