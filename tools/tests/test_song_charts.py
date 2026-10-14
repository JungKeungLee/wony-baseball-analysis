"""등록된 실제 곡 채보 검증 (영상 · 분석 없이 파일만 읽음).

KEY 모드(4/6/8) 채보마다: laneCount · lane 범위 · 같은 시각 같은 레인 중복 · 동시치기 크기 · 마지막 노트와 영상 길이,
6/8키는 기존 4키 채보의 리듬 포인트를 모두 포함하는지와 동시치기가 양손에 나뉘는지.
"""
import hashlib
import json
from collections import Counter, defaultdict

import pytest

import song_store
from chart_config import DIFFICULTIES

PATHS = song_store.Paths()
CATALOG = song_store.load_catalog(PATHS)['songs']
CASES = [(s['id'], d, n) for s in CATALOG for n in s.get('laneModes', [4]) for d in s['difficulties']]


def load(song_id, diff, n):
    return json.loads(PATHS.chart(song_id, diff, n).read_text(encoding='utf-8'))


def chords(chart):
    by_time = defaultdict(list)
    for note in chart['notes']:
        by_time[note['time']].append(note['lane'])
    return by_time


@pytest.mark.parametrize('song_id, diff, n', CASES)
def test_chart_is_valid_for_its_key_mode(song_id, diff, n):
    chart = load(song_id, diff, n)
    song = next(s for s in CATALOG if s['id'] == song_id)
    assert chart.get('laneCount', 4) == n
    lanes = [x['lane'] for x in chart['notes']]
    assert min(lanes) >= 0 and max(lanes) <= n - 1, f'lane 범위 0~{n - 1}'
    times = [x['time'] for x in chart['notes']]
    assert times == sorted(times)
    pairs = Counter((x['time'], x['lane']) for x in chart['notes'])
    assert all(v == 1 for v in pairs.values()), '같은 시각 · 같은 레인 중복'
    for t, group in chords(chart).items():
        assert len(group) <= 3 and len(group) < n, f'{t}ms 동시치기 {len(group)}키'
    assert times[-1] < song['durationMs'], '마지막 노트는 영상 안'


SIX_EIGHT = [(s['id'], d, n) for s in CATALOG for n in s.get('laneModes', [4]) if n != 4 for d in s['difficulties']
             if s['id'] == 'wony-cover-01']


@pytest.mark.parametrize('song_id, diff, n', SIX_EIGHT)
def test_6k_8k_keep_4k_rhythm_and_use_both_hands(song_id, diff, n):
    four, chart = load(song_id, diff, 4), load(song_id, diff, n)
    four_times = {x['time'] for x in four['notes']}
    times = {x['time'] for x in chart['notes']}
    assert four_times <= times, '4키 리듬 포인트를 모두 포함'
    assert (chart['bpm'], chart['musicStartMs']) == (four['bpm'], four['musicStartMs'])
    extra = sorted(times - four_times)
    assert all(t > max(four_times) for t in extra), '추가 노트는 곡 끝부분(4키 마지막 노트 이후)만'
    groups = [g for g in chords(chart).values() if len(g) > 1]
    if diff == 'easy':
        assert not groups, 'EASY 는 동시치기 없음'
    for g in groups:
        assert len({lane < n / 2 for lane in g}) == 2, f'동시치기는 양손에 나눔 {g}'
    lanes = {x['lane'] for x in chart['notes']}
    assert lanes == set(range(n)), f'모든 레인 사용 {sorted(lanes)}'


def test_6k_8k_difficulty_curve():
    for n in (6, 8):
        counts = [len(load('wony-cover-01', d, n)['notes']) for d in DIFFICULTIES]
        assert counts == sorted(counts) and counts[0] < counts[-1], counts
        chord_share = [sum(len(g) > 1 for g in chords(load('wony-cover-01', d, n)).values()) for d in DIFFICULTIES]
        assert chord_share[0] == 0 and chord_share[1] < chord_share[2] < chord_share[3], chord_share


# 곡 끝부분을 이어 붙이기 전(212.142초까지) 4키 채보: 노트 수 · 노트 목록 SHA-256 앞 16자리. 이 부분은 절대 바뀌면 안 됨
ORIGINAL_4K = {'easy': (340, 'c9017af180d151d0'), 'normal': (848, 'db63899e81e346b4'),
               'hard': (1375, 'ccfc6146f3527380'), 'hell': (1573, 'a111bc5ea0ab5a3d')}


@pytest.mark.parametrize('diff', DIFFICULTIES)
def test_4k_original_notes_unchanged_and_extended_to_song_end(diff):
    """4키 채보: 기존 노트(time · lane)는 그대로, 212초 이후 곡 끝부분(약 217초)까지만 이어 붙임"""
    chart = load('wony-cover-01', diff, 4)
    count, digest = ORIGINAL_4K[diff]
    original = chart['notes'][:count]
    assert hashlib.sha256(json.dumps(original, separators=(',', ':')).encode()).hexdigest()[:16] == digest
    added = chart['notes'][count:]
    assert added and all(n['time'] > original[-1]['time'] for n in added), '추가는 기존 마지막 노트 뒤에만'
    assert chart['notes'][-1]['time'] == 217275
    assert (chart['bpm'], chart['musicStartMs']) == (128.98, 7041)
    assert chart['endMs'] >= chart['notes'][-1]['time']
    groups = [g for g in chords({'notes': added}).values() if len(g) > 1]
    if diff == 'easy':
        assert not groups and len(added) <= 6, 'EASY 는 과밀하지 않게 (2박마다, 동시치기 없음)'
    song = next(s for s in CATALOG if s['id'] == 'wony-cover-01')
    assert song['noteCounts'][diff] == len(chart['notes']), 'songs.json noteCounts 도 맞춤'
