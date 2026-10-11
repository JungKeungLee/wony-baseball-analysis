from pathlib import Path
import subprocess
import tempfile
import cv2
import numpy as np
from .overlay import draw_overlay
from .pose3d import pose3d_sequence
from .keyframes import select_keyframes, keyframe_angles


def align_samples(frames, samples):
    output = {}
    if not frames:
        return output
    timestamps = np.array([t for t, _ in frames])
    for sample in samples:
        try:
            points = sample['landmarks']
            if len(points) != 33 or sample['aspect_ratio'] <= 0:
                continue
            if not all(np.isfinite([p['x'], p['y'], p.get('z', 0), p['visibility']]).all() for p in points):
                continue
            timestamp = sample['time_seconds']
            if not np.isfinite(timestamp):
                continue
            i = int(np.argmin(abs(timestamps-timestamp)))
            if abs(timestamps[i]-timestamp) <= .051:
                output[i] = sample
        except (KeyError, TypeError, ValueError):
            continue
    return dict(sorted(output.items()))


def build_visualization(frames, samples, result, root: Path):
    aligned = align_samples(frames, samples)
    keyframes = select_keyframes(aligned, result)
    pose3d = pose3d_sequence(frames, aligned)
    prefix = f"/api/analysis/{result['id']}/assets"
    if not frames:
        return dict(overlay_video_url=None, keyframes=keyframes, pose3d=pose3d,
                    frame_count=0, sample_fps=result['sample_fps'], warning_threshold=.75)
    destination = root / f"{result['id']}-assets"
    with tempfile.TemporaryDirectory(prefix='.visual-', dir=root) as temporary:
        folder = Path(temporary)
        first_sample = next(iter(aligned.values()), None)
        for i, (timestamp, frame) in enumerate(frames):
            keys = [key for key in keyframes if key['frame'] == i]
            event_types = [e['type']+' candidate' for e in result['events'] if abs(e['timestamp']-timestamp) <= .051]
            angles = keys[0]['angles'] if keys else {}
            if event_types and i in aligned and not angles:
                angles = keyframe_angles(aligned[i], first_sample, result['throwing_hand'])
            highlights = [h for key in keys for h in key['highlights']]
            labels = [key['stage']+' ('+key['status']+')' for key in keys] + event_types
            image = draw_overlay(frame, aligned.get(i), timestamp, labels, angles, highlights)
            if not cv2.imwrite(str(folder / f'frame-{i:04d}.jpg'), image):
                raise RuntimeError('Failed to encode overlay frame')
            for key in keys:
                filename = f'keyframe-{i:04d}.jpg'
                if not cv2.imwrite(str(folder / filename), image):
                    raise RuntimeError('Failed to save keyframe')
                key['image_url'] = f'{prefix}/{filename}'
        subprocess.run([
            'ffmpeg', '-nostdin', '-v', 'error', '-y', '-framerate', str(result['sample_fps']),
            '-i', str(folder/'frame-%04d.jpg'), '-an', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
            '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
            str(folder/'overlay.mp4'),
        ], check=True, capture_output=True, timeout=90)
        for path in folder.glob('frame-*.jpg'):
            path.unlink()
        if destination.exists():
            raise RuntimeError('Visualization destination already exists')
        folder.rename(destination)
    return dict(overlay_video_url=f'{prefix}/overlay.mp4', keyframes=keyframes,
                pose3d=pose3d, frame_count=len(frames), sample_fps=result['sample_fps'],
                frame_index_basis='zero-based sampled frames, not original source frame numbers',
                warning_threshold=.75,
                warnings=['Keyframes are heuristic candidates or unverified reference frames.',
                          '3D relative depth is illustrative, uncalibrated and always estimated.'])
