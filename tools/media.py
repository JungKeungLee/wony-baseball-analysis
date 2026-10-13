"""ffmpeg/ffprobe 헬퍼. 원본 파일은 읽기만 하고 절대 수정하지 않는다."""
import io
import json
import shutil
import subprocess

import numpy as np


class MediaError(RuntimeError):
    pass


def _tool(name):
    path = shutil.which(name)
    if not path:
        raise MediaError(f'{name} 를 찾을 수 없습니다. ffmpeg 를 설치하고 PATH 에 추가해주세요.')
    return path


def _run(args, *, timeout=600, binary=False):
    try:
        proc = subprocess.run(args, capture_output=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired as exc:
        raise MediaError('ffmpeg 처리 시간이 너무 오래 걸립니다.') from exc
    if proc.returncode != 0:
        err = proc.stderr.decode('utf-8', 'replace').strip().splitlines()
        raise MediaError(err[-1] if err else f'ffmpeg exit {proc.returncode}')
    return proc.stdout if binary else proc.stdout.decode('utf-8', 'replace')


def _float(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def probe(path):
    """영상 정보. duration(초), 코덱, 크기, 오디오 유무, 스트림 시작 시각."""
    out = _run([_tool('ffprobe'), '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', str(path)],
               timeout=60)
    data = json.loads(out or '{}')
    streams = data.get('streams') or []
    video = next((s for s in streams if s.get('codec_type') == 'video' and not s.get('disposition', {}).get('attached_pic')), None)
    audio = next((s for s in streams if s.get('codec_type') == 'audio'), None)
    duration = _float((data.get('format') or {}).get('duration')) or _float((video or {}).get('duration'))
    return {
        'duration': duration,
        'has_video': video is not None,
        'has_audio': audio is not None,
        'vcodec': (video or {}).get('codec_name'),
        'acodec': (audio or {}).get('codec_name'),
        'width': int((video or {}).get('width') or 0),
        'height': int((video or {}).get('height') or 0),
        'video_start': _float((video or {}).get('start_time')),
        'audio_start': _float((audio or {}).get('start_time')),
    }


def prepare_web_video(src, dst, info):
    """브라우저에서 바로 재생 가능한 MP4 로 만든다 (원본 timeline 유지).

    H.264 + AAC/MP3 면 재인코딩 없이 복사만 하고 moov 를 앞으로 옮긴다 (faststart: preload=metadata 로 빨리 열림).
    그 외 코덱(HEVC 등)은 H.264/AAC 로 변환한다.
    """
    base = [_tool('ffmpeg'), '-v', 'error', '-y', '-i', str(src), '-map', '0:v:0', '-map', '0:a:0', '-sn', '-dn',
            '-map_metadata', '-1']
    if info['vcodec'] == 'h264' and info['acodec'] in ('aac', 'mp3'):
        codec = ['-c', 'copy']
    else:
        codec = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k']
    _run(base + codec + ['-movflags', '+faststart', str(dst)], timeout=1800)


def audio_offset_ms(info):
    """브라우저 video.currentTime 0 기준으로 오디오 첫 샘플이 몇 ms 뒤에 있는지."""
    start = min(info['video_start'], info['audio_start']) if info['has_video'] else info['audio_start']
    return max(0.0, (info['audio_start'] - start) * 1000.0)


def extract_audio(path, sr=22050):
    """모노 float32 PCM. 영상 timeline 그대로 (앞부분을 자르거나 0초로 다시 맞추지 않는다)."""
    raw = _run([_tool('ffmpeg'), '-v', 'error', '-i', str(path), '-map', '0:a:0', '-ac', '1', '-ar', str(sr),
                '-f', 'f32le', '-'], timeout=900, binary=True)
    samples = np.frombuffer(raw, dtype=np.float32)
    if samples.size < sr:
        raise MediaError('오디오가 너무 짧거나 비어 있습니다.')
    return samples


def extract_frame(path, seconds, width=640):
    """해당 시각의 프레임 1장 (PIL.Image, RGB)."""
    from PIL import Image
    png = _run([_tool('ffmpeg'), '-v', 'error', '-ss', f'{max(0.0, seconds):.3f}', '-i', str(path), '-frames:v', '1',
                '-vf', f'scale={width}:-2', '-f', 'image2pipe', '-vcodec', 'png', '-'], timeout=60, binary=True)
    if not png:
        raise MediaError('프레임을 추출하지 못했습니다.')
    return Image.open(io.BytesIO(png)).convert('RGB')
