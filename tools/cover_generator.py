"""대표 cover 이미지 (WebP). 사용자가 이미지를 주면 그걸 변환하고, 없으면 영상에서 고른다.

자동 선택: 영상의 10% 지점부터 후보 프레임을 뽑아
  - 너무 어두운/밝은 프레임 (검은 화면, 페이드 인/아웃, 흰 화면) 제외
  - 대비(표준편차)가 낮은 밋밋한 프레임 제외
  - 선명도(Laplacian 분산) + 대비 + 채도 점수가 가장 높은 프레임
"""
import numpy as np
from PIL import Image

import media

COVER_WIDTH = 640
WEBP_QUALITY = 82


class CoverError(RuntimeError):
    pass


def frame_stats(img):
    rgb = np.asarray(img, dtype=np.float32)
    gray = rgb @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    lap = (-4 * gray[1:-1, 1:-1] + gray[:-2, 1:-1] + gray[2:, 1:-1] + gray[1:-1, :-2] + gray[1:-1, 2:])
    rg = rgb[..., 0] - rgb[..., 1]
    yb = 0.5 * (rgb[..., 0] + rgb[..., 1]) - rgb[..., 2]
    return {
        'brightness': float(gray.mean()),
        'contrast': float(gray.std()),
        'sharpness': float(lap.var()),
        'colorfulness': float(np.hypot(rg.std(), yb.std()) + 0.3 * np.hypot(rg.mean(), yb.mean())),
    }


def usable(stats):
    return 45 <= stats['brightness'] <= 225 and stats['contrast'] >= 22


def score(stats, position):
    s = (np.log1p(stats['sharpness']) / 8 + stats['contrast'] / 80 + stats['colorfulness'] / 120)
    return float(s - 0.3 * abs(position - 0.3))  # 너무 뒤쪽보다는 앞~중간 장면을 약간 선호


def candidate_positions():
    return [0.10, 0.13, 0.16, 0.20, 0.24, 0.28, 0.33, 0.38, 0.44, 0.50, 0.58, 0.66]


def pick_frame(video_path, duration_s):
    best, fallback = None, None
    for pos in candidate_positions():
        try:
            img = media.extract_frame(video_path, duration_s * pos, COVER_WIDTH)
        except media.MediaError:
            continue
        st = frame_stats(img)
        sc = score(st, pos)
        if usable(st) and (best is None or sc > best[0]):
            best = (sc, img, pos, st)
        darkness_penalty = abs(st['brightness'] - 128) / 64
        if fallback is None or sc - darkness_penalty > fallback[0]:
            fallback = (sc - darkness_penalty, img, pos, st)
    chosen = best or fallback
    if chosen is None:
        raise CoverError('영상에서 대표 이미지를 추출하지 못했습니다.')
    return chosen[1], {'position': chosen[2], 'auto': True, 'fallback': best is None, **{k: round(v, 1) for k, v in chosen[3].items()}}


def save_webp(img, dst):
    img = img.convert('RGB')
    if img.width > COVER_WIDTH:
        img = img.resize((COVER_WIDTH, round(img.height * COVER_WIDTH / img.width)), Image.LANCZOS)
    img.save(dst, 'WEBP', quality=WEBP_QUALITY, method=4)


def make_cover(video_path, duration_s, dst, custom_image=None):
    if custom_image:
        try:
            with Image.open(custom_image) as img:
                save_webp(img, dst)
        except Exception as exc:  # noqa: BLE001 - 어떤 이미지 오류든 같은 메시지
            raise CoverError(f'지정한 cover 이미지를 읽지 못했습니다: {exc}') from exc
        return {'auto': False}
    img, info = pick_frame(video_path, duration_s)
    save_webp(img, dst)
    return info
