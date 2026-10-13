import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chartStats, formatMs } from '../../js/chart-stats.js';

const n = (time, lane) => ({ time, lane });

test('총 노트 / 동시치기 / 첫·마지막 노트', () => {
  const s = chartStats({ notes: [n(7500, 0), n(8000, 1), n(8000, 3), n(8500, 2), n(9000, 0), n(9000, 1), n(9000, 3)] });
  assert.equal(s.notes, 7);
  assert.equal(s.hits, 4);
  assert.equal(s.chords, 2);
  assert.equal(s.chordNotes, 5);
  assert.equal(s.triples, 1);
  assert.equal(s.firstMs, 7500);
  assert.equal(s.lastMs, 9000);
});

test('가장 짧은 간격: 같은 시각(동시치기)은 간격 0 으로 치지 않음', () => {
  const s = chartStats({ notes: [n(1000, 0), n(1000, 3), n(1250, 1), n(1330, 2), n(2000, 0)] });
  assert.equal(s.minGapMs, 80);
  assert.equal(s.minGapAt, 1250);
});

test('초당 최대 노트: 노트 수와 입력 시점 수(동시치기 = 1)를 따로', () => {
  // 1000~1999ms 에 입력 5번, 그중 2번은 2키 동시 → 노트 7개
  const notes = [n(1000, 0), n(1000, 3), n(1200, 1), n(1400, 2), n(1600, 0), n(1600, 1), n(1999, 3), n(2000, 0)];
  const s = chartStats({ notes });
  assert.equal(s.maxNpsHits, 5, '2000ms 는 [1000, 2000) 구간 밖');
  assert.equal(s.maxNps, 7);
  assert.equal(s.maxNpsAt, 1000);
});

test('빈 채보/잘못된 값도 오류 없음', () => {
  for (const chart of [null, {}, { notes: [] }, { notes: [{ lane: 1 }, null] }]) {
    const s = chartStats(chart);
    assert.deepEqual([s.notes, s.chords, s.minGapMs, s.maxNps, s.firstMs, s.lastMs], [0, 0, null, 0, null, null]);
  }
  const one = chartStats({ notes: [n(500, 0)] });
  assert.deepEqual([one.minGapMs, one.maxNps, one.maxNpsHits], [null, 1, 1]);
});

test('시각 표시', () => {
  assert.equal(formatMs(7500), '0:07.500');
  assert.equal(formatMs(83045), '1:23.045');
  assert.equal(formatMs(-2000), '-0:02.000');
  assert.equal(formatMs(NaN), '-');
});
