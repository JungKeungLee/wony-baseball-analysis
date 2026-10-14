"""자동 채보 생성 규칙. 실제로 플레이해 본 뒤 조정할 값은 모두 여기에 있다.

판정 창(PERFECT/GREAT/GOOD)은 난이도와 무관하게 게임(frontend-demo/js/config.js)에서 동일하다.
난이도 차이는 노트 수 / 밀도 / 패턴 / 동시치기 / 리듬 복잡도로만 만든다.
"""

DIFFICULTIES = ('easy', 'normal', 'hard', 'hell')

# 같은 시각이 아닌 두 노트 사이 최소 간격 (ms)
MIN_GAP_MS = {
    'easy': 250,
    'normal': 170,
    'hard': 110,
    'hell': 80,
}

# 박자 위치 등급 (audio_analyzer 가 붙인다)
#   0 = 마디 첫 박(강박)  1 = 3번째 박(중간 강박)  2 = 2·4번째 박
#   3 = 8분음표 위치     4 = 16분음표 위치          5 = 격자 밖 onset (싱코페이션 등)
#
# min_strength: 그 위치의 onset 세기(0~1)가 이 값 이상일 때만 노트 후보. None 이면 그 등급은 사용 안 함.
# 3 이상(박 사이) 위치는 실제 onset 이 있어야만 후보가 된다 ("박자만 맞춰 아무 데나 찍기" 금지).
RULES = {
    'easy': {
        'min_strength': {0: 0.04, 1: 0.06, 2: 0.30, 3: None, 4: None, 5: None},
        'level2_min_intensity': 0.45,   # 2·4박은 곡이 충분히 신날 때만
        'max_bpm_for_level2': 150,      # 빠른 곡은 2분음표 위주
        'max_nps': 3.0,                 # 1초 안 최대 노트 수
        'chord_rate': 0.0,              # 동시치기 거의 없음
        'chord_gap_ms': 600,
        'triple_rate': 0.0,
        'jack_gap_ms': 450,             # 이 간격보다 가까우면 같은 레인 연속 금지
        'max_step': 2,                  # 한 번에 이동하는 레인 수 상한
        'cross_gap_ms': 0,              # 이 간격보다 빠르면 좌우 손 교차 선호 (0 = 안 씀)
    },
    'normal': {
        # 8분 위치는 아주 강한 onset 만 (실제 곡 wony-cover-01 검증: 0.40 이면 8분 연타가 95%)
        'min_strength': {0: 0.03, 1: 0.03, 2: 0.06, 3: 0.85, 4: None, 5: None},
        'level2_min_intensity': 0.0,
        'max_bpm_for_level2': 999,
        'max_nps': 4.0,
        'chord_rate': 0.05,
        'chord_gap_ms': 320,
        'triple_rate': 0.0,
        'jack_gap_ms': 260,
        'max_step': 3,
        'cross_gap_ms': 0,
    },
    'hard': {
        # 16분/격자 밖은 강한 onset 만 → HELL 과 차이 (실제 곡 검증: 0.42/0.55 면 HELL 과 입력 수 11% 차이)
        'min_strength': {0: 0.02, 1: 0.02, 2: 0.04, 3: 0.30, 4: 0.60, 5: 0.70},
        'level2_min_intensity': 0.0,
        'max_bpm_for_level2': 999,
        'max_nps': 6.5,
        'chord_rate': 0.12,
        'chord_gap_ms': 220,
        'triple_rate': 0.0,
        'jack_gap_ms': 180,
        'max_step': 3,
        'cross_gap_ms': 200,
    },
    'hell': {
        'min_strength': {0: 0.0, 1: 0.0, 2: 0.02, 3: 0.08, 4: 0.20, 5: 0.32},
        'level2_min_intensity': 0.0,
        'max_bpm_for_level2': 999,
        'max_nps': 12.0,
        'chord_rate': 0.20,
        'chord_gap_ms': 150,
        'triple_rate': 0.02,            # 아주 강한 강박에서만 3키, 4키 동시는 만들지 않음
        'jack_gap_ms': 140,
        'max_step': 3,
        'cross_gap_ms': 170,
    },
}

