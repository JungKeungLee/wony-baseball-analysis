"""laneCount (4 / 6 / 8) 구조 테스트. 게임 UI 는 아직 4키만 쓰지만 생성/검증은 레인 수에 고정되지 않아야 한다."""
import json
import shutil
from collections import Counter

import numpy as np
import pytest

import audio_analyzer
import chart_generator as G
import import_song
import media
import song_store
import synth_media
from chart_config import CHORD_PAIRS, CHORD_TRIPLES, DEFAULT_LANE_COUNT, DIFFICULTIES, MIN_GAP_MS, SUPPORTED_LANE_COUNTS, chord_combos

needs_ffmpeg = pytest.mark.skipif(not shutil.which('ffmpeg'), reason='ffmpeg 필요')


@pytest.fixture(scope='module')
def analysis(tmp_path_factory):
    if not shutil.which('ffmpeg'):
        pytest.skip('ffmpeg 필요')
    d = tmp_path_factory.mktemp('lanes')
    synth_media.song_wav(d / 's.wav', bpm=140, seed=5)
    return audio_analyzer.analyze(media.extract_audio(d / 's.wav'))


def test_default_is_4():
    assert DEFAULT_LANE_COUNT == 4 and SUPPORTED_LANE_COUNTS == (4, 6, 8)


def test_4key_chord_combos_unchanged_and_others_in_range():
    assert chord_combos(4, 2) == CHORD_PAIRS and chord_combos(4, 3) == CHORD_TRIPLES
    for n in (6, 8):
        for size in (2, 3):
            combos = chord_combos(n, size)
            assert combos and len(set(combos)) == len(combos)
            for c in combos:
                assert len(c) == size and len(set(c)) == size and all(0 <= lane < n for lane in c)
        assert (0, n - 1) in chord_combos(n, 2), '양손 대칭 조합 포함'


def test_default_generation_equals_explicit_4(analysis):
    for d in DIFFICULTIES:
        a = G.generate_chart(analysis, 'x', d)
        b = G.generate_chart(analysis, 'x', d, lane_count=4)
        assert a == b and a['laneCount'] == 4


@pytest.mark.parametrize('lane_count', [4, 6, 8])
def test_generation_for_each_lane_count(analysis, lane_count):
    times_4 = {d: [n['time'] for n in G.generate_chart(analysis, 'x', d)['notes']] for d in DIFFICULTIES}
    for d in DIFFICULTIES:
        chart = G.generate_chart(analysis, 'x', d, lane_count=lane_count)
        assert chart['laneCount'] == lane_count
        assert G.validate_chart(chart, analysis.duration_ms, music_start_ms=analysis.music_start_ms) == []
        lanes = [n['lane'] for n in chart['notes']]
        assert min(lanes) >= 0 and max(lanes) < lane_count
        assert sorted({n['time'] for n in chart['notes']}) == sorted(set(times_4[d])), '노트 시각은 레인 수와 무관'
        per_time = Counter(n['time'] for n in chart['notes'])
        assert max(per_time.values()) < lane_count and max(per_time.values()) <= 3
        times = sorted(per_time)
        assert min(np.diff(times)) >= MIN_GAP_MS[d]
    hell = [n['lane'] for n in G.generate_chart(analysis, 'x', 'hell', lane_count=lane_count)['notes']]
    counts = np.bincount(hell, minlength=lane_count)
    assert (counts > 0).all(), f'모든 레인 사용: {counts}'
    assert counts.min() >= len(hell) / lane_count * 0.35, f'레인 쏠림: {counts}'


def test_unsupported_lane_count_rejected(analysis):
    with pytest.raises(G.ChartError, match='레인 수'):
        G.generate_chart(analysis, 'x', 'easy', lane_count=5)


