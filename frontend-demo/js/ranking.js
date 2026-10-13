// 온라인 기록 · 랭킹 (WONY PHONE 과 같은 Supabase).
//
// 브라우저 → WONY RHYTHM 서버(/api/rhythm/*) → Supabase 서명 함수. 브라우저는 Supabase 에 직접 쓰지 않는다.
//   · 로그인: WONY PHONE 의 1회용 입장권으로 이 서버의 세션 쿠키를 받음 (user_id 는 서버가 세션에서 결정)
//   · 게임 플레이 중에는 호출하지 않는다. 결과 화면에서 submitRanking 1번, 랭킹 화면에서 loadRanking.
//   · 실패해도 게임/로컬 기록에는 영향 없음 (결과만 돌려주고 throw 하지 않음)
//
// 기록 정책 (storage.js 표와 같음, shared/record_policy_cases.json 으로 서버 · DB 와 같은 규칙인지 테스트)
//   정상 CLEAR       : 온라인 플레이 기록 + 최고 기록 + 랭킹
//   GAME_OVER/NO FAIL: 온라인 플레이 기록만 (최고 기록 · 랭킹 X)  ← DB 가 같은 규칙(rhythm_private.is_normal_clear)으로 판단
//   AUTO / PREVIEW   : 서버로 보내지 않음
import { DEFAULT_LANE_COUNT } from './config.js';
import { isNormalClear, notNormalClearReason, recentRecordSkipReason } from './engine.js';

export const ONLINE_API = '/api/rhythm';
const TIMEOUT_MS = 8000;
const RETRY_DELAY_MS = 800;

let fetchImpl = (...args) => globalThis.fetch(...args);
/** 테스트용 */
export function setFetch(fn) {
  fetchImpl = fn;
}

/** 온라인 랭킹에 올라가는 기록인지: 정상 클리어(CLEAR + NO FAIL/자동 플레이/미리보기 아님) + 판정 합계 일치 */
export function isRankingEligible(record, context = {}) {
  return isNormalClear(record, context)
    && record.perfect + record.great + record.good + record.miss === record.totalNotes;
}

const EXCLUDED_TEXT = {
  GAME_OVER: 'GAME OVER 플레이는 온라인 랭킹에 반영되지 않습니다.',
  NO_FAIL: 'NO FAIL 플레이는 온라인 랭킹에 반영되지 않습니다.',
  NO_FAIL_CLEAR: 'NO FAIL 플레이는 온라인 랭킹에 반영되지 않습니다.',
  AUTOPLAY: '자동 플레이는 온라인 랭킹에 반영되지 않습니다.',
  PREVIEW: '미리보기 플레이는 온라인 랭킹에 반영되지 않습니다.',
  NOT_CLEAR: '이 플레이는 온라인 랭킹에 반영되지 않습니다.',
};

/** 랭킹 · 츄르 대상이 아닌 이유 안내 (대상이면 null) */
export function rankingExclusionText(record, context = {}) {
  if (isRankingEligible(record, context)) return null;
  return EXCLUDED_TEXT[notNormalClearReason(record, context)] || EXCLUDED_TEXT.NOT_CLEAR;
}

/** 서버로 보내는 판인지: 실제 플레이(CLEAR / GAME_OVER / NO FAIL)만. AUTO · PREVIEW 는 보내지 않음 */
export function isOnlineSubmittable(record, context = {}) {
  return recentRecordSkipReason(record, context) === null;
}

/**
 * 게임 결과(engine.resultRecord) → DB 컬럼 이름 (public.rhythm_play_records 와 1:1).
 * user_id 는 넣지 않는다 (서버가 로그인 세션에서 정함). play_id = 게임 1판 고유값 (재전송해도 1번만 저장 · 지급).
 * 츄르 지급량 · 잔액은 보내지 않는다 (DB 가 계산).
 */
export function toRankingRow(record) {
  return {
    play_id: record.playId,
    song_id: record.songId,
    difficulty: record.difficulty,
    lane_count: record.laneCount ?? DEFAULT_LANE_COUNT,
    note_speed: record.noteSpeed,
    status: record.status,
    no_fail: record.noFail === true,
    score: record.score,
    grade: record.grade,
    accuracy: record.accuracy,
    max_combo: record.maxCombo,
    perfect_count: record.perfect,
    great_count: record.great,
    good_count: record.good,
    miss_count: record.miss,
    total_notes: record.totalNotes,
    final_life: record.life,
    result_version: record.schema,
  };
}

