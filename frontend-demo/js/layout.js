// 화면 크기 → 그리기 좌표. 게임 상태를 전혀 모른다 (회전/리사이즈 때 이것만 다시 계산).
import { BASE_APPROACH_MS, DEFAULT_LANE_COUNT, NOTE_SPEEDS } from './config.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// 레인 1개 기준 폭 (4키일 때 기존 값과 같다: 세로 최대 520, 가로 최대 760 / 최소 420)
const LANE_MAX_W_PORTRAIT = 130;
const LANE_MAX_W_LANDSCAPE = 190;
const LANE_MIN_W_LANDSCAPE = 105;

export function computeLayout(width, height, dpr = 1, laneCount = DEFAULT_LANE_COUNT) {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const landscape = w > h;
  // 세로: 폭을 거의 다 쓰고, 가로: 레인 간격을 넓혀 더 넓게 쓴다. 레인이 많으면 최대 폭도 비례해 넓어진다.
  const fieldW = landscape
    ? Math.max(1, Math.min(w - 16, LANE_MAX_W_LANDSCAPE * laneCount, Math.max(w * 0.62, LANE_MIN_W_LANDSCAPE * laneCount)))
    : Math.max(1, Math.min(w - 16, LANE_MAX_W_PORTRAIT * laneCount));
  const fieldX = Math.round((w - fieldW) / 2);
  const laneW = fieldW / laneCount;
  const judgeY = Math.round(h - clamp(h * 0.14, 32, 110));
  return {
    width: w,
    height: h,
    dpr: clamp(dpr || 1, 1, 2), // 3x 기기도 2x로 그려 GPU/메모리 부담을 줄인다
    landscape,
    laneCount,
    fieldX,
    fieldW,
    laneW,
    laneX: Array.from({ length: laneCount }, (_, i) => fieldX + i * laneW),
    judgeY,
    noteH: Math.round(clamp(h * 0.028, 10, 24)),
    notePad: Math.max(3, Math.round(laneW * 0.08)),
  };
}

/** 허용된 배속(0.75~2.0) 중 가장 가까운 값 */
export function normalizeSpeed(speed) {
  const s = Number(speed);
  if (!Number.isFinite(s)) return 1;
  return NOTE_SPEEDS.reduce((best, v) => (Math.abs(v - s) < Math.abs(best - s) ? v : best), NOTE_SPEEDS[0]);
}

/** 배속 → 노트 접근 시간(ms). 1.0x = 2000ms, 2.0x = 1000ms, 0.75x ≈ 2667ms */
export function approachMs(speed) {
  return BASE_APPROACH_MS / normalizeSpeed(speed);
}

/** 노트의 화면 y (노트 아랫면). video 시각 하나만으로 계산하므로 판정 시각과 기준이 같다. */
export function noteY(noteTime, songTime, layout, approach) {
  return layout.judgeY - ((noteTime - songTime) / approach) * layout.judgeY;
}
