"""분석 결과 → 난이도별 채보 초안 + 검증 (로컬 도구 전용).

생성 순서
  1. 후보 선택: 박자 위치 등급/onset 세기/구간 에너지로 우선순위를 매기고, 중요한 것부터
     최소 간격(MIN_GAP_MS)과 초당 노트 수(max_nps) 안에서 채택한다. onset 이 있다고 전부 넣지 않는다.
  2. 동시치기: 강박 + 강한 onset + 신나는 구간에서만, 앞뒤 간격이 충분할 때만 2키(HELL 은 드물게 3키).
  3. 레인 배치: 소리 높낮이(spectral centroid)를 레인 방향의 힌트로 쓰고, 연타/점프/단순 반복을 규칙으로 제한.
결과 JSON 은 에디터에서 고치기 쉽도록 {time, lane} 목록만 둔다.
"""
import bisect
import random

from chart_config import (CHART_VERSION, DEFAULT_LANE_COUNT, DIFFICULTIES, LEVEL_WEIGHT, MIN_GAP_MS, RULES,
                          SUPPORTED_LANE_COUNTS, chord_combos)


class ChartError(RuntimeError):
    pass


def _eligible(c, rules, bpm):
    need = rules['min_strength'].get(c.level)
    if need is None:
        return False
    if c.level >= 3 and not c.has_onset:  # 박 사이 위치는 실제 소리가 있을 때만
        return False
    if c.level == 2 and (c.intensity < rules['level2_min_intensity'] or bpm > rules['max_bpm_for_level2']):
        return False
    return c.strength >= need


def _priority(c):
    return LEVEL_WEIGHT[c.level] * (0.35 + 0.65 * c.strength) * (0.6 + 0.4 * c.intensity)


def select_times(analysis, difficulty):
    rules = RULES[difficulty]
    gap = MIN_GAP_MS[difficulty]
    pool = sorted((c for c in analysis.candidates if _eligible(c, rules, analysis.bpm)),
                  key=lambda c: (-_priority(c), c.time))
    chosen_t, chosen = [], []
    max_per_sec = rules['max_nps']
    for c in pool:
        i = bisect.bisect_left(chosen_t, c.time)
        if i < len(chosen_t) and chosen_t[i] - c.time < gap:
            continue
        if i > 0 and c.time - chosen_t[i - 1] < gap:
            continue
        # 1초 창 밀도 제한 (이 노트를 포함하는 어떤 1초 창도 max_nps 를 넘지 않게)
        lo = bisect.bisect_left(chosen_t, c.time - 999)
        hi = bisect.bisect_right(chosen_t, c.time + 999)
        window = chosen_t[lo:hi]
        if any(sum(1 for t in window if s <= t <= s + 999) + 1 > max_per_sec
               for s in [t for t in window if t <= c.time] + [c.time]):
            continue
        chosen_t.insert(i, c.time)
        chosen.insert(i, c)
    return chosen


def _chord_flags(notes, difficulty, rng):
    """notes: 시간순 Candidate. 동시치기할 노트 index → 레인 수(2 또는 3)."""
    rules = RULES[difficulty]
    if rules['chord_rate'] <= 0 or len(notes) < 3:
        return {}
    scored = []
    for i, c in enumerate(notes):
        prev_gap = c.time - notes[i - 1].time if i else 10 ** 9
        next_gap = notes[i + 1].time - c.time if i + 1 < len(notes) else 10 ** 9
        if min(prev_gap, next_gap) < rules['chord_gap_ms']:
            continue
        accent = c.strength * (1.0 if c.level <= 1 else 0.75 if c.level == 2 else 0.55)
        accent *= 0.5 + 0.5 * c.intensity
        accent *= 0.7 + 0.3 * max(c.low, c.high)
        if accent >= 0.25:
            scored.append((accent + rng.random() * 0.01, i))
    scored.sort(reverse=True)
    count = int(round(len(notes) * rules['chord_rate']))
    flags = {i: 2 for _, i in scored[:count]}
    triples = int(round(len(notes) * rules['triple_rate']))
    strong = [i for _, i in scored if notes[i].level == 0 and notes[i].intensity >= 0.75]
    for i in strong[:triples]:
        flags[i] = 3
    return flags


