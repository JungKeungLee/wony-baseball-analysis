import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIFE, RANK_GRADES } from '../../js/config.js';
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

test('LIFE 기본값/변화량은 config 한 곳', () => {
  assert.equal(LIFE.start, 100);
  assert.deepEqual({ ...LIFE.delta }, { PERFECT: 0, GREAT: 0, GOOD: -2, MISS: -10 });
  assert.deepEqual({ ...LIFE.difficultyMultiplier }, { easy: 0.5, normal: 1, hard: 1, hell: 1 });
});

test('판정별 LIFE 변화: PERFECT/GREAT 0, GOOD -2, MISS -10, EASY 는 절반', () => {
  assert.equal(lifeDelta('PERFECT', 'hard'), 0);
  assert.equal(lifeDelta('GREAT', 'hard'), 0);
  assert.equal(lifeDelta('GOOD', 'hard'), -2);
  assert.equal(lifeDelta('MISS', 'hell'), -10);
  assert.equal(lifeDelta('MISS', 'easy'), -5);
  assert.equal(lifeDelta('GOOD', 'easy'), -1);
  assert.equal(lifeDelta('MISS', 'unknown'), -10);
  // 회복 값이 생겨도(양수) 배수로 줄이지 않는다
  assert.equal(lifeDelta('PERFECT', 'easy', { delta: { PERFECT: 1 }, difficultyMultiplier: { easy: 0.5 } }), 1);
});

test('게임 중 LIFE 반영, 0~100 범위', () => {
  const s = playing(chart(4), { difficulty: 'hard' });
  hitLane(s, 0, 1000);          // PERFECT
  hitLane(s, 1, 1500 + 130);    // GOOD
  assert.equal(s.life, 98);
  updateGame(s, 3000);          // 남은 2개 MISS
  assert.equal(s.life, 78);
});

test('LIFE 0 → GAME OVER: 입력/자동 MISS 중단, 결과 등급 F', () => {
  const s = playing(chart(30), { difficulty: 'hell' });
  hitLane(s, 0, 1000); // PERFECT 하나
  updateGame(s, 1000 + 500 * 12); // MISS 가 쌓여 10번째에서 0
  assert.equal(s.life, 0);
  assert.equal(s.gameOver, true);
  assert.equal(s.status, 'failed');
  assert.ok(isFinished(s));
  assert.equal(s.counts.MISS, 10, '0 이 된 순간 멈춘다');
  assert.equal(hitLane(s, 3, 1000 + 500 * 15), null);
  assert.equal(updateGame(s, 99999), 0);
  const r = resultRecord(s, { songId: 'x', difficulty: 'hell', noteSpeed: 1.5 });
  assert.equal(r.grade, 'F');
  assert.equal(r.gameOver, true);
  assert.equal(r.cleared, false);
  assert.equal(r.life, 0);
  assert.equal(r.totalNotes, 30);
  assert.equal(r.accuracy, Math.round(100 / 30 * 100) / 100, '정확도는 전체 노트 대비 (못 친 노트 0)');
});

test('EASY 는 MISS 20번에 GAME OVER (배수 0.5)', () => {
  const s = playing(chart(40), { difficulty: 'easy' });
  updateGame(s, 1000 + 500 * 18 + 200);
  assert.equal(s.counts.MISS, 19);
  assert.equal(s.status, 'playing');
  updateGame(s, 1000 + 500 * 19 + 200);
  assert.equal(s.status, 'failed');
});

test('NO FAIL: LIFE 0 이어도 곡 끝까지, 클리어/랭킹 대상 아님', () => {
  const s = playing(chart(20), { difficulty: 'hard', noFail: true });
  updateGame(s, 1000 + 500 * 12);
  assert.equal(s.life, 0);
  assert.equal(s.gameOver, false);
  assert.equal(s.status, 'playing');
  assert.equal(s.lifeZeroAt, 1000 + 500 * 12);
  assert.equal(hitLane(s, 1, 1000 + 500 * 13).grade, 'PERFECT', '계속 플레이 가능');
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
    'laneCount', 'maxCombo', 'miss', 'noFail', 'noteSpeed', 'perfect', 'playId', 'schema', 'score', 'songId', 'status', 'totalNotes'].sort());
  assert.equal(r.status, 'CLEAR');
  assert.equal(r.accuracy, 95);
  assert.equal(r.grade, 'S');
  assert.equal(r.life, 100);
  assert.equal(r.cleared, true);
  assert.equal(isRankingEligible(r), true);
  assert.equal(isRankingEligible(r, { autoplay: true }), false);
  assert.equal(isRankingEligible(r, { preview: true }), false);
  const row = toRankingRow({ ...r, playedAt: '2026-10-14T00:00:00Z' });
  assert.equal(row.song_id, 'wony-cover-01');
  assert.equal(row.note_speed, 1.75);
  assert.equal(row.grade, 'S');
});

