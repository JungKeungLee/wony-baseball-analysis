import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JUDGE_WINDOWS } from '../../js/config.js';
import { accuracy, gradeFor, pointsFor } from '../../js/judge.js';
import {
  createGame, finishGame, hitLane, pauseGame, resultOf, resumeGame, startGame, updateGame,
} from '../../js/engine.js';
import { simpleChart } from './helpers.mjs';

function playing(chart = simpleChart()) {
  const s = createGame(chart);
  startGame(s);
  return s;
}

test('판정 경계값 (상수 한 곳에서 관리)', () => {
  assert.deepEqual(
    { P: JUDGE_WINDOWS.PERFECT, G: JUDGE_WINDOWS.GREAT, D: JUDGE_WINDOWS.GOOD },
    { P: 70, G: 120, D: 180 },
  );
  const cases = [
    [0, 'PERFECT'], [70, 'PERFECT'], [-70, 'PERFECT'], [71, 'GREAT'], [-71, 'GREAT'],
    [120, 'GREAT'], [121, 'GOOD'], [-121, 'GOOD'], [180, 'GOOD'], [-180, 'GOOD'],
    [181, 'MISS'], [-181, 'MISS'], [-250, 'MISS'], [-251, null], [NaN, null],
  ];
  for (const [delta, grade] of cases) assert.equal(gradeFor(delta), grade, `delta ${delta}`);
});

test('hitLane: 경계값에서 실제 노트 판정', () => {
  for (const [delta, grade] of [[70, 'PERFECT'], [-120, 'GREAT'], [180, 'GOOD'], [-200, 'MISS']]) {
    const s = playing({ notes: [{ time: 1000, lane: 2 }] });
    assert.equal(hitLane(s, 2, 1000 + delta).grade, grade);
    assert.equal(s.judged, 1);
  }
});

test('너무 이른 입력은 무시하고 노트를 소모하지 않는다', () => {
  const s = playing({ notes: [{ time: 1000, lane: 0 }] });
  assert.equal(hitLane(s, 0, 700), null);
  assert.equal(s.judged, 0);
  assert.equal(hitLane(s, 0, 1000).grade, 'PERFECT');
});

test('다른 레인 입력은 그 레인 노트만 판정', () => {
  const s = playing({ notes: [{ time: 1000, lane: 0 }] });
  assert.equal(hitLane(s, 1, 1000), null);
  assert.equal(s.judged, 0);
});

test('GOOD 창이 지나면 자동 MISS, 늦게 친 입력은 지난 노트를 정리하고 다음 노트 판정', () => {
  const s = playing({ notes: [{ time: 1000, lane: 0 }, { time: 1400, lane: 0 }] });
  assert.equal(updateGame(s, 1180), 0);
  assert.equal(updateGame(s, 1181), 1);
  assert.equal(s.counts.MISS, 1);
  // 프레임이 늦어 updateGame 전에 입력이 들어와도 같은 결과
  const s2 = playing({ notes: [{ time: 1000, lane: 0 }, { time: 1400, lane: 0 }] });
  assert.equal(hitLane(s2, 0, 1390).grade, 'PERFECT');
  assert.deepEqual(s2.counts, { PERFECT: 1, GREAT: 0, GOOD: 0, MISS: 1 });
});

test('같은 시각 두 레인(동시 입력) 모두 판정', () => {
  const s = playing({ notes: [{ time: 1000, lane: 0 }, { time: 1000, lane: 3 }] });
  assert.equal(hitLane(s, 0, 1005).grade, 'PERFECT');
  assert.equal(hitLane(s, 3, 1010).grade, 'PERFECT');
  assert.equal(s.combo, 2);
});