def _pick_lane(c, gap, state, rules, rng, lane_count):
    target = min(lane_count - 1, int(c.pitch * lane_count))
    half = lane_count / 2
    prev, prev_set = state['prev'], state['prev_set']
    best, best_score = 0, -1e18
    for lane in range(lane_count):
        score = -0.5 * abs(lane - target)
        score -= 0.45 * state['recent'].count(lane)  # 최근 8개 노트에서 많이 쓴 레인은 피해서 고르게
        if lane in prev_set and gap < rules['jack_gap_ms']:
            score -= 1000  # 빠른 같은 레인 연타 금지
        if prev is not None:
            step = abs(lane - prev)
            if lane == prev:
                score -= 1.6 + 1.5 * state['repeat']  # 같은 레인 반복은 최소화
            if step > rules['max_step']:
                score -= 3
            if rules['cross_gap_ms'] and gap < rules['cross_gap_ms']:
                score += 1.2 if (lane < half) != (prev < half) else -0.6  # 빠른 구간은 좌우 손 교대
            elif step > 2 and gap < 250:
                score -= 1.0  # 느린 난이도에서 빠른 큰 점프 억제
            moves = state['moves']
            if step == 1 and moves and moves[-1] == lane - prev:
                score -= 0.8  # 같은 방향 한 칸 이동이 이어지면 감점
                if len(moves) >= 2 and moves[-2] == moves[-1]:
                    score -= 4.0  # 0→1→2→3 같은 계단은 거의 만들지 않음
        score += rng.random() * 0.6  # 동점 깨기용 (곡/난이도마다 고정된 seed)
        if score > best_score:
            best, best_score = lane, score
    return best


def _pick_chord(size, gap, state, rules, c, rng, lane_count):
    options = chord_combos(lane_count, size)
    best, best_score = options[0], -1e18
    for combo in options:
        score = 0.0
        if gap < rules['jack_gap_ms'] and set(combo) & state['prev_set']:
            score -= 1000
        if size == 2:
            if c.level == 0 and combo[0] + combo[1] == lane_count - 1:
                score += 1.0  # 강박은 대칭형 (4키: (0,3), (1,2))
            center = sum(combo) / 2 / (lane_count - 1)
            score -= abs(center - c.pitch)
        if combo == state.get('last_chord'):
            score -= 0.8
        score += rng.random() * 0.5
        if score > best_score:
            best, best_score = combo, score
    return best


def assign_lanes(notes, difficulty, seed, lane_count=DEFAULT_LANE_COUNT):
    """레인 번호는 0 <= lane < lane_count."""
    rules = RULES[difficulty]
    rng = random.Random(seed)
    flags = _chord_flags(notes, difficulty, rng)
    out = []
    state = {'prev': None, 'prev_set': set(), 'repeat': 0, 'moves': [], 'last_chord': None, 'recent': []}
    prev_time = None
    for i, c in enumerate(notes):
        gap = c.time - prev_time if prev_time is not None else 10 ** 9
        size = flags.get(i, 1)
        if size > 1:
            combo = _pick_chord(size, gap, state, rules, c, rng, lane_count)
            out += [{'time': c.time, 'lane': lane} for lane in combo]
            state.update(prev=None, prev_set=set(combo), repeat=0, last_chord=combo)
            state['recent'] = (state['recent'] + list(combo))[-8:]
            state['moves'] = []
        else:
            lane = _pick_lane(c, gap, state, rules, rng, lane_count)
            if state['prev'] is not None:
                state['moves'] = (state['moves'] + [lane - state['prev']])[-3:]
            state['repeat'] = state['repeat'] + 1 if lane == state['prev'] else 0
            state.update(prev=lane, prev_set={lane})
            state['recent'] = (state['recent'] + [lane])[-8:]
            out.append({'time': c.time, 'lane': lane})
        prev_time = c.time
    return out


