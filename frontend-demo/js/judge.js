// 판정/점수/정확도 순수 함수. 상수는 config.js 에 있다.
import { ACCURACY_WEIGHTS, COMBO_BONUS, GAME_OVER_GRADE, JUDGE_WINDOWS, LIFE, RANK_GRADES, SCORE_POINTS } from './config.js';

/**
 * 입력 시각 - 노트 시각 (ms) → 등급. 음수는 이르게, 양수는 늦게 누른 것.
 * 판정할 노트가 아니면(너무 이른 입력) null.
 */
export function gradeFor(deltaMs, windows = JUDGE_WINDOWS) {
  if (!Number.isFinite(deltaMs)) return null;
  const abs = Math.abs(deltaMs);
  if (abs <= windows.PERFECT) return 'PERFECT';
  if (abs <= windows.GREAT) return 'GREAT';
  if (abs <= windows.GOOD) return 'GOOD';
  if (deltaMs < 0 && abs > windows.EARLY_MISS) return null;
  return 'MISS';
}

/** 이 노트로 얻는 점수. combo 는 이 판정을 반영한 뒤의 콤보. */
export function pointsFor(grade, combo, points = SCORE_POINTS, bonus = COMBO_BONUS) {
  const base = points[grade] ?? 0;
  if (!base) return 0;
  return base + Math.min(bonus.max, Math.floor(Math.max(0, combo) / bonus.every) * bonus.points);
}

/** 전체 노트 대비 정확도 (0~100, 소수 둘째 자리). 노트가 없으면 0. */
export function accuracy(counts, totalNotes, weights = ACCURACY_WEIGHTS) {
  if (!Number.isFinite(totalNotes) || totalNotes <= 0) return 0;
  let sum = 0;
  for (const [grade, w] of Object.entries(weights)) sum += (Number(counts?.[grade]) || 0) * w;
  const pct = sum / totalNotes;
  return Number.isFinite(pct) ? Math.round(Math.min(100, Math.max(0, pct)) * 100) / 100 : 0;
}

/** 판정 1번의 LIFE 변화량. 감소분에만 난이도 배수 적용 (EASY 0.5 등). */
export function lifeDelta(grade, difficulty, life = LIFE) {
  const base = life.delta[grade] ?? 0;
  if (base >= 0) return base;
  const mult = life.difficultyMultiplier[difficulty] ?? 1;
  return base * (Number.isFinite(mult) ? mult : 1);
}

/** 정확도(%) → 결과 등급. GAME OVER(NO FAIL 아님)는 F. */
export function rankGrade(accuracyPct, { gameOver = false } = {}, table = RANK_GRADES) {
  if (gameOver) return GAME_OVER_GRADE;
  const acc = Number.isFinite(accuracyPct) ? accuracyPct : 0;
  return (table.find(g => acc >= g.min) || table[table.length - 1]).grade;
}

/** 등급 순위 (작을수록 좋음). 모르는 등급/null 은 가장 나쁨. */
export function gradeOrder(grade, table = RANK_GRADES) {
  const i = table.findIndex(g => g.grade === grade);
  return i === -1 ? Infinity : i;
}

/** a 가 b 보다 좋은 등급인지 */
export function isBetterGrade(a, b, table = RANK_GRADES) {
  return gradeOrder(a, table) < gradeOrder(b, table);
}
