"""MP4 1개 → cover / 4개 채보 / songs.json 자동 생성 테스트 (합성 MP4 사용, ffmpeg 필요)."""
import hashlib
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

import chart_generator
import import_song
import media
import song_store
import synth_media
from chart_config import DIFFICULTIES, MIN_GAP_MS

pytestmark = pytest.mark.skipif(not shutil.which('ffmpeg') or not shutil.which('ffprobe'), reason='ffmpeg 필요')

INTRO_MS = 7500  # 0~3초 무음, 3~7.5초 박자 없는 '멘트', 7.5초부터 120BPM 음악


@pytest.fixture(scope='module')
def media_dir(tmp_path_factory):
    d = tmp_path_factory.mktemp('media')
    beats = synth_media.song_wav(d / 'song.wav', talk_until=INTRO_MS / 1000)
    synth_media.make_mp4(d / 'my-song.mp4', d / 'song.wav')
    return {'dir': d, 'video': d / 'my-song.mp4', 'beats': np.array(beats)}


@pytest.fixture
def site(tmp_path):
    paths = song_store.Paths(tmp_path / 'site')
    (paths.site / 'songs').mkdir(parents=True)
    song_store.write_json_atomic(paths.songs_json, {'version': 1, 'songs': []})
    return paths, tmp_path / 'staging'


@pytest.fixture(scope='module')
def imported(media_dir, tmp_path_factory):
    root = tmp_path_factory.mktemp('imported')
    paths = song_store.Paths(root / 'site')
    entry, manifest = import_song.import_song(media_dir['video'], '여름이야 부탁해', paths=paths, staging=root / 'staging')
    charts = {d: json.loads(paths.chart(entry['id'], d).read_text(encoding='utf-8')) for d in DIFFICULTIES}
    return {'paths': paths, 'entry': entry, 'manifest': manifest, 'charts': charts, 'staging': root / 'staging'}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def test_songs_json_registration(imported):
    paths, entry = imported['paths'], imported['entry']
    catalog = json.loads(paths.songs_json.read_text(encoding='utf-8'))
    assert catalog['songs'] == [entry]
    assert entry['id'] == 'wony-cover-01'
    assert entry['title'] == '여름이야 부탁해' and entry['artist'] == 'WONY'
    assert entry['video'] == '/assets/videos/wony-cover-01.mp4'
    assert entry['cover'] == '/assets/covers/wony-cover-01.webp'
    assert entry['difficulties'] == ['easy', 'normal', 'hard', 'hell']
    assert not list(imported['staging'].glob('*/stage.json')), 'staging 은 등록 후 정리'


def test_video_and_cover_files(imported, media_dir):
    paths, sid = imported['paths'], imported['entry']['id']
    info = media.probe(paths.video(sid))
    assert info['vcodec'] == 'h264' and info['acodec'] == 'aac'
    assert abs(info['duration'] - media.probe(media_dir['video'])['duration']) < 0.1, 'timeline/길이 유지'
    with Image.open(paths.cover(sid)) as img:
        assert img.format == 'WEBP'
        stats = __import__('cover_generator').frame_stats(img.convert('RGB'))
    assert stats['brightness'] > 45, '검은 화면/페이드 인 프레임이 아님'
    assert imported['manifest']['cover']['position'] >= 0.1


def test_all_charts_valid(imported):
    m = imported['manifest']
    for d, chart in imported['charts'].items():
        assert chart['songId'] == 'wony-cover-01' and chart['difficulty'] == d and chart['generated'] is True
        assert chart_generator.validate_chart(chart, m['durationMs'], music_start_ms=m['analysis']['musicStartMs']) == []
        notes = chart['notes']
        assert all(set(n) == {'time', 'lane'} for n in notes), '에디터용 단순 구조'
        assert all(0 <= n['lane'] <= 3 for n in notes)
        assert len({(n['time'], n['lane']) for n in notes}) == len(notes)
        assert notes == sorted(notes, key=lambda n: (n['time'], n['lane']))
        times = sorted({n['time'] for n in notes})
        assert min(np.diff(times)) >= MIN_GAP_MS[d]
        assert all(0 <= t <= m['durationMs'] for t in times)