test('콤보와 최대 콤보', () => {
  const s = playing(simpleChart(6));
  hitLane(s, 0, 1000);
  hitLane(s, 1, 1500);
  hitLane(s, 2, 2000);
  assert.equal(s.combo, 3);
  updateGame(s, 2700); // lane 3 노트 MISS
  assert.equal(s.combo, 0);
  assert.equal(s.maxCombo, 3);
  hitLane(s, 0, 3000);
  assert.equal(s.combo, 1);
  assert.equal(s.maxCombo, 3);
});

test('점수: 등급 점수 + 단순 콤보 보너스', () => {
  assert.equal(pointsFor('PERFECT', 1), 1000);
  assert.equal(pointsFor('GREAT', 9), 700);
  assert.equal(pointsFor('GOOD', 10), 410);
  assert.equal(pointsFor('PERFECT', 250), 1100); // 보너스 상한 100
  assert.equal(pointsFor('MISS', 50), 0);
  const s = playing({ notes: [{ time: 1000, lane: 0 }, { time: 1500, lane: 1 }, { time: 2000, lane: 2 }] });
  hitLane(s, 0, 1000);   // PERFECT 1000
  hitLane(s, 1, 1600);   // GREAT 700
  hitLane(s, 2, 2150);   // GOOD 400
  assert.equal(s.score, 2100);
});

test('정확도 = 가중치 합 / 전체 노트, NaN/Infinity 없음', () => {
  assert.equal(accuracy({ PERFECT: 2, GREAT: 1, GOOD: 1, MISS: 0 }, 4), 82.5);
  assert.equal(accuracy({ PERFECT: 3 }, 3), 100);
  assert.equal(accuracy({}, 0), 0);
  assert.equal(accuracy({ PERFECT: 1 }, NaN), 0);
  assert.equal(accuracy(undefined, 10), 0);
  assert.equal(accuracy({ PERFECT: 1, GREAT: 0, GOOD: 0, MISS: 2 }, 3), 33.33);
  const empty = createGame({ notes: [] });
  assert.equal(resultOf(empty).accuracy, 0);
});

test('일시정지 중에는 판정/자동 MISS 없음, 재개 후 그대로 이어짐', () => {
  const s = playing(simpleChart(4));
  hitLane(s, 0, 1000);
  pauseGame(s);
  const before = JSON.stringify(s);
  assert.equal(hitLane(s, 1, 1500), null);
  assert.equal(updateGame(s, 99999), 0);
  assert.equal(JSON.stringify(s), before);
  resumeGame(s);
  assert.equal(hitLane(s, 1, 1500).grade, 'PERFECT');
  assert.equal(s.combo, 2);
});

test('준비/종료 상태에서는 입력 무시', () => {
  const s = createGame(simpleChart(2));
  assert.equal(hitLane(s, 0, 1000), null);
  startGame(s);
  finishGame(s, 5000);
  assert.equal(s.status, 'ended');
  assert.equal(s.counts.MISS, 2);
  assert.equal(hitLane(s, 0, 1000), null);
});

test('모든 노트 판정 + 마지막 노트 이후 대기 시간이 지나면 종료', () => {
  const s = playing({ notes: [{ time: 1000, lane: 0 }] });
  hitLane(s, 0, 1000);
  updateGame(s, 2000);
  assert.equal(s.status, 'playing');
  updateGame(s, s.endTime);
  assert.equal(s.status, 'ended');
  assert.deepEqual(resultOf(s), { score: 1000, maxCombo: 1, counts: { PERFECT: 1, GREAT: 0, GOOD: 0, MISS: 0 }, total: 1, accuracy: 100, life: 8, lifeMax: 8, gameOver: false, grade: 'S+' });
});

test('잘못된 노트(레인 범위 밖 등)는 무시하고 시간순 정렬', () => {
  const s = createGame({ notes: [{ time: 2000, lane: 1 }, { time: 1000, lane: 9 }, { time: 500, lane: 0 }, { time: 'x', lane: 0 }] });
  assert.equal(s.total, 2);
  assert.deepEqual(s.notes.map(n => n.time), [500, 2000]);
});