def generate_chart(analysis, song_id, difficulty, *, seed_base='', lane_count=DEFAULT_LANE_COUNT):
    """lane_count: 4 (기본) / 6 / 8. 노트 시각 선택은 레인 수와 무관하고 레인 배치만 달라진다."""
    if difficulty not in DIFFICULTIES:
        raise ChartError(f'알 수 없는 난이도: {difficulty}')
    if lane_count not in SUPPORTED_LANE_COUNTS:
        raise ChartError(f'지원하지 않는 레인 수: {lane_count}')
    notes = select_times(analysis, difficulty)
    if not notes:
        raise ChartError(f'{difficulty.upper()} 채보에 넣을 노트가 없습니다.')
    lanes = assign_lanes(notes, difficulty, f'{seed_base or song_id}:{difficulty}', lane_count)
    lanes.sort(key=lambda n: (n['time'], n['lane']))
    # 결과 화면으로 넘어가는 시각: 음악 끝 + 2초 (영상 길이를 넘지 않음)
    end_ms = min(analysis.duration_ms, max(analysis.music_end_ms + 2000, lanes[-1]['time'] + 1000))
    return {
        'songId': song_id,
        'difficulty': difficulty,
        'generated': True,
        'version': CHART_VERSION,
        'laneCount': lane_count,
        'bpm': round(analysis.bpm, 2),
        'musicStartMs': analysis.music_start_ms,
        'endMs': end_ms,
        'notes': lanes,
    }


# ---------------------------------------------------------------- 검증
def validate_chart(chart, duration_ms, *, music_start_ms=None):
    """규칙 위반 목록 (비어 있으면 통과)."""
    errors = []
    diff = chart.get('difficulty')
    notes = chart.get('notes')
    lane_count = chart.get('laneCount', DEFAULT_LANE_COUNT)  # 없으면 4키 (이전 채보 호환)
    if diff not in DIFFICULTIES:
        return [f'알 수 없는 난이도 {diff!r}']
    if lane_count not in SUPPORTED_LANE_COUNTS:
        return [f'{diff}: 지원하지 않는 laneCount {lane_count!r}']
    if not isinstance(notes, list) or not notes:
        return [f'{diff}: 노트가 0개입니다']
    seen = set()
    prev_key = None
    for n in notes:
        t, lane = n.get('time'), n.get('lane')
        if not isinstance(t, int) or not isinstance(lane, int):
            errors.append(f'{diff}: time/lane 은 정수여야 합니다 ({n})')
            continue
        if not 0 <= t <= duration_ms:
            errors.append(f'{diff}: {t}ms 가 영상 길이({duration_ms}ms) 밖입니다')
        if not 0 <= lane < lane_count:
            errors.append(f'{diff}: lane {lane} 은 0~{lane_count - 1} 범위가 아닙니다')
        if (t, lane) in seen:
            errors.append(f'{diff}: {t}ms lane {lane} 중복')
        seen.add((t, lane))
        if prev_key is not None and (t, lane) < prev_key:
            errors.append(f'{diff}: 시간순 정렬이 아닙니다 ({t}ms)')
        prev_key = (t, lane)
    times = sorted({n['time'] for n in notes if isinstance(n.get('time'), int)})
    gap = MIN_GAP_MS[diff]
    for a, b in zip(times, times[1:]):
        if b - a < gap:
            errors.append(f'{diff}: {a}ms→{b}ms 간격 {b - a}ms 가 최소 {gap}ms 보다 짧습니다')
            break
    sizes = {}
    for n in notes:
        sizes[n.get('time')] = sizes.get(n.get('time'), 0) + 1
    if any(s >= lane_count for s in sizes.values()):
        errors.append(f'{diff}: {lane_count}레인 전체 동시 입력이 있습니다')
    if music_start_ms is not None and times and times[0] < music_start_ms - 60:
        errors.append(f'{diff}: 첫 노트({times[0]}ms)가 음악 시작({music_start_ms}ms)보다 앞입니다')
    return errors


def validate_set(charts):
    """난이도별 노트 수 관계. (errors, warnings)"""
    counts = {d: len(charts[d]['notes']) for d in DIFFICULTIES if d in charts}
    errors, warnings = [], []
    if set(counts) != set(DIFFICULTIES):
        errors.append('EASY/NORMAL/HARD/HELL 4개 채보가 모두 있어야 합니다')
        return errors, warnings
    if counts['hell'] <= counts['easy']:
        errors.append(f'HELL({counts["hell"]}) 노트 수가 EASY({counts["easy"]}) 보다 많아야 합니다')
    for a, b in zip(DIFFICULTIES, DIFFICULTIES[1:]):
        if counts[b] < counts[a]:
            warnings.append(f'{b.upper()}({counts[b]}) 노트 수가 {a.upper()}({counts[a]}) 보다 적습니다')
    return errors, warnings