def test_difficulty_progression(imported):
    counts = [len(imported['charts'][d]['notes']) for d in DIFFICULTIES]
    assert counts == sorted(counts) and counts[-1] > counts[0], counts
    chords = {d: len(c['notes']) - len({n['time'] for n in c['notes']}) for d, c in imported['charts'].items()}
    assert chords['easy'] == 0
    assert chords['hell'] >= chords['hard'] >= chords['normal']
    for c in imported['charts'].values():
        per_time = {}
        for n in c['notes']:
            per_time[n['time']] = per_time.get(n['time'], 0) + 1
        assert max(per_time.values()) <= 3, '4키 동시 없음'


def test_timeline_preserved_and_intro_skipped(imported, media_dir):
    a = imported['manifest']['analysis']
    assert abs(a['musicStartMs'] - INTRO_MS) <= 20, a
    assert abs(a['bpm'] - 120) < 1
    for d, chart in imported['charts'].items():
        assert chart['notes'][0]['time'] >= INTRO_MS - 20, f'{d}: 멘트/무음 구간에 노트'
        assert chart['endMs'] <= imported['manifest']['durationMs']


def test_notes_follow_the_music(imported, media_dir):
    beats = media_dir['beats']
    grid = np.concatenate([beats, beats + 250])  # 8분음표 격자
    for d, chart in imported['charts'].items():
        times = np.array(sorted({n['time'] for n in chart['notes']}))
        dev = np.abs(times[:, None] - grid[None, :]).min(axis=1)
        assert np.mean(dev <= 20) >= 0.95, f'{d}: 음악과 어긋난 노트가 많음 {np.percentile(dev, 90)}'
    easy = np.array(sorted({n['time'] for n in imported['charts']['easy']['notes']}))
    assert np.mean(np.abs(easy[:, None] - beats[None, :]).min(axis=1) <= 20) >= 0.95, 'EASY 는 박 위주'


