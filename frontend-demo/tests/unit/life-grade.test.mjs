import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIFE, MAX_LIFE, RANK_GRADES, maxLifeFor } from '../../js/config.js';
import { lifeDelta, rankGrade } from '../../js/judge.js';
import {
  createGame, finishGame, hitLane, isFinished, resultRecord, startGame, updateGame,
} from '../../js/engine.js';
import { isRankingEligible, toRankingRow } from '../../js/ranking.js';

const chart = (n, gap = 500) => ({ notes: Array.from({ length: n }, (_, i) => ({ time: 1000 + i * gap, lane: i % 4 })) });

function playing(c, opts) {
  const s = createGame(c, opts);
  startGame(s);
  return s;
}

test('난이도별 최대 LIFE: EASY 10 · NORMAL 8 · HARD 5 · HELL 3 (config 한 곳)', () => {
  assert.deepEqual({ ...MAX_LIFE }, { easy: 10, normal: 8, hard: 5, hell: 3 });
  for (const [d, n] of Object.entries(MAX_LIFE)) {
    const s = createGame(chart(4), { difficulty: d });
    assert.equal(s.life, n, d);
    assert.equal(s.lifeMax, n, d);
    assert.equal(maxLifeFor(d), n);
  }
  assert.equal(maxLifeFor('unknown'), 8, '모르는 난이도는 NORMAL');
  assert.deepEqual({ ...LIFE.delta }, { PERFECT: 0, GREAT: 0, GOOD: 0, MISS: -1 });
  assert.deepEqual({ ...LIFE.comboHeal }, { every: 10, amount: 0.5 });
});

test('판정별 LIFE 변화: MISS 1개 = LIFE 1, 나머지 0', () => {
  for (const d of ['easy', 'normal', 'hard', 'hell']) {
    assert.equal(lifeDelta('MISS', d), -1, d);
    assert.equal(lifeDelta('GOOD', d), 0, d);
    assert.equal(lifeDelta('PERFECT', d), 0, d);
  }
  // 배수 구조는 유지 (감소에만 적용, 회복 값은 그대로)
  assert.equal(lifeDelta('MISS', 'easy', { delta: { MISS: -1 }, difficultyMultiplier: { easy: 0.5 } }), -0.5);
  assert.equal(lifeDelta('PERFECT', 'easy', { delta: { PERFECT: 1 }, difficultyMultiplier: { easy: 0.5 } }), 1);
});

test('게임 중 LIFE 반영: GOOD 은 그대로, MISS 마다 1', () => {
  const s = playing(chart(4), { difficulty: 'hard' });
  hitLane(s, 0, 1000);          // PERFECT
  hitLane(s, 1, 1500 + 130);    // GOOD
  assert.equal(s.life, 5);
  updateGame(s, 3000);          // 남은 2개 MISS
  assert.equal(s.life, 3);
});

for (const [d, n] of [['easy', 10], ['normal', 8], ['hard', 5], ['hell', 3]]) {
  test(`${d.toUpperCase()}: MISS ${n}번에 GAME OVER`, () => {
    const s = playing(chart(30), { difficulty: d });
    updateGame(s, 1000 + 500 * (n - 2) + 200);
    assert.equal(s.counts.MISS, n - 1);
    assert.equal(s.life, 1);
    assert.equal(s.status, 'playing');
    updateGame(s, 1000 + 500 * (n - 1) + 200);
    assert.equal(s.life, 0);
    assert.equal(s.status, 'failed');
    assert.equal(s.counts.MISS, n, '0 이 된 순간 멈춘다');
  });
}

test('LIFE 0 → GAME OVER: 입력/자동 MISS 중단, 결과 등급 F', () => {
  const s = playing(chart(30), { difficulty: 'hell' });
  hitLane(s, 0, 1000); // PERFECT 하나
  updateGame(s, 1000 + 500 * 12);
  assert.equal(s.life, 0);
  assert.equal(s.gameOver, true);
  assert.ok(isFinished(s));
  assert.equal(s.counts.MISS, 3);
  assert.equal(hitLane(s, 3, 1000 + 500 * 15), null);
  assert.equal(updateGame(s, 99999), 0);
  const r = resultRecord(s, { songId: 'x', difficulty: 'hell', noteSpeed: 1.5 });
  assert.equal(r.grade, 'F');
  assert.equal(r.gameOver, true);
  assert.equal(r.cleared, false);
  assert.equal(r.life, 0);
  assert.equal(r.lifeMax, 3);
  assert.equal(r.totalNotes, 30);
  assert.equal(r.accuracy, Math.round(100 / 30 * 100) / 100, '정확도는 전체 노트 대비 (못 친 노트 0)');
});

/** 앞의 miss 개를 놓친 뒤 hits 개를 정확히 친다 */
function missThenHit(difficulty, miss, hits) {
  const s = playing(chart(miss + hits + 5), { difficulty });
  if (miss) updateGame(s, 1000 + 500 * (miss - 1) + 200);
  for (let i = miss; i < miss + hits; i++) hitLane(s, i % 4, 1000 + i * 500);
  return s;
}

test('콤보 회복: 10콤보 +0.5, 20콤보 총 +1, 9콤보는 회복 없음', () => {
  const nine = missThenHit('hard', 2, 9);
  assert.equal(nine.life, 3);
  assert.equal(nine.healed, 0);
  const ten = missThenHit('hard', 2, 10);
  assert.equal(ten.life, 3.5);
  assert.deepEqual({ amount: ten.lastHeal.amount, combo: ten.lastHeal.combo }, { amount: 0.5, combo: 10 });
  const twenty = missThenHit('hard', 2, 20);
  assert.equal(twenty.life, 4);
  assert.equal(twenty.healed, 1);
  const thirty = missThenHit('hard', 2, 30);
  assert.equal(thirty.life, 4.5);
});

