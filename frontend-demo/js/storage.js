// 저장 계층. 게임/화면 코드는 localStorage 를 직접 만지지 않고 이 함수들만 쓴다.
// 나중에 Supabase 로 옮길 때는 이 파일만 바꾸면 된다. 플레이 도중에는 호출하지 않는다
// (설정은 시작 전에 읽고, 최고 점수/결과는 결과 화면에서 한 번만 저장).
import {
  DEFAULT_LANE_COUNT, DEFAULT_SETTINGS, DIFFICULTIES, OFFSET_RANGE, RESULT_STATUS, SUPPORTED_LANE_COUNTS, normalizeLaneCount,
} from './config.js';
import { notNormalClearReason, recentRecordSkipReason } from './engine.js';
import { gradeOrder, isBetterGrade } from './judge.js';
import { defaultKeys, isValidKeySet } from './keys.js';
import { normalizeSpeed } from './layout.js';

export const STORAGE_KEYS = Object.freeze({
  settings: 'wony_rhythm_settings',
  scores: 'wony_rhythm_scores',
  results: 'wony_rhythm_results',
  last: 'wony_rhythm_last',
  legacyKeys: 'wony_rhythm_keys', // 이전 버전: 키 설정을 따로 저장했었다
});

const MAX_RESULTS = 50;
let backend = null;

/** 테스트나 다른 저장소(Supabase 캐시 등)를 끼울 때 사용. getItem/setItem/removeItem 필요. */
export function setStorageBackend(store) {
  backend = store;
}

function store() {
  if (backend) return backend;
  try {
    return globalThis.localStorage || null;
  } catch {
    return null; // 사파리 개인정보 보호 모드 등
  }
}

