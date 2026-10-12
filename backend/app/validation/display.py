"""Map a browser-drawn selection onto source pixels.

Browsers report ``videoWidth/videoHeight`` after applying the stream's sample
aspect ratio (SAR). For a 720x1280 stream with SAR 388619:388800 Chrome reports
720x1281, so a selection drawn in the browser is in *display* pixels, while the
validation runner works in *source* (stored) pixels. The selection is rescaled
only when its size exactly equals a display size derived from the probed SAR;
any other mismatch is rejected. Bounds are re-validated after rescaling.
"""
import json
import math
import subprocess
from fractions import Fraction
from app.validation.target import TargetSelection


class SelectionInputError(ValueError):
    def __init__(self, code, message):
        super().__init__(f'[{code}] {message}')
        self.code = code


def probe(path):
    """Stream size, SAR and duration only; the runner still reads frame PTS itself."""
    try:
        result = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height,sample_aspect_ratio:format=duration', '-of', 'json', str(path)],
            capture_output=True, check=True, timeout=30)
        data = json.loads(result.stdout)
        stream = data['streams'][0]
        width, height, duration = int(stream['width']), int(stream['height']), float(data['format']['duration'])
    except (subprocess.SubprocessError, OSError, ValueError, KeyError, IndexError, TypeError) as exc:
        raise SelectionInputError('video_metadata_unreadable', 'Could not read video size/duration with ffprobe') from exc
    if width <= 0 or height <= 0 or not math.isfinite(duration):
        raise SelectionInputError('video_metadata_unreadable', f'Invalid video metadata {width}x{height}, duration={duration}')
    sar = stream.get('sample_aspect_ratio') or '1:1'
    try:
        num, den = (int(v) for v in sar.split(':'))
        ratio = Fraction(num, den) if num > 0 and den > 0 else Fraction(1)
    except ValueError:
        ratio = Fraction(1)
    return {'width': width, 'height': height, 'duration': duration, 'sample_aspect_ratio': ratio}


def display_sizes(meta):
    """Possible browser natural sizes: widen the width, or (Chrome when SAR<1) stretch the height."""
    w, h, sar = meta['width'], meta['height'], meta['sample_aspect_ratio']
    if sar == 1:
        return {(w, h)}
    return {(round(w * sar), h), (w, round(h / sar))}


def to_source(selection: TargetSelection, meta):
    """Return (selection in source pixels, conversion record or None)."""
    duration = meta['duration']
    if not 0 < duration <= 120:
        raise SelectionInputError('video_too_long' if duration > 120 else 'video_metadata_unreadable',
                                  f'Video duration {duration:.3f}s; validation accepts 0-120 seconds')
    if selection.source_time >= duration:
        raise SelectionInputError('selection_time_out_of_range', f'Selection time {selection.source_time:.3f}s is beyond video duration {duration:.3f}s')
    source = (meta['width'], meta['height'])
    given = (selection.source_width, selection.source_height)
    if given == source:
        return selection, None
    if given not in display_sizes(meta):
        raise SelectionInputError('selection_size_mismatch',
            f'Selection was drawn on {given[0]}x{given[1]} but the video is {source[0]}x{source[1]} (SAR {meta["sample_aspect_ratio"]})')
    sx, sy = source[0] / given[0], source[1] / given[1]
    x, y, bw, bh = selection.bbox
    data = selection.model_dump()
    data.update(source_width=source[0], source_height=source[1], bbox=(x * sx, y * sy, bw * sx, bh * sy))
    try:
        converted = TargetSelection.model_validate(data)
    except ValueError as exc:
        raise SelectionInputError('selection_out_of_frame', f'Selection outside the video after display→source mapping: {exc}') from exc
    return converted, {'display_size': list(given), 'source_size': list(source),
                       'sample_aspect_ratio': str(meta['sample_aspect_ratio']).replace('/', ':'),
                       'display_bbox': list(selection.bbox), 'source_bbox': list(converted.bbox)}