def test_validation_uses_lane_count_not_fixed_0_to_3():
    base = {'difficulty': 'easy', 'notes': [{'time': 1000, 'lane': 5}]}
    assert any('0~3 범위' in e for e in G.validate_chart(base, 10000)), 'laneCount 없으면 4키'
    assert G.validate_chart({**base, 'laneCount': 6}, 10000) == []
    assert any('0~5 범위' in e for e in G.validate_chart({**base, 'laneCount': 6, 'notes': [{'time': 1000, 'lane': 6}]}, 10000))
    assert G.validate_chart({**base, 'laneCount': 8, 'notes': [{'time': 1000, 'lane': 7}]}, 10000) == []
    assert any('laneCount' in e for e in G.validate_chart({**base, 'laneCount': 5}, 10000))
    full6 = {'difficulty': 'hell', 'laneCount': 6, 'notes': [{'time': 1000, 'lane': i} for i in range(6)]}
    assert any('6레인 전체 동시' in e for e in G.validate_chart(full6, 10000))
    four_of_six = {**full6, 'notes': [{'time': 1000, 'lane': i} for i in range(4)]}
    assert not any('전체 동시' in e for e in G.validate_chart(four_of_six, 10000))


@needs_ffmpeg
def test_stage_with_6_lanes_is_valid_and_committable(tmp_path):
    synth_media.song_wav(tmp_path / 'w.wav', total=20, music_end=19)
    video = synth_media.make_mp4(tmp_path / 'v.mp4', tmp_path / 'w.wav', total=20)
    paths = song_store.Paths(tmp_path / 'site')
    stage, manifest = import_song.stage_song(video, '6키 테스트', paths=paths, staging=tmp_path / 'staging', lane_count=6)
    for d in DIFFICULTIES:
        chart = json.loads((stage / 'charts' / f'{d}.json').read_text(encoding='utf-8'))
        assert chart['laneCount'] == 6
    entry = song_store.commit_stage(stage, paths, tmp_path / 'staging')
    hell = json.loads(paths.chart(entry['id'], 'hell').read_text(encoding='utf-8'))
    assert hell['laneCount'] == 6 and max(n['lane'] for n in hell['notes']) <= 5


@needs_ffmpeg
def test_add_lane_modes_keeps_4key_and_registers_modes(tmp_path):
    """등록된 4키 곡에 6/8키 채보 추가: 4키 채보는 그대로, songs.json laneModes [4, 6, 8], 곡 삭제 시 함께 삭제"""
    import add_lane_modes
    synth_media.song_wav(tmp_path / 'w.wav', total=20, music_end=19)
    video = synth_media.make_mp4(tmp_path / 'v.mp4', tmp_path / 'w.wav', total=20)
    paths = song_store.Paths(tmp_path / 'site')
    stage, _ = import_song.stage_song(video, '키 모드 테스트', paths=paths, staging=tmp_path / 'staging')
    entry = song_store.commit_stage(stage, paths, tmp_path / 'staging')
    four = paths.chart(entry['id'], 'hard').read_bytes()
    add_lane_modes.add_lane_modes(entry['id'], [6, 8], paths=paths, progress=lambda *a: None)
    assert paths.chart(entry['id'], 'hard').read_bytes() == four, '4키 채보는 바꾸지 않음'
    for n in (6, 8):
        for d in DIFFICULTIES:
            chart = json.loads(paths.chart(entry['id'], d, n).read_text(encoding='utf-8'))
            assert chart['laneCount'] == n and max(x['lane'] for x in chart['notes']) < n
            assert paths.chart(entry['id'], d, n).name == f"{entry['id']}-{d}-{n}k.json"
    song = next(s for s in song_store.load_catalog(paths)['songs'] if s['id'] == entry['id'])
    assert song['laneModes'] == [4, 6, 8]
    with pytest.raises(song_store.StoreError):
        add_lane_modes.add_lane_modes(entry['id'], [5], paths=paths, progress=lambda *a: None)
    song_store.remove_song(entry['id'], paths)
    assert not any(paths.charts.glob(f"{entry['id']}-*.json")), '6/8키 채보도 함께 삭제'
