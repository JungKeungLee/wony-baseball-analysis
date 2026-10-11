from pathlib import Path
import subprocess
import cv2


class InvalidVideo(ValueError):
    pass


def extract_frames(path: Path, max_duration=60, sample_fps=10):
    """Decode bounded, normalized frames. No shell execution or original timestamps assumed."""
    normalized = path.with_suffix('.normalized.mp4')
    try:
        subprocess.run(
            ['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', str(path),
             '-t', str(max_duration + 1), '-an', '-vf',
             f'scale=320:320:force_original_aspect_ratio=decrease,fps={sample_fps}',
             '-c:v', 'mpeg4', str(normalized)],
            check=True, capture_output=True, timeout=90,
        )
        cap = cv2.VideoCapture(str(normalized))
        frames = []
        try:
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                frames.append((len(frames) / sample_fps, frame))
                if len(frames) > max_duration * sample_fps:
                    raise InvalidVideo(f'Video must be at most {max_duration} seconds')
        finally:
            cap.release()
        if not frames:
            raise InvalidVideo('No decodable video frames')
        return frames
    except (subprocess.SubprocessError, OSError) as exc:
        raise InvalidVideo('Video decoding failed or timed out') from exc
    finally:
        normalized.unlink(missing_ok=True)