test('콤보 회복: 최대 LIFE 초과 없음 (가득 차 있으면 회복 0)', () => {
  const full = missThenHit('hell', 0, 40);
  assert.equal(full.life, 3);
  assert.equal(full.healed, 0);
  assert.equal(full.lastHeal, null);
  const almost = missThenHit('hell', 1, 40);   // 2 → 2.5 → 3 → (가득) → (가득)
  assert.equal(almost.life, 3);
  assert.equal(almost.healed, 1);
  assert.ok(almost.life <= almost.lifeMax);
});

test('콤보 회복: MISS 로 콤보가 끊기면 다시 0부터, 같은 10콤보 구간 중복 회복 없음', () => {
  const s = playing(chart(40), { difficulty: 'hard' });
  updateGame(s, 1000 + 200);                                   // MISS 1 → 4
  for (let i = 1; i <= 10; i++) hitLane(s, i % 4, 1000 + i * 500);  // 10콤보 → 4.5
  assert.equal(s.life, 4.5);
  for (let i = 11; i <= 15; i++) hitLane(s, i % 4, 1000 + i * 500); // 15콤보
  updateGame(s, 1000 + 16 * 500 + 200);                        // MISS → 3.5, 콤보 0
  assert.equal(s.combo, 0);
  assert.equal(s.healCombo, 0);
  for (let i = 17; i <= 25; i++) hitLane(s, i % 4, 1000 + i * 500); // 9콤보: 회복 없음
  assert.equal(s.life, 3.5, '이전 콤보(15)는 이어지지 않음');
  hitLane(s, 26 % 4, 1000 + 26 * 500);                         // 10콤보 → 4
  assert.equal(s.life, 4);
  assert.equal(s.healed, 1);
});

test('NO FAIL: LIFE 0 이어도 곡 끝까지, 클리어/랭킹 대상 아님', () => {
  const s = playing(chart(20), { difficulty: 'hard', noFail: true });
  updateGame(s, 1000 + 500 * 5);
  assert.equal(s.life, 0);
  assert.equal(s.gameOver, false);
  assert.equal(s.status, 'playing');
  assert.equal(s.lifeZeroAt, 1000 + 500 * 5, 'MISS 가 판정된 시각 (updateGame)');
  assert.equal(hitLane(s, 2, 1000 + 500 * 6).grade, 'PERFECT', '계속 플레이 가능');
  finishGame(s, 99999);
  assert.equal(s.status, 'ended');
  const r = resultRecord(s, { songId: 'x', difficulty: 'hard', noteSpeed: 1 });
  assert.equal(r.noFail, true);
  assert.equal(r.gameOver, false);
  assert.equal(r.cleared, false);
  assert.notEqual(r.grade, undefined);
  assert.equal(r.perfect + r.great + r.good + r.miss, r.totalNotes);
  assert.equal(isRankingEligible(r), false);
});

test('등급 기준 (config): S+ 98 / S 95 / A 90 / B 80 / C 70 / D 60 / F', () => {
  assert.deepEqual(RANK_GRADES.map(g => [g.grade, g.min]), [['S+', 98], ['S', 95], ['A', 90], ['B', 80], ['C', 70], ['D', 60], ['F', 0]]);
  const cases = [[100, 'S+'], [98, 'S+'], [97.99, 'S'], [95, 'S'], [94.99, 'A'], [90, 'A'], [89.99, 'B'], [80, 'B'],
    [79.99, 'C'], [70, 'C'], [69.99, 'D'], [60, 'D'], [59.99, 'F'], [0, 'F'], [NaN, 'F']];
  for (const [acc, grade] of cases) assert.equal(rankGrade(acc), grade, `${acc}%`);
  assert.equal(rankGrade(100, { gameOver: true }), 'F');
});

test('결과 기록: 결과 화면/랭킹에 필요한 필드', () => {
  const s = playing(chart(4), { difficulty: 'normal' });
  hitLane(s, 0, 1000);
  hitLane(s, 1, 1590);
  hitLane(s, 2, 2000);
  hitLane(s, 3, 2500);
  updateGame(s, s.endTime);
  assert.equal(s.status, 'ended');
  const r = resultRecord(s, { songId: 'wony-cover-01', difficulty: 'normal', noteSpeed: 1.75 });
  assert.deepEqual(Object.keys(r).sort(), ['accuracy', 'cleared', 'difficulty', 'gameOver', 'good', 'grade', 'great', 'life',
    'laneCount', 'lifeMax', 'maxCombo', 'miss', 'noFail', 'noteSpeed', 'perfect', 'playId', 'schema', 'score', 'songId', 'status', 'totalNotes'].sort());
  assert.equal(r.status, 'CLEAR');
  assert.equal(r.accuracy, 95);
  assert.equal(r.grade, 'S');
  assert.equal(r.life, 8);
  assert.equal(r.lifeMax, 8);
  assert.equal(r.cleared, true);
  assert.equal(isRankingEligible(r), true);
  assert.equal(isRankingEligible(r, { autoplay: true }), false);
  assert.equal(isRankingEligible(r, { preview: true }), false);
  const row = toRankingRow({ ...r, playedAt: '2026-10-14T00:00:00Z' });
  assert.equal(row.song_id, 'wony-cover-01');
  assert.equal(row.note_speed, 1.75);
  assert.equal(row.grade, 'S');
});

