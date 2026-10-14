// WONY RHYTHM 게임 상수. 판정/점수/정확도/배속은 여기 한 곳에서만 바꾼다.
// (자동 채보 생성 규칙은 tools/chart_config.py)

// 레인 수 (모드). 지금 UI 는 4키만 쓰지만 코드는 laneCount 를 받아 6키/8키로 확장할 수 있다.
// 레인 번호 범위: 0 <= lane < laneCount. 채보 JSON 의 laneCount 가 없으면 4.
export const DEFAULT_LANE_COUNT = 4;
export const SUPPORTED_LANE_COUNTS = Object.freeze([4, 6, 8]);
/** @deprecated 4키 전용 코드 호환용. 새 코드는 laneCount 를 쓴다. */
export const LANES = DEFAULT_LANE_COUNT;

export function isSupportedLaneCount(n) {
  return SUPPORTED_LANE_COUNTS.includes(n);
}

export function normalizeLaneCount(n) {
  const v = Number(n);
  return isSupportedLaneCount(v) ? v : DEFAULT_LANE_COUNT;
}

// 판정 창 (ms, |video 시각 - 노트 시각| 이하이면 해당 등급, 경계값 포함). 모든 난이도 공통.
export const JUDGE_WINDOWS = Object.freeze({
  PERFECT: 70,
  GREAT: 120,
  GOOD: 180,
  // GOOD 창보다 이르게 눌렀지만 이 값 이내면 그 노트를 MISS로 처리한다.
  // 이보다 더 이르면 빈 입력으로 무시한다. 늦은 노트는 GOOD 창이 지나면 자동 MISS.
  EARLY_MISS: 250,
});

export const GRADES = Object.freeze(['PERFECT', 'GREAT', 'GOOD', 'MISS']);

export const SCORE_POINTS = Object.freeze({ PERFECT: 1000, GREAT: 700, GOOD: 400, MISS: 0 });

// 콤보 보너스: 10콤보마다 노트당 +10점, 최대 +100점 (MISS면 0)
export const COMBO_BONUS = Object.freeze({ every: 10, points: 10, max: 100 });

export const ACCURACY_WEIGHTS = Object.freeze({ PERFECT: 100, GREAT: 80, GOOD: 50, MISS: 0 });

// LIFE (하트 개수): 난이도별 최대 LIFE 로 시작, 0 이 되면 GAME OVER (NO FAIL 이면 끝까지 플레이).
export const MAX_LIFE = Object.freeze({ easy: 10, normal: 8, hard: 5, hell: 3 });
export const LIFE = Object.freeze({
  maxByDifficulty: MAX_LIFE,
  // 판정별 변화량 (LIFE 단위). MISS 1개 = 하트 1개. 양수를 넣으면 최대 LIFE 까지 회복된다.
  delta: Object.freeze({ PERFECT: 0, GREAT: 0, GOOD: 0, MISS: -1 }),
  // 감소(음수)에만 적용하는 난이도 배수. 난이도 차이는 최대 LIFE 로 두므로 지금은 모두 1.
  difficultyMultiplier: Object.freeze({ easy: 1.0, normal: 1.0, hard: 1.0, hell: 1.0 }),
  // 콤보 회복: 콤보가 every 의 배수가 될 때마다 amount 회복 (최대 LIFE 초과 없음, MISS 로 콤보가 끊기면 다시 0부터)
  comboHeal: Object.freeze({ every: 10, amount: 0.5 }),
});

/** 난이도의 최대 LIFE (모르는 난이도는 NORMAL) */
export function maxLifeFor(difficulty) {
  return MAX_LIFE[difficulty] ?? MAX_LIFE.normal;
}

// 결과 등급: 정확도(%)가 min 이상인 첫 등급. GAME OVER(NO FAIL 아님)는 정확도와 무관하게 F.
export const RANK_GRADES = Object.freeze([
  Object.freeze({ grade: 'S+', min: 98 }),
  Object.freeze({ grade: 'S', min: 95 }),
  Object.freeze({ grade: 'A', min: 90 }),
  Object.freeze({ grade: 'B', min: 80 }),
  Object.freeze({ grade: 'C', min: 70 }),
  Object.freeze({ grade: 'D', min: 60 }),
  Object.freeze({ grade: 'F', min: 0 }),
]);
export const GAME_OVER_GRADE = 'F';

// 결과 상태 (등급과 별개)
//   CLEAR         : 끝까지 LIFE 가 0 이 되지 않음 (NO FAIL 을 켜 두었어도 LIFE 가 남았으면 CLEAR)
//   GAME_OVER     : NO FAIL 이 아닌데 LIFE 0
//   NO_FAIL_CLEAR : NO FAIL 덕분에 LIFE 0 이후에도 끝까지 플레이
export const RESULT_STATUS = Object.freeze({ CLEAR: 'CLEAR', GAME_OVER: 'GAME_OVER', NO_FAIL_CLEAR: 'NO_FAIL_CLEAR' });
export const RESULT_STATUS_LABELS = Object.freeze({ CLEAR: 'CLEAR', GAME_OVER: 'GAME OVER', NO_FAIL_CLEAR: 'NO FAIL CLEAR' });

