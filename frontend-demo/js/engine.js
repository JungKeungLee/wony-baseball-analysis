// 게임 상태와 판정 진행. DOM/오디오/화면 크기와 무관하다 (화면이 돌거나 크기가 바뀌어도 이 상태는 그대로).
// 모든 시각은 같은 "곡 시간"(ms, 곡 시작 = 0) 기준이며 clock.js 가 그 값을 만든다.
import { END_PADDING_MS, JUDGE_WINDOWS, LIFE, RESULT_STATUS, maxLifeFor, normalizeLaneCount } from './config.js';
import { accuracy, gradeFor, lifeDelta, pointsFor, rankGrade } from './judge.js';

/**
 * @param {{notes: {time: number, lane: number, type?: string, duration?: number}[], endMs?: number}} chart
 * time 은 영상(MP4) 시작 기준 ms. endMs 는 결과 화면으로 넘어가는 시각 (없으면 마지막 노트 + 여유).
 * type 은 지금 'tap' 만 지원. 롱노트는 type:'hold' + duration 으로 확장할 자리만 마련해 둠.
 * @param {{difficulty?: string, noFail?: boolean, windows?: object, laneCount?: number}} options
 *   difficulty: 최대 LIFE (config.MAX_LIFE) · LIFE 감소 배수 (config.LIFE.difficultyMultiplier)
 *   noFail: LIFE 가 0 이 되어도 끝까지 플레이
 *   laneCount: 레인 수 (4/6/8). 없으면 chart.laneCount, 그것도 없으면 4. 0 <= lane < laneCount 인 노트만 쓴다.
 */
/**
 * 게임 1판 고유값 (UUID v4). 온라인 저장 · 츄르 지급의 중복 방지 기준 (DB play_id UNIQUE).
 * 게임 규칙에는 쓰이지 않는다.
 */
