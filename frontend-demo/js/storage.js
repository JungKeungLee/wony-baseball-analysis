// 이 기기 저장(localStorage) 계층: 게임 설정만. 게임/화면 코드는 localStorage 를 직접 만지지 않고 이 함수들만 쓴다.
// 플레이 도중에는 호출하지 않는다 (설정은 시작 전에 한 번 읽음). 기록 · 츄르는 서버(js/ranking.js)만.
import {
  DEFAULT_LANE_COUNT, DEFAULT_SETTINGS, DIFFICULTIES, OFFSET_RANGE, SUPPORTED_LANE_COUNTS, normalizeLaneCount,
} from './config.js';
import { defaultKeys, isValidKeySet } from './keys.js';
import { normalizeSpeed } from './layout.js';

export const STORAGE_KEYS = Object.freeze({
  settings: 'wony_rhythm_settings',
  last: 'wony_rhythm_last',
  legacyKeys: 'wony_rhythm_keys', // 이전 버전: 키 설정을 따로 저장했었다
});

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
// 기록 · 츄르는 이 기기에 저장하지 않는다 (로그인 필수: 최고 기록 · 최근 플레이 · 랭킹 · 츄르 · 보유 스킨은 서버만).
// 이전 버전이 남긴 회원 데이터는 purgeMemberData 로 지운다. localStorage 에는 아래 MEMBER_FREE_KEYS 만 남는다.
//   wony_rhythm_settings : 키 · 노트 배속 · 영상 ON/OFF · NO FAIL · 판정 보정 · 터치 버튼
//   wony_rhythm_last     : 마지막으로 고른 곡 · 난이도 (홈의 "게임 시작" 버튼)
//   wonyRhythm.skins.v1  : 장착 스킨 선택 (화면 모양만. 보유 여부는 서버 기준)
export const LEGACY_MEMBER_KEYS = Object.freeze(['wony_rhythm_scores', 'wony_rhythm_results', 'wonyRhythm.wallet.v1']);
export const MEMBER_FREE_KEYS = Object.freeze([STORAGE_KEYS.settings, STORAGE_KEYS.last, 'wonyRhythm.skins.v1']);

/** 이전 버전의 로컬 최고 기록 · 최근 기록 · 비로그인 츄르를 지운다 (설정은 그대로) */
export function purgeMemberData() {
  for (const key of LEGACY_MEMBER_KEYS) remove(key);
}

/** 마지막으로 고른 곡/난이도 (홈의 "게임 시작" 버튼용) */
export function loadLastSelection() {
  const last = readJson(STORAGE_KEYS.last);
  return last && typeof last.song === 'string' && DIFFICULTIES.includes(last.difficulty) ? last : null;
}

export function saveLastSelection(song, difficulty) {
  writeJson(STORAGE_KEYS.last, { song, difficulty });
}