// 모드별 기본 키 (KeyboardEvent.code). 4키는 기존 기본값(← ↓ ↑ →)을 유지한다.
export const DEFAULT_KEYS_BY_LANE_COUNT = Object.freeze({
  4: Object.freeze(['ArrowLeft', 'ArrowDown', 'ArrowUp', 'ArrowRight']),
  6: Object.freeze(['KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL']),
  8: Object.freeze(['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon']),
});
export const DEFAULT_KEYS = DEFAULT_KEYS_BY_LANE_COUNT[DEFAULT_LANE_COUNT];

// 레인 색 (앞에서부터 laneCount 개 사용 → 4키는 기존 색 그대로)
export const LANE_PALETTE = Object.freeze(['#5AA9FF', '#6FD6BE', '#FFD166', '#FF92B0', '#B49CFF', '#7FD8FF', '#FFB077', '#9BE37F']);

export function laneColors(laneCount = DEFAULT_LANE_COUNT) {
  return Array.from({ length: laneCount }, (_, i) => LANE_PALETTE[i % LANE_PALETTE.length]);
}

// 노트 배속: 노트가 화면 위에서 판정선까지 내려오는 시간(approach)만 바꾼다.
// 영상/음악 속도(video.playbackRate)는 항상 1.0, 판정 시각도 그대로.
export const BASE_APPROACH_MS = 2000;
export const NOTE_SPEEDS = Object.freeze([0.75, 1.0, 1.25, 1.5, 1.75, 2.0]);

export const DEFAULT_SETTINGS = Object.freeze({
  keys: DEFAULT_KEYS,
  noteSpeed: 1.0,
  showVideo: true,
  noFail: false,         // NO FAIL: LIFE 가 0 이 되어도 곡 끝까지 플레이 (온라인 랭킹 대상에서는 제외 예정)
  offsetMs: 0,          // 판정 보정: +면 노트가 더 늦게 도착 (블루투스 이어폰 등)
  touchControls: 'auto', // auto | on | off
});

export const OFFSET_RANGE = Object.freeze({ min: -200, max: 200, step: 10 });

export const COUNTDOWN_MS = 3000;
// 채보에 endMs 가 없을 때 마지막 노트 이후 결과 화면까지 기다리는 시간
export const END_PADDING_MS = 2000;

export const DIFFICULTIES = Object.freeze(['easy', 'normal', 'hard', 'hell']);
export const DIFFICULTY_LABELS = Object.freeze({ easy: 'EASY', normal: 'NORMAL', hard: 'HARD', hell: 'HELL' });

// ── 츄르 보상 (화면 표시 · 게스트 로컬 지갑용 기본값) ───────────────────────────
// 로그인 회원의 실제 지급량은 DB(rhythm_reward_rules × rhythm_song_rewards)가 결정한다. 이 값은 DB 초기값과 같게 유지
// (supabase/tests 가 006 SQL 의 초기값과 같은지 확인). 지급 조건은 랭킹과 같은 isRankingEligible 하나.
export const CHURU_REWARDS = Object.freeze({ easy: 1, normal: 2, hard: 4, hell: 7 });
// 곡별 보상 조정 (선택): { [songId]: { multiplier, bonus } } → 지급량 = round(기본값 × multiplier) + bonus
export const SONG_CHURU_REWARDS = Object.freeze({});

export function churuRewardFor(difficulty, songId, songRewards = SONG_CHURU_REWARDS) {
  const base = CHURU_REWARDS[difficulty] ?? 0;
  const adj = (songId && songRewards[songId]) || {};
  const multiplier = Number.isFinite(adj.multiplier) ? adj.multiplier : 1;
  const bonus = Number.isFinite(adj.bonus) ? adj.bonus : 0;
  return Math.max(0, Math.round(base * multiplier) + bonus);
}

// ── 스킨 · 상점 ─────────────────────────────────────────────────────────────
// 스킨은 화면 모양만 바꾼다 (판정 · 점수 · LIFE · 콤보 · 채보 · 타이밍 · 영상 시계와 무관).
export const DEFAULT_UI_SKIN_ID = 'default-ui';
export const DEFAULT_RHYTHM_BAR_SKIN_ID = 'default-rhythm';
// 상점 판매 시작 전까지 false: 상점은 "준비 중" 화면만, 구매 요청은 SHOP_CLOSED
export const SHOP_OPEN = false;
