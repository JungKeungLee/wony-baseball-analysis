"""Browser display-size selections (non-square SAR) map onto source pixels; errors stay specific."""
import json
import subprocess
from fractions import Fraction
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.validation.display import SelectionInputError, display_sizes, to_source
from app.validation.target import TargetSelection

SAR = Fraction(388619, 388800)  # actual WONY portrait clips: Chrome reports 720x1281 for 720x1280


def meta(width=720, height=1280, sar=SAR, duration=10.035):
    return {'width': width, 'height': height, 'sample_aspect_ratio': sar, 'duration': duration}


def selection(width=720, height=1281, bbox=(394, 492, 249, 402), **extra):
    return TargetSelection(confirmed_by_user=True, viewpoint='third_person', source_width=width,
                           source_height=height, bbox=bbox, **extra)


def test_chrome_display_size_for_real_sar():
    assert (720, 1281) in display_sizes(meta()) and display_sizes(meta(sar=Fraction(1))) == {(720, 1280)}


def test_display_selection_is_rescaled_to_source_pixels():
    source, record = to_source(selection(), meta())
    assert (source.source_width, source.source_height) == (720, 1280)
    x, y, w, h = source.bbox
    assert (x, w) == (394, 249) and y == pytest.approx(492 * 1280 / 1281) and h == pytest.approx(402 * 1280 / 1281)
    assert y + h <= 1280 and record['display_bbox'] == [394, 492, 249, 402] and record['display_size'] == [720, 1281]


def test_source_pixel_selection_is_unchanged():
    original = selection(height=1280)
    source, record = to_source(original, meta())
    assert source is original and record is None


@pytest.mark.parametrize('kwargs,code', [
    ({'width': 700}, 'selection_size_mismatch'),
    ({'height': 1290}, 'selection_size_mismatch'),
    ({'source_time': 10.5}, 'selection_time_out_of_range'),
])
def test_specific_selection_errors(kwargs, code):
    sel = selection(**{k: v for k, v in kwargs.items() if k in ('width', 'height')},
                    **{k: v for k, v in kwargs.items() if k == 'source_time'})
    with pytest.raises(SelectionInputError) as error:
        to_source(sel, meta())
    assert error.value.code == code


def test_duration_limit_is_kept():
    with pytest.raises(SelectionInputError) as error:
        to_source(selection(height=1280), meta(duration=121))
    assert error.value.code == 'video_too_long'


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv('WONY_DATA_DIR', str(tmp_path / 'results'))
    return TestClient(app)


@pytest.fixture
def portrait_clip(tmp_path):
    # Like the real clips, the non-square SAR lives in the MP4 container (x264 drops a near-1 VUI SAR).
    # Result: 720x1280 stored pixels, SAR 2096:2097 -> Chrome reports 720x1281.
    raw, path = tmp_path / 'raw.mp4', tmp_path / 'portrait-sar.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=720x1280:r=10', '-t', '1',
                    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(raw)], check=True)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(raw), '-c', 'copy', '-aspect', '388619:691200', str(path)], check=True)
    return path


def post(client, clip, sel):
    with clip.open('rb') as source:
        return client.post('/api/validation', data={'selection': sel.model_dump_json()}, files={'video': ('wony-10s.mp4', source, 'video/mp4')})


def test_api_accepts_browser_display_selection(client, portrait_clip, monkeypatch):
    monkeypatch.setattr('app.validation.runner.extract_pose', lambda frames: [])
    r = post(client, portrait_clip, selection())
    assert r.status_code == 200, r.text
    identifier = r.json()['id']
    stored = client.get(f'/api/validation/{identifier}/analysis').json()['target_tracking']['selection']
    assert (stored['source_width'], stored['source_height']) == (720, 1280) and stored['bbox'][1] == pytest.approx(492 * 1280 / 1281)
    from app.api.validation import root
    record = json.loads((root() / identifier / 'selection_input.json').read_text(encoding='utf-8'))
    assert record['display_size'] == [720, 1281] and record['source_size'] == [720, 1280]


def test_api_reports_each_cause_separately(client, portrait_clip):
    r = post(client, portrait_clip, selection(height=1290))
    assert r.status_code == 422 and r.json()['detail'].startswith('[selection_size_mismatch]') and '720x1290' in r.json()['detail']
    r = client.post('/api/validation', data={'selection': selection(height=1280).model_dump_json()}, files={'video': ('x.mp4', b'not-media')})
    assert r.status_code == 422 and r.json()['detail'].startswith('[video_metadata_unreadable]')
    r = client.post('/api/validation', data={'selection': '{"bbox":[1,2,3]'}, files={'video': ('x.mp4', b'x')})
    assert r.json()['detail'].startswith('[selection_invalid_json]')
    bad = json.loads(selection(height=1280).model_dump_json()); bad['bbox'] = [700, 10, 100, 100]
    r = client.post('/api/validation', data={'selection': json.dumps(bad)}, files={'video': ('x.mp4', b'x')})
    assert r.json()['detail'].startswith('[selection_out_of_frame]')
    from app.api.validation import root
    assert not list(root().glob('*.upload'))