async function request(path, options = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null;
  try {
    const res = await fetchImpl(`${ONLINE_API}${path}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...options,
      headers: { Accept: 'application/json', ...(options.headers || {}) },
      signal: controller?.signal,
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, ok: res.ok, body };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const REASON_BY_STATUS = { 401: 'login-required', 403: 'forbidden', 429: 'too-many', 503: 'not-configured' };

/**
 * 로그인 · 온라인 기능 상태. { loggedIn, nickname, onlineEnabled, loginUrl, churuBalance }
 * churuBalance: 로그인 회원의 서버 츄르 잔액 (못 읽었거나 비로그인이면 null)
 * 서버에 닿지 않으면 { loggedIn: false, onlineEnabled: false, error: true }
 */
export async function getOnlineStatus() {
  try {
    const r = await request('/me');
    if (!r.ok || !r.body) return { loggedIn: false, onlineEnabled: false, error: true };
    return {
      loggedIn: r.body.loggedIn === true,
      nickname: typeof r.body.nickname === 'string' ? r.body.nickname : null,
      onlineEnabled: r.body.onlineEnabled === true,
      loginUrl: typeof r.body.loginUrl === 'string' ? r.body.loginUrl : null,
      churuBalance: Number.isInteger(r.body.churuBalance) && r.body.churuBalance >= 0 ? r.body.churuBalance : null,
    };
  } catch {
    return { loggedIn: false, onlineEnabled: false, error: true };
  }
}

const intOrNull = v => (Number.isInteger(v) ? v : null);

function submitResult(body) {
  const churu = body.churu && typeof body.churu === 'object' ? body.churu : {};
  const granted = churu.granted === true;
  return {
    submitted: true,
    ranked: body.ranked === true,
    duplicate: body.duplicate === true,
    best: body.best ?? null,
    improved: body.improved ?? {},
    rankBefore: intOrNull(body.rankBefore),
    rankAfter: intOrNull(body.rankAfter),
    totalRanked: intOrNull(body.totalRanked),
    bestBefore: intOrNull(body.bestBefore),
    // 지급량 · 잔액은 서버(DB)가 계산한 값 그대로
    churu: {
      granted,
      amount: granted ? (intOrNull(churu.amount) ?? 0) : 0,
      balanceBefore: granted ? intOrNull(churu.balanceBefore) : null,
      balanceAfter: granted ? intOrNull(churu.balanceAfter) : null,
    },
  };
}

/**
 * 게임 결과 1건을 온라인에 저장 (결과 화면에서 1판에 1번 호출).
 * 네트워크 · 서버 장애면 같은 play_id 로 1번 더 보낸다 (DB 가 play_id 로 중복 저장 · 중복 지급을 막음).
 * @returns {Promise<{submitted: boolean, reason?: string, ranked?: boolean, duplicate?: boolean, best?: object|null, improved?: object,
 *                    rankBefore?: number|null, rankAfter?: number|null, totalRanked?: number|null, bestBefore?: number|null,
 *                    churu?: {granted: boolean, amount: number, balanceBefore: number|null, balanceAfter: number|null}}>}
 *   reason: 'autoplay' | 'preview' | 'login-required' | 'not-configured' | 'too-many' | 'rejected' | 'failed'
 */
export async function submitRanking(record, context = {}, { retries = 1, retryDelayMs = RETRY_DELAY_MS } = {}) {
  const skip = recentRecordSkipReason(record, context);
  if (skip) return { submitted: false, reason: skip === 'AUTOPLAY' ? 'autoplay' : skip === 'PREVIEW' ? 'preview' : 'rejected' };
  const body = JSON.stringify(toRankingRow(record));
  let reason = 'failed';
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, retryDelayMs));
    try {
      const r = await request('/results', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (r.ok && r.body?.ok) return submitResult(r.body);
      reason = REASON_BY_STATUS[r.status] || (r.status >= 400 && r.status < 500 ? 'rejected' : 'failed');
    } catch {
      reason = 'failed';
    }
    if (reason !== 'failed') break;   // 로그인 필요 · 값 거절 등은 다시 보내도 같음
  }
  return { submitted: false, reason };
}

/**
 * 곡 + 난이도 온라인 랭킹 (회원당 최고 기록 1줄). 로그인 회원만. 랭킹 기준 = 곡 + 난이도 (배속 구분 없음).
 * @returns {Promise<{ok: boolean, rows: Array<{rank, nickname, bestScore, bestGrade, bestAccuracy, bestMaxCombo, isMe}>, reason?: string}>}
 */
export async function loadRanking(songId, difficulty, { laneCount = DEFAULT_LANE_COUNT, limit = 50, around = 0 } = {}) {
  const q = new URLSearchParams({ song: songId, difficulty, laneCount: String(laneCount), limit: String(limit) });
  if (around > 0) q.set('around', String(around));   // 상위 limit + 내 앞뒤 around 순위
  try {
    const r = await request(`/ranking?${q}`);
    if (!r.ok || !Array.isArray(r.body?.rows)) {
      return { ok: false, rows: [], reason: REASON_BY_STATUS[r.status] || 'failed' };
    }
    return { ok: true, rows: r.body.rows };
  } catch {
    return { ok: false, rows: [], reason: 'failed' };
  }
}