def test_lanes_are_not_trivial(imported):
    for d, chart in imported['charts'].items():
        lanes = [n['lane'] for n in chart['notes']]
        counts = np.bincount(lanes, minlength=4)
        assert counts.min() >= len(lanes) * 0.12, f'{d}: 레인 쏠림 {counts}'
        per_time = {}
        for n in chart['notes']:
            per_time.setdefault(n['time'], []).append(n['lane'])
        flow = [ls[0] for ls in per_time.values() if len(ls) == 1]  # 동시치기를 뺀 단일 노트 흐름
        stairs = sum(1 for i in range(len(flow) - 3) if flow[i:i + 4] in ([0, 1, 2, 3], [3, 2, 1, 0]))
        assert stairs <= max(1, len(lanes) // 25), f'{d}: 0123 계단 반복'
        singles = [(n['time'], n['lane']) for n in chart['notes']]
        same_lane_fast = sum(1 for (t1, l1), (t2, l2) in zip(singles, singles[1:]) if l1 == l2 and 0 < t2 - t1 < 140)
        assert same_lane_fast == 0, f'{d}: 빠른 같은 레인 연타'


def test_generation_is_deterministic(media_dir, site):
    paths, staging = site
    s1, m1 = import_song.stage_song(media_dir['video'], 'A', paths=paths, staging=staging)
    s2, m2 = import_song.stage_song(media_dir['video'], 'A', paths=paths, staging=staging)
    assert m1['songId'] == 'wony-cover-01' and m2['songId'] == 'wony-cover-02', 'staging 중인 ID 도 예약'
    for d in DIFFICULTIES:
        n1 = json.loads((s1 / 'charts' / f'{d}.json').read_text(encoding='utf-8'))['notes']
        n2 = json.loads((s2 / 'charts' / f'{d}.json').read_text(encoding='utf-8'))['notes']
        assert [n['time'] for n in n1] == [n['time'] for n in n2]


def test_ids_and_original_untouched(media_dir, site):
    paths, staging = site
    before = sha(media_dir['video'])
    e1, _ = import_song.import_song(media_dir['video'], '한글 제목 / 특수:문자?', paths=paths, staging=staging)
    e2, _ = import_song.import_song(media_dir['video'], '두 번째', paths=paths, staging=staging)
    assert (e1['id'], e2['id']) == ('wony-cover-01', 'wony-cover-02')
    assert e1['title'] == '한글 제목 / 특수:문자?'
    assert sha(media_dir['video']) == before, '원본 MP4 는 수정하지 않음'
    with pytest.raises(import_song.ImportFailed, match='이미 있는 곡 ID'):
        import_song.stage_song(media_dir['video'], 'x', song_id='wony-cover-01', paths=paths, staging=staging)
    with pytest.raises(import_song.ImportFailed, match='영문 소문자'):
        import_song.stage_song(media_dir['video'], 'x', song_id='../evil', paths=paths, staging=staging)


def test_custom_cover(media_dir, site, tmp_path):
    paths, staging = site
    Image.new('RGB', (1200, 1200), (250, 200, 30)).save(tmp_path / 'c.png')
    entry, manifest = import_song.import_song(media_dir['video'], 'cover', cover=tmp_path / 'c.png', paths=paths, staging=staging)
    assert manifest['cover'] == {'auto': False}
    with Image.open(paths.cover(entry['id'])) as img:
        assert img.format == 'WEBP' and img.width == 640


def _assert_nothing_left(paths, staging):
    assert json.loads(paths.songs_json.read_text(encoding='utf-8'))['songs'] == []
    for folder in (paths.videos, paths.covers, paths.charts):
        assert not folder.exists() or not any(folder.iterdir()), f'{folder} 에 파일이 남음'
    assert not staging.exists() or not [p for p in staging.iterdir() if p.name != '_uploads']


def test_broken_file_fails_cleanly(site, tmp_path):
    paths, staging = site
    bad = tmp_path / 'broken.mp4'
    bad.write_bytes(b'not a video' * 1000)
    with pytest.raises(import_song.ImportFailed, match='영상 정보를 읽지 못했습니다'):
        import_song.import_song(bad, '깨진 파일', paths=paths, staging=staging)
    _assert_nothing_left(paths, staging)


def test_video_without_audio_fails(site, tmp_path):
    paths, staging = site
    path = tmp_path / 'silent-video.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=12',
                    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', str(path)], check=True)
    with pytest.raises(import_song.ImportFailed, match='오디오 트랙이 없는'):
        import_song.import_song(path, 'x', paths=paths, staging=staging)
    _assert_nothing_left(paths, staging)


def test_no_music_fails_with_clear_message(site, tmp_path):
    paths, staging = site
    path = tmp_path / 'talk-only.mp4'
    synth_media.song_wav(tmp_path / 't.wav', intro_silence=1, talk_until=19.5, music_end=19.5, total=20)
    synth_media.make_mp4(path, tmp_path / 't.wav', total=20)
    with pytest.raises(import_song.ImportFailed, match='음악 분석에 실패했습니다'):
        import_song.import_song(path, '멘트만', paths=paths, staging=staging)
    _assert_nothing_left(paths, staging)


def test_commit_failure_rolls_back(media_dir, site, monkeypatch):
    paths, staging = site
    stage, _ = import_song.stage_song(media_dir['video'], 'rollback', paths=paths, staging=staging)
    real = song_store.write_json_atomic

    def boom(path, data):
        if Path(path) == paths.songs_json:
            raise OSError('disk full')
        return real(path, data)

    monkeypatch.setattr(song_store, 'write_json_atomic', boom)
    with pytest.raises(song_store.StoreError, match='곡 등록에 실패'):
        song_store.commit_stage(stage, paths, staging)
    assert json.loads(paths.songs_json.read_text(encoding='utf-8'))['songs'] == []
    for folder in (paths.videos, paths.covers, paths.charts):
        assert not folder.exists() or not any(folder.iterdir())
    assert (stage / 'stage.json').exists(), '실패하면 미리보기는 남겨 둔다 (다시 저장 가능)'


def test_transcodes_non_h264(site, tmp_path):
    paths, staging = site
    synth_media.song_wav(tmp_path / 'w.wav', total=20, music_end=19)
    path = synth_media.make_mp4(tmp_path / 'mpeg4.mp4', tmp_path / 'w.wav', total=20, vcodec='mpeg4')
    assert media.probe(path)['vcodec'] == 'mpeg4'
    entry, manifest = import_song.import_song(path, '변환', paths=paths, staging=staging)
    assert manifest['video']['transcoded'] is True
    assert media.probe(paths.video(entry['id']))['vcodec'] == 'h264'


def test_remove_song(media_dir, site):
    paths, staging = site
    entry, _ = import_song.import_song(media_dir['video'], '지울 곡', paths=paths, staging=staging)
    song_store.remove_song(entry['id'], paths)
    _assert_nothing_left(paths, staging)


def test_cli(media_dir, tmp_path, monkeypatch):
    paths = song_store.Paths(tmp_path / 'site')
    monkeypatch.setattr(song_store, 'Paths', lambda site=None: paths)
    monkeypatch.setattr(song_store, 'STAGING', tmp_path / 'staging')
    assert import_song.main(['--video', str(media_dir['video']), '--title', 'CLI 곡']) == 0
    assert json.loads(paths.songs_json.read_text(encoding='utf-8'))['songs'][0]['title'] == 'CLI 곡'
    assert import_song.main(['--video', str(tmp_path / 'nope.mp4'), '--title', 'x']) == 1


def test_admin_server_flow(media_dir, site):
    from fastapi.testclient import TestClient
    import admin_server
    paths, staging = site
    for name in ('css', 'js'):
        (paths.site / name).mkdir(parents=True, exist_ok=True)
    (paths.site / 'game.html').write_text('<html data-page="game"></html>', encoding='utf-8')
    client = TestClient(admin_server.create_app(paths, staging))
    with open(media_dir['video'], 'rb') as fh:
        res = client.post('/api/import', data={'title': '관리자 화면 곡'}, files={'video': ('my-song.mp4', fh, 'video/mp4')})
    assert res.status_code == 200, res.text
    job = res.json()['job']
    for _ in range(300):
        status = client.get(f'/api/import/{job}').json()
        if status['status'] != 'working':
            break
        time.sleep(0.2)
    assert status['status'] == 'ready', status
    stage = status['stage']
    preview = client.get(f'/staging/{stage}/song.json').json()
    assert preview['preview'] is True and preview['charts']['hell'].endswith('/charts/hell.json')
    assert client.get(f'/staging/{stage}/video.mp4', headers={'Range': 'bytes=0-99'}).status_code == 206
    assert client.get(f'/staging/{stage}/../stage.json').status_code == 404
    assert client.get('/staging/..%2F..%2Fsecret/x').status_code == 404
    assert [s['stageId'] for s in client.get('/api/stages').json()] == [stage]
    assert json.loads(paths.songs_json.read_text(encoding='utf-8'))['songs'] == [], '미리보기 단계에서는 등록 안 됨'
    entry = client.post(f'/api/stages/{stage}/commit').json()
    assert entry['id'] == 'wony-cover-01'
    assert client.get('/api/songs').json()['songs'][0]['title'] == '관리자 화면 곡'
    assert client.get('/api/stages').json() == []
    assert not (staging / '_uploads').exists() or not any((staging / '_uploads').iterdir()), '업로드 사본 정리'


def test_game_server_does_not_import_analysis_code():
    root = Path(__file__).resolve().parents[2]
    code = ('import sys; import app.main; '
            "print([m for m in ('numpy', 'PIL', 'audio_analyzer', 'chart_generator', 'import_song', 'cv2', 'mediapipe') if m in sys.modules])")
    out = subprocess.run([sys.executable, '-c', code], cwd=root / 'backend', capture_output=True, text=True, check=True)
    assert out.stdout.strip() == '[]'