export function newPlayId(cryptoImpl = globalThis.crypto) {
  if (typeof cryptoImpl?.randomUUID === 'function') return cryptoImpl.randomUUID();
  const b = new Uint8Array(16);
  if (typeof cryptoImpl?.getRandomValues === 'function') cryptoImpl.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function createGame(chart, { difficulty = 'normal', noFail = false, windows = JUDGE_WINDOWS, laneCount, playId = newPlayId() } = {}) {
  const lanesN = normalizeLaneCount(laneCount ?? chart?.laneCount);
  const notes = (chart?.notes || [])
    .filter(n => Number.isFinite(n.time) && Number.isInteger(n.lane) && n.lane >= 0 && n.lane < lanesN)
    .map(n => ({ time: n.time, lane: n.lane, type: n.type || 'tap', duration: n.duration || 0, grade: null, delta: null }))
    .sort((a, b) => a.time - b.time || a.lane - b.lane);
  const lanes = Array.from({ length: lanesN }, () => []);
  notes.forEach(n => lanes[n.lane].push(n));
  const lastTime = notes.length ? notes[notes.length - 1].time : 0;
  return {
    playId,             // 새 판(시작 · 다시 하기)마다 새 값
    notes,
    laneCount: lanesN,
    lanes,
    laneHead: new Array(lanesN).fill(0), // 레인별 아직 판정 안 된 첫 노트
    windows,
    total: notes.length,
    judged: 0,
    score: 0,
    combo: 0,
    maxCombo: 0,
    counts: { PERFECT: 0, GREAT: 0, GOOD: 0, MISS: 0 },
    difficulty,
    noFail: Boolean(noFail),
    life: maxLifeFor(difficulty),
    lifeMax: maxLifeFor(difficulty),
    healCombo: 0,       // 마지막으로 LIFE 를 회복한 콤보 (같은 10콤보 구간 중복 회복 방지, MISS 면 0)
    healed: 0,          // 이번 판 콤보 회복 합계
    lastHeal: null,     // 마지막 회복 { amount, combo, time, seq } (화면 효과용)
    lifeZeroAt: null,   // LIFE 가 처음 0 이 된 시각 (NO FAIL 이어도 기록)
    gameOver: false,    // NO FAIL 이 아니면 LIFE 0 → GAME OVER
    status: 'ready', // ready | playing | paused | ended | failed
    endTime: Number(chart?.endMs) > lastTime ? Number(chart.endMs) : lastTime + END_PADDING_MS,
    lastJudgement: null,
    judgementSeq: 0,
  };
}

export function startGame(state) {
  if (state.status === 'ready') state.status = 'playing';
}

export function pauseGame(state) {
  if (state.status === 'playing') state.status = 'paused';
}

export function resumeGame(state) {
  if (state.status === 'paused') state.status = 'playing';
}

function headNote(state, lane) {
  const queue = state.lanes[lane];
  while (state.laneHead[lane] < queue.length && queue[state.laneHead[lane]].grade) state.laneHead[lane]++;
  return queue[state.laneHead[lane]] || null;
}

function judge(state, note, grade, delta, time) {
  note.grade = grade;
  note.delta = delta;
  state.judged++;
  state.counts[grade]++;
  state.combo = grade === 'MISS' ? 0 : state.combo + 1;
  state.maxCombo = Math.max(state.maxCombo, state.combo);
  state.score += pointsFor(grade, state.combo);
  if (grade === 'MISS') state.healCombo = 0;
  const change = lifeDelta(grade, state.difficulty);
  if (change) {
    state.life = Math.min(state.lifeMax, Math.max(0, state.life + change));
    if (state.life <= 0 && state.lifeZeroAt === null) {
      state.lifeZeroAt = time;
      if (!state.noFail) {
        state.gameOver = true;
        state.status = 'failed'; // 이후 입력/자동 MISS 없음
      }
    }
  }
  if (!state.gameOver) comboHeal(state, time);
  state.judgementSeq++;
  state.lastJudgement = { grade, lane: note.lane, delta, time, combo: state.combo, seq: state.judgementSeq };
  return state.lastJudgement;
}

/** 콤보 회복: every 콤보마다 amount (최대 LIFE 까지). 같은 콤보 구간에서는 1번만 */
function comboHeal(state, time, heal = LIFE.comboHeal) {
  const { combo } = state;
  if (!heal || combo <= 0 || combo % heal.every !== 0 || combo === state.healCombo) return;
  state.healCombo = combo;
  const amount = Math.min(heal.amount, state.lifeMax - state.life);
  if (amount <= 0) return;   // 이미 가득 참
  state.life += amount;
  state.healed += amount;
  state.lastHeal = { amount, combo, time, seq: (state.lastHeal?.seq ?? 0) + 1 };
}

/**
 * 키보드/터치 공통 입력 처리. 판정이 일어나면 판정 정보를, 아니면 null.
 * 일시정지/준비/종료 상태에서는 아무것도 하지 않는다.
 */
export function hitLane(state, lane, time) {
  if (state.status !== 'playing' || !Number.isInteger(lane) || lane < 0 || lane >= state.laneCount) return null;
  let note = headNote(state, lane);
  // 프레임이 늦어 아직 자동 MISS 처리되지 않은 지난 노트는 먼저 정리한다.
  while (note && time - note.time > state.windows.GOOD) {
    judge(state, note, 'MISS', time - note.time, time);
    if (state.status !== 'playing') return state.lastJudgement;
    note = headNote(state, lane);
  }
  if (!note) return null;
  const delta = time - note.time;
  const grade = gradeFor(delta, state.windows);
  return grade ? judge(state, note, grade, delta, time) : null;
}

/** 롱노트 확장용 자리. 일반 노트만 있는 지금은 아무 일도 하지 않는다. */
export function releaseLane(state, lane, time) { // eslint-disable-line no-unused-vars
  return null;
}

/** 매 프레임 호출: GOOD 창을 지난 노트를 MISS 처리. @returns 새로 생긴 MISS 수 */
export function updateGame(state, time) {
  if (state.status !== 'playing') return 0;
  let missed = 0;
  for (let lane = 0; lane < state.laneCount; lane++) {
    let note = headNote(state, lane);
    while (note && time - note.time > state.windows.GOOD) {
      judge(state, note, 'MISS', time - note.time, time);
      missed++;
      if (state.status !== 'playing') return missed; // GAME OVER
      note = headNote(state, lane);
    }
  }
  if (state.judged === state.total && time >= state.endTime) state.status = 'ended';
  return missed;
}

/** 음원이 먼저 끝난 경우 등: 남은 노트를 MISS로 처리하고 종료. */
export function finishGame(state, time) {
  for (const note of state.notes) {
    if (state.status === 'failed') return;
    if (!note.grade) judge(state, note, 'MISS', null, time);
  }
  state.status = 'ended';
}

/** 게임이 끝났는지 (곡 끝 또는 GAME OVER) */
export function isFinished(state) {
  return state.status === 'ended' || state.status === 'failed';
}

export function resultOf(state) {
  // 정확도는 전체 노트 대비: GAME OVER 로 못 친 노트는 0점으로 계산된다
  const acc = accuracy(state.counts, state.total);
  return {
    score: state.score,
    maxCombo: state.maxCombo,
    counts: { ...state.counts },
    total: state.total,
    accuracy: acc,
    life: Math.round(state.life * 10) / 10,
    lifeMax: state.lifeMax,
    gameOver: state.gameOver,
    grade: rankGrade(acc, { gameOver: state.gameOver }),
  };
}

export const RESULT_SCHEMA_VERSION = 3;

/**
 * "정상 클리어 판"이 아닌 이유. 정상 클리어면 null.
 * 정상 클리어 = status CLEAR + NO FAIL 미사용 + 자동 플레이 아님 + 미리보기 아님.
 * 최고 기록 갱신(storage.saveBestRecord)과 온라인 랭킹(ranking.isRankingEligible)이 같은 규칙을 쓴다.
 * @returns {null | 'GAME_OVER' | 'NO_FAIL_CLEAR' | 'NO_FAIL' | 'AUTOPLAY' | 'PREVIEW' | 'NOT_CLEAR'}
 */
export function notNormalClearReason(record, { autoplay, preview } = {}) {
  if (!record) return 'NOT_CLEAR';
  if (autoplay ?? record.autoplay) return 'AUTOPLAY';
  if (preview ?? record.preview) return 'PREVIEW';
  if (record.status === RESULT_STATUS.GAME_OVER) return 'GAME_OVER';
  if (record.status === RESULT_STATUS.NO_FAIL_CLEAR) return 'NO_FAIL_CLEAR';
  if (record.status !== RESULT_STATUS.CLEAR) return 'NOT_CLEAR';
  if (record.noFail !== false) return 'NO_FAIL'; // NO FAIL 을 켰으면 LIFE 가 남았어도 제외
  return null;
}

export function isNormalClear(record, context) {
  return notNormalClearReason(record, context) === null;
}

/**
 * 최근 플레이 기록에 남기지 않는 이유. 남겨야 하면 null.
 * 실제 사용자 플레이(CLEAR / GAME_OVER / NO FAIL)는 모두 남기고, 테스트/검증용인 자동 플레이·미리보기만 뺀다.
 * @returns {null | 'AUTOPLAY' | 'PREVIEW' | 'INVALID'}
 */
export function recentRecordSkipReason(record, { autoplay, preview } = {}) {
  if (!record || typeof record !== 'object') return 'INVALID';
  if (autoplay ?? record.autoplay) return 'AUTOPLAY';
  if (preview ?? record.preview) return 'PREVIEW';
  return null;
}

export function isRecentRecordAllowed(record, context) {
  return recentRecordSkipReason(record, context) === null;
}

/** 결과 상태 (등급과 별개): CLEAR / GAME_OVER / NO_FAIL_CLEAR */
export function resultStatus(state) {
  if (state.gameOver) return RESULT_STATUS.GAME_OVER;
  if (state.lifeZeroAt !== null) return RESULT_STATUS.NO_FAIL_CLEAR; // NO FAIL 이 아니었다면 GAME OVER 였을 판
  return RESULT_STATUS.CLEAR;
}

/**
 * 저장/표시/랭킹용 결과 기록 (실제 배속 포함). 최고 점수는 songId + difficulty 기준이며 배속과 무관.
 * 이 객체 그대로 향후 온라인 랭킹(ranking.js → Supabase)에 보낼 수 있게 평평한 구조로 둔다.
 */
export function resultRecord(state, { songId, difficulty, noteSpeed }) {
  const r = resultOf(state);
  const status = resultStatus(state);
  return {
    schema: RESULT_SCHEMA_VERSION,
    playId: state.playId,
    status,
    songId,
    difficulty,
    laneCount: state.laneCount,
    noteSpeed,
    score: r.score,
    maxCombo: r.maxCombo,
    perfect: r.counts.PERFECT,
    great: r.counts.GREAT,
    good: r.counts.GOOD,
    miss: r.counts.MISS,
    totalNotes: r.total,
    accuracy: r.accuracy,
    life: r.life,
    lifeMax: r.lifeMax,   // 표시용 (온라인 행에는 보내지 않음)
    grade: r.grade,
    // 이전 버전 호환용 파생 값 (판단은 status 로)
    cleared: status === RESULT_STATUS.CLEAR,
    gameOver: status === RESULT_STATUS.GAME_OVER,
    noFail: state.noFail,
  };
}