function readJson(key) {
  try {
    const raw = store()?.getItem(key);
    return raw == null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  try {
    store()?.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function remove(key) {
  try {
    store()?.removeItem(key);
  } catch { /* 저장소를 못 쓰면 이미 비어 있다 */ }
}

/**
 * 모드(레인 수)별 키: { 4: [...], 6: [...], 8: [...] }. 잘못되었거나 없는 모드는 기본 키.
 * 4키는 이전 버전처럼 settings.keys 에도 같은 값을 둔다 (keys 가 4키의 기준값).
 */
function loadKeyMaps(s) {
  const maps = {};
  for (const n of SUPPORTED_LANE_COUNTS) {
    const saved = s.keyMaps?.[n];
    maps[n] = isValidKeySet(saved, n) ? [...saved] : defaultKeys(n);
  }
  const four = isValidKeySet(s.keys) ? s.keys : readJson(STORAGE_KEYS.legacyKeys);
  if (isValidKeySet(four)) maps[DEFAULT_LANE_COUNT] = [...four];
  return maps;
}

/** 해당 모드의 키 배열 (게임 화면은 채보의 laneCount 로 호출) */
export function keysFor(settings, laneCount = DEFAULT_LANE_COUNT) {
  const n = normalizeLaneCount(laneCount);
  if (n === DEFAULT_LANE_COUNT && isValidKeySet(settings?.keys)) return [...settings.keys];
  const keys = settings?.keyMaps?.[n];
  return isValidKeySet(keys, n) ? [...keys] : defaultKeys(n);
}

/** 해당 모드의 키만 바꾼 새 설정 객체 (저장은 saveSettings) */
export function withKeysFor(settings, laneCount, keys) {
  const n = normalizeLaneCount(laneCount);
  const keyMaps = { ...(settings.keyMaps || {}), [n]: [...keys] };
  return n === DEFAULT_LANE_COUNT ? { ...settings, keys: [...keys], keyMaps } : { ...settings, keyMaps };
}

/** { keys, keyMaps, noteSpeed, showVideo, noFail, offsetMs, touchControls } */
export function loadSettings() {
  const raw = readJson(STORAGE_KEYS.settings);
  const s = raw && typeof raw === 'object' ? raw : {};
  const keyMaps = loadKeyMaps(s);
  const offset = Number(s.offsetMs);
  return {
    keys: [...keyMaps[DEFAULT_LANE_COUNT]],
    keyMaps,
    noteSpeed: normalizeSpeed(s.noteSpeed ?? s.speed ?? DEFAULT_SETTINGS.noteSpeed),
    showVideo: typeof s.showVideo === 'boolean' ? s.showVideo : DEFAULT_SETTINGS.showVideo,
    noFail: typeof s.noFail === 'boolean' ? s.noFail : DEFAULT_SETTINGS.noFail,
    offsetMs: Number.isFinite(offset) ? Math.round(Math.min(OFFSET_RANGE.max, Math.max(OFFSET_RANGE.min, offset))) : 0,
    touchControls: ['auto', 'on', 'off'].includes(s.touchControls) ? s.touchControls : DEFAULT_SETTINGS.touchControls,
  };
}

/** 잘못된 키 조합(중복 등, 어느 모드든)은 저장하지 않고 false 를 돌려준다. */
export function saveSettings(settings) {
  if (!isValidKeySet(settings.keys)) return false;
  const keyMaps = {};
  for (const n of SUPPORTED_LANE_COUNTS) {
    const keys = n === DEFAULT_LANE_COUNT ? settings.keys : settings.keyMaps?.[n];
    if (keys === undefined) {
      keyMaps[n] = defaultKeys(n);
      continue;
    }
    if (!isValidKeySet(keys, n)) return false;
    keyMaps[n] = [...keys];
  }
  const clean = {
    keys: [...settings.keys],
    keyMaps,
    noteSpeed: normalizeSpeed(settings.noteSpeed),
    showVideo: settings.showVideo !== false,
    noFail: settings.noFail === true,
    offsetMs: Math.round(Number(settings.offsetMs) || 0),
    touchControls: settings.touchControls || 'auto',
  };
  const ok = writeJson(STORAGE_KEYS.settings, clean);
  if (ok) remove(STORAGE_KEYS.legacyKeys);
  return ok;
}

/** 일부만 바꿔 저장 (곡 선택 화면의 배속/영상 ON·OFF 등) */
export function updateSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  return saveSettings(next) ? loadSettings() : null;
}

export function resetSettings() {
  remove(STORAGE_KEYS.settings);
  remove(STORAGE_KEYS.legacyKeys);
  return loadSettings();
}

// 최고 기록: wony_rhythm_scores = { songId: { difficulty: { bestScore, bestGrade, bestAccuracy, bestMaxCombo, updatedAt } } }
// 이전 버전은 { songId: { difficulty: 12345 } } (숫자만) 이었다 → 읽을 때 변환하고, 다음 저장 때 새 형식으로 기록된다.
// 각 항목은 따로따로 최고값을 유지한다 (점수 최고 판과 정확도 최고 판이 달라도 됨). 기준은 songId + difficulty, 배속 무관.
// 기록 정책 (판정 함수는 engine.js):
//                  최고 기록   최근 기록   온라인 랭킹
//   정상 CLEAR        저장        저장        대상
//   GAME_OVER         X           저장        제외
//   NO FAIL 사용      X           저장        제외      (NO_FAIL_CLEAR 및 LIFE 가 남은 CLEAR 모두)
//   AUTO / PREVIEW    X           X           제외      (테스트/검증용이라 최근 기록도 오염시키지 않음)
const EMPTY_BEST = Object.freeze({ bestScore: 0, bestGrade: null, bestAccuracy: null, bestMaxCombo: null, updatedAt: null });

const num = v => (Number.isFinite(v) && v >= 0 ? v : null);

/** 저장된 값 하나(숫자/객체/깨진 값) → 최고 기록 객체. 쓸 수 없으면 null */
export function normalizeBestRecord(value) {
  if (Number.isFinite(value)) return value > 0 ? { ...EMPTY_BEST, bestScore: Math.round(value) } : null; // 이전 형식
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rec = {
    bestScore: Math.round(num(value.bestScore) ?? 0),
    bestGrade: gradeOrder(value.bestGrade) === Infinity ? null : value.bestGrade,
    bestAccuracy: num(value.bestAccuracy) === null ? null : Math.min(100, value.bestAccuracy),
    bestMaxCombo: num(value.bestMaxCombo) === null ? null : Math.round(value.bestMaxCombo),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
  };
  return rec.bestScore || rec.bestGrade || rec.bestAccuracy !== null || rec.bestMaxCombo !== null ? rec : null;
}

function loadScores() {
  const raw = readJson(STORAGE_KEYS.scores);
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [songId, byDiff] of Object.entries(raw)) {
    if (!byDiff || typeof byDiff !== 'object' || Array.isArray(byDiff)) continue;
    for (const d of DIFFICULTIES) {
      const rec = normalizeBestRecord(byDiff[d]);
      if (rec) (out[songId] ||= {})[d] = rec;
    }
  }
  return out;
}

/** 곡 + 난이도 최고 기록 (없으면 bestScore 0, 나머지 null) */
export function loadBestRecord(songId, difficulty) {
  return { ...(loadScores()[songId]?.[difficulty] || EMPTY_BEST) };
}

/** 최고 점수만 (이전 API 호환) */
export function loadBestScore(songId, difficulty) {
  return loadBestRecord(songId, difficulty).bestScore;
}

/** { songId: { difficulty: { bestScore, bestGrade, bestAccuracy, bestMaxCombo } } } */
export function loadAllBestRecords() {
  return loadScores();
}

/** { songId: { easy: 123, ... } } (이전 API 호환) */
export function loadAllBestScores() {
  const out = {};
  for (const [songId, byDiff] of Object.entries(loadScores())) {
    for (const [d, rec] of Object.entries(byDiff)) if (rec.bestScore > 0) (out[songId] ||= {})[d] = rec.bestScore;
  }
  return out;
}

/**
 * 결과 1건으로 최고 기록 갱신. 정상 클리어 판에서만, 항목별로 더 좋을 때만 바뀐다.
 * @param {{songId, difficulty, status, noFail, score, grade, accuracy, maxCombo}} result  engine.resultRecord 결과
 * @param {{autoplay?: boolean, preview?: boolean}} context
 * @returns {{previous, best, improved: {score, grade, accuracy, maxCombo}, isNewBest: boolean, saved: boolean,
 *            skipped: string|null}}  skipped = 갱신하지 않은 이유 (GAME_OVER / NO_FAIL_CLEAR / NO_FAIL / AUTOPLAY / PREVIEW)
 *   isNewBest = 점수 갱신 여부 (결과 화면 "최고 점수 갱신!")
 */
export function saveBestRecord(result, context = {}) {
  const { songId, difficulty } = result;
  const previous = loadBestRecord(songId, difficulty);
  const none = { score: false, grade: false, accuracy: false, maxCombo: false };
  const skipped = notNormalClearReason(result, context);
  if (skipped) return { previous, best: previous, improved: none, isNewBest: false, saved: false, skipped };
  const improved = {
    score: Number.isFinite(result.score) && result.score > previous.bestScore,
    grade: gradeOrder(result.grade) !== Infinity && isBetterGrade(result.grade, previous.bestGrade),
    accuracy: Number.isFinite(result.accuracy) && result.accuracy > (previous.bestAccuracy ?? -1),
    maxCombo: Number.isFinite(result.maxCombo) && result.maxCombo > (previous.bestMaxCombo ?? -1),
  };
  const fail = { previous, best: previous, improved: none, isNewBest: false, saved: false, skipped: null };
  if (!Object.values(improved).some(Boolean)) return { ...fail, saved: true };
  const best = {
    bestScore: improved.score ? Math.round(result.score) : previous.bestScore,
    bestGrade: improved.grade ? result.grade : previous.bestGrade,
    bestAccuracy: improved.accuracy ? result.accuracy : previous.bestAccuracy,
    bestMaxCombo: improved.maxCombo ? Math.round(result.maxCombo) : previous.bestMaxCombo,
    updatedAt: new Date().toISOString(),
  };
  const scores = loadScores(); // 이전 형식 값도 이 시점에 새 형식으로 다시 쓰인다
  scores[songId] = { ...(scores[songId] || {}), [difficulty]: best };
  if (!writeJson(STORAGE_KEYS.scores, scores)) return fail;
  return { previous, best, improved, isNewBest: improved.score, saved: true, skipped: null };
}

/**
 * 점수만으로 갱신 (이전 API 호환). 정상 클리어 판의 점수를 넘길 때만 쓴다 — 게임 화면은 saveBestRecord 를 쓴다.
 * @returns {{best: number, isNewBest: boolean, previous: number}}
 */
export function saveBestScore(songId, difficulty, score) {
  const r = saveBestRecord({ songId, difficulty, score, status: RESULT_STATUS.CLEAR, noFail: false });
  return { best: r.best.bestScore, isNewBest: r.isNewBest, previous: r.previous.bestScore };
}

export function clearBestScores() {
  remove(STORAGE_KEYS.scores);
  remove(STORAGE_KEYS.results);
}

/**
 * 최근 플레이 기록에 결과 1건 추가 (engine.resultRecord + playedAt). 최근 MAX_RESULTS 건만 보관.
 * { schema, status, songId, difficulty, noteSpeed, score, maxCombo, perfect, great, good, miss, totalNotes,
 *   accuracy, life, grade, cleared, gameOver, noFail, playedAt, ranking: { eligible, submitted } }
 * 실제 플레이(CLEAR / GAME_OVER / NO FAIL)는 남기고, 자동 플레이·미리보기는 저장하지 않는다
 * (engine.recentRecordSkipReason 을 여기서 직접 확인 → 다른 화면에서 호출해도 규칙이 새지 않음).
 * @param {{autoplay?: boolean, preview?: boolean}} context
 * @returns {{saved: boolean, skipped: null | 'AUTOPLAY' | 'PREVIEW' | 'INVALID'}}
 */
export function saveResult(result, context = {}) {
  const skipped = recentRecordSkipReason(result, context);
  if (skipped) return { saved: false, skipped };
  const list = loadResults();
  list.unshift(result);
  return { saved: writeJson(STORAGE_KEYS.results, list.slice(0, MAX_RESULTS)), skipped: null };
}

/** 이전 버전 결과(status 없음)는 gameOver/cleared/noFail 로 상태를 채운다 */
export function resultStatusOf(r) {
  if (Object.values(RESULT_STATUS).includes(r?.status)) return r.status;
  if (r?.gameOver) return RESULT_STATUS.GAME_OVER;
  if (r?.cleared === false && r?.noFail) return RESULT_STATUS.NO_FAIL_CLEAR;
  return RESULT_STATUS.CLEAR;
}

export function loadResults() {
  const list = readJson(STORAGE_KEYS.results);
  // 이전 빌드가 남긴 자동 플레이/미리보기 기록은 읽을 때 걸러낸다 (다음 저장 때 목록에서 사라짐)
  return Array.isArray(list)
    ? list.filter(r => recentRecordSkipReason(r) === null).map(r => ({ ...r, status: resultStatusOf(r) }))
    : [];
}

/** 마지막으로 고른 곡/난이도 (홈의 "게임 시작" 버튼용) */
export function loadLastSelection() {
  const last = readJson(STORAGE_KEYS.last);
  return last && typeof last.song === 'string' && DIFFICULTIES.includes(last.difficulty) ? last : null;
}

export function saveLastSelection(song, difficulty) {
  writeJson(STORAGE_KEYS.last, { song, difficulty });
}