# 등급별 우선순위 가중치: 최소 간격/밀도 제한에 걸릴 때 어떤 노트를 남길지 정한다
LEVEL_WEIGHT = {0: 1.0, 1: 0.9, 2: 0.75, 3: 0.55, 4: 0.4, 5: 0.35}

# 레인 수 (모드). 지금 게임 UI 는 4키만 쓰지만 생성/검증은 laneCount 를 받아 6키/8키로 확장할 수 있다.
DEFAULT_LANE_COUNT = 4
SUPPORTED_LANE_COUNTS = (4, 6, 8)

# 동시치기 레인 조합 (전체 레인 동시는 만들지 않는다). 4키는 기존 조합/순서 그대로.
CHORD_PAIRS = ((0, 3), (1, 2), (0, 2), (1, 3), (0, 1), (2, 3))
CHORD_TRIPLES = ((0, 1, 3), (0, 2, 3))


def chord_combos(lane_count, size):
    """laneCount 별 동시치기 조합. 4키는 위 상수 그대로, 6/8키는 같은 원칙(대칭 → 한 칸 건너 → 인접)으로 만든다."""
    if lane_count == 4:
        return CHORD_PAIRS if size == 2 else CHORD_TRIPLES
    n = lane_count
    if size == 2:
        symmetric = [(i, n - 1 - i) for i in range(n // 2)]                 # 양손 대칭 (0,n-1) …
        skip_one = [(i, i + 2) for i in range(n - 2)]                        # 한 칸 건너
        adjacent = [(i, i + 1) for i in range(n - 1)]                        # 인접
        out = []
        for combo in symmetric + skip_one + adjacent:
            if combo not in out:
                out.append(combo)
        return tuple(out)
    half = n // 2
    return tuple(sorted({(0, half - 1, n - 1), (0, half, n - 1), (0, 1, n - 1), (0, n - 2, n - 1)}))

# 6 / 8 KEY 전용 조정 (4키 규칙 RULES 위에 덮어씀. 4키 채보는 영향 없음)
#   손배치: 왼손 = 앞쪽 절반 레인, 오른손 = 뒤쪽 절반. 빠른 구간은 양손 교대(cross_gap_ms), 동시치기는 양손에 나눠 줌
#   레인이 많을수록 한 번에 움직일 수 있는 폭(max_step) · 동시치기 비율이 조금 커짐 (손가락이 더 많음)
#   EASY 는 동시치기 없이 가까운 레인 위주 (초보자 판독), HELL 은 3키 동시 · 넓은 이동 · 빠른 양손 교대
LANE_MODE_RULES = {
    6: {
        'easy': {'max_step': 2, 'chord_rate': 0.0, 'triple_rate': 0.0},
        'normal': {'max_step': 3, 'chord_rate': 0.07, 'triple_rate': 0.0},
        'hard': {'max_step': 4, 'chord_rate': 0.16, 'triple_rate': 0.0, 'cross_gap_ms': 220},
        'hell': {'max_step': 4, 'chord_rate': 0.24, 'triple_rate': 0.04, 'cross_gap_ms': 190},
    },
    8: {
        'easy': {'max_step': 3, 'chord_rate': 0.0, 'triple_rate': 0.0},
        'normal': {'max_step': 4, 'chord_rate': 0.08, 'triple_rate': 0.0},
        'hard': {'max_step': 5, 'chord_rate': 0.18, 'triple_rate': 0.01, 'cross_gap_ms': 230},
        'hell': {'max_step': 5, 'chord_rate': 0.28, 'triple_rate': 0.06, 'cross_gap_ms': 200},
    },
}
# 같은 손으로 이 횟수보다 많이 연속하면 감점 (빠른 구간에서 한 손만 혹사하지 않게, 6/8키만)
SAME_HAND_RUN = {'easy': 4, 'normal': 4, 'hard': 3, 'hell': 3}


def rules_for(difficulty, lane_count=DEFAULT_LANE_COUNT):
    """난이도 규칙 + KEY 모드 조정 (4키는 RULES 그대로)"""
    return {**RULES[difficulty], **LANE_MODE_RULES.get(lane_count, {}).get(difficulty, {})}


CHART_VERSION = 1
