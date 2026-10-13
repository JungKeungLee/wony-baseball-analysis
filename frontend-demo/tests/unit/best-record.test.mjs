import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { RESULT_STATUS } from '../../js/config.js';
import { createGame, finishGame, hitLane, resultRecord, resultStatus, startGame, updateGame } from '../../js/engine.js';
import { gradeOrder, isBetterGrade } from '../../js/judge.js';
import { isRankingEligible } from '../../js/ranking.js';
import {
  STORAGE_KEYS, loadAllBestRecords, loadAllBestScores, loadBestRecord, loadBestScore, loadResults,
  normalizeBestRecord, saveBestRecord, saveBestScore, setStorageBackend,
} from '../../js/storage.js';
import { MemoryStorage } from './helpers.mjs';

let store;
beforeEach(() => {
  store = new MemoryStorage();
  setStorageBackend(store);
});

// 정상 클리어 판 (status CLEAR + NO FAIL 미사용)
const result = (over = {}) => ({ songId: 'wony-cover-01', difficulty: 'hard', status: 'CLEAR', noFail: false, score: 100000, grade: 'A', accuracy: 91.5, maxCombo: 120, ...over });
const raw = () => JSON.parse(store.getItem(STORAGE_KEYS.scores));

test('최고 기록: bestScore / bestGrade / bestAccuracy / bestMaxCombo 저장', () => {
  const r = saveBestRecord(result());
  assert.equal(r.saved, true);
  assert.equal(r.isNewBest, true);
  assert.deepEqual(r.improved, { score: true, grade: true, accuracy: true, maxCombo: true });
  const best = loadBestRecord('wony-cover-01', 'hard');
  assert.deepEqual([best.bestScore, best.bestGrade, best.bestAccuracy, best.bestMaxCombo], [100000, 'A', 91.5, 120]);
  assert.equal(typeof best.updatedAt, 'string');
  assert.deepEqual(Object.keys(raw()['wony-cover-01'].hard).sort(), ['bestAccuracy', 'bestGrade', 'bestMaxCombo', 'bestScore', 'updatedAt']);
});

test('최고 등급: 더 좋은 등급일 때만 바뀐다 (S+ > S > A > … > F)', () => {
  assert.ok(isBetterGrade('S+', 'S') && isBetterGrade('A', 'B') && isBetterGrade('D', 'F') && isBetterGrade('F', null));
  assert.ok(!isBetterGrade('B', 'A') && !isBetterGrade('A', 'A') && !isBetterGrade('Z', 'F'));
  assert.equal(gradeOrder('없음'), Infinity);
  saveBestRecord(result({ grade: 'S' }));
  saveBestRecord(result({ grade: 'B' }));
  assert.equal(loadBestRecord('wony-cover-01', 'hard').bestGrade, 'S');
  saveBestRecord(result({ grade: 'S+' }));
  assert.equal(loadBestRecord('wony-cover-01', 'hard').bestGrade, 'S+');
  saveBestRecord(result({ grade: 'F' })); // 더 나쁜 등급은 덮지 않음
  assert.equal(loadBestRecord('wony-cover-01', 'hard').bestGrade, 'S+');
});

test('최고 정확도 / 최고 콤보는 점수와 따로 갱신', () => {
  saveBestRecord(result({ score: 200000, accuracy: 90, maxCombo: 100 }));
  const r = saveBestRecord(result({ score: 150000, accuracy: 96.25, maxCombo: 80, grade: 'C' }));
  assert.deepEqual(r.improved, { score: false, grade: false, accuracy: true, maxCombo: false });
  assert.equal(r.isNewBest, false, '"최고 점수 갱신" 은 점수 기준');
  const r2 = saveBestRecord(result({ score: 10, accuracy: 10, maxCombo: 300, grade: 'F' }));
  assert.deepEqual(r2.improved, { score: false, grade: false, accuracy: false, maxCombo: true });
  const best = loadBestRecord('wony-cover-01', 'hard');
  assert.deepEqual([best.bestScore, best.bestGrade, best.bestAccuracy, best.bestMaxCombo], [200000, 'A', 96.25, 300]);
  // 아무것도 안 좋아지면 저장소를 건드리지 않음
  const before = store.getItem(STORAGE_KEYS.scores);
  assert.deepEqual(saveBestRecord(result({ score: 1, accuracy: 1, maxCombo: 1, grade: 'F' })).improved,
    { score: false, grade: false, accuracy: false, maxCombo: false });
  assert.equal(store.getItem(STORAGE_KEYS.scores), before);
});

test('곡 + 난이도별로 따로 (배속 무관)', () => {
  saveBestRecord(result({ difficulty: 'easy', noteSpeed: 0.75, score: 5 }));
  saveBestRecord(result({ difficulty: 'hell', noteSpeed: 2, score: 9 }));
  saveBestRecord(result({ songId: 'other', difficulty: 'easy', score: 7 }));
  assert.deepEqual(loadAllBestScores(), { 'wony-cover-01': { easy: 5, hell: 9 }, other: { easy: 7 } });
});

test('기존 localStorage (점수 숫자만) 호환 + 다음 저장 때 새 형식으로', () => {
  store.setItem(STORAGE_KEYS.scores, JSON.stringify({
    'demo-beat': { easy: 12345, normal: 0, hard: 'x', hell: -5 },
    'wony-cover-01': { normal: 102000 },
    broken: 'not-an-object',
  }));
  assert.deepEqual(loadBestRecord('demo-beat', 'easy'),
    { bestScore: 12345, bestGrade: null, bestAccuracy: null, bestMaxCombo: null, updatedAt: null });
  assert.equal(loadBestScore('demo-beat', 'normal'), 0);
  assert.equal(loadBestScore('demo-beat', 'hard'), 0);
  assert.equal(loadBestScore('broken', 'easy'), 0);
  assert.deepEqual(loadAllBestScores(), { 'demo-beat': { easy: 12345 }, 'wony-cover-01': { normal: 102000 } });

  // 이전 최고 점수보다 낮아도 등급/정확도/콤보는 처음 기록되고, 점수는 그대로
  const r = saveBestRecord({ songId: 'demo-beat', difficulty: 'easy', status: 'CLEAR', noFail: false, score: 9000, grade: 'B', accuracy: 85, maxCombo: 40 });
  assert.deepEqual(r.improved, { score: false, grade: true, accuracy: true, maxCombo: true });
  const after = raw();
  assert.equal(after['demo-beat'].easy.bestScore, 12345);
  assert.equal(after['demo-beat'].easy.bestGrade, 'B');
  assert.deepEqual(after['wony-cover-01'].normal, { bestScore: 102000, bestGrade: null, bestAccuracy: null, bestMaxCombo: null, updatedAt: null },
    '다른 곡의 이전 기록도 보존 (새 형식으로)');
  assert.equal(after.broken, undefined, '깨진 값은 버림');
});

test('저장값이 아예 깨져 있어도 오류 없음', () => {
  for (const bad of ['[1,2,3]', '"text"', '{not json', 'null', '{"x": [1]}']) {
    store.setItem(STORAGE_KEYS.scores, bad);
    assert.deepEqual(loadAllBestRecords(), {});
    assert.equal(loadBestScore('x', 'easy'), 0);
  }
  assert.equal(saveBestRecord(result()).saved, true);
  assert.equal(normalizeBestRecord({ bestScore: 'x', bestGrade: 'Z' }), null);
  assert.equal(normalizeBestRecord({ bestScore: 10, bestAccuracy: 250 }).bestAccuracy, 100);
});

test('이전 API(saveBestScore) 도 그대로 동작', () => {
  assert.deepEqual(saveBestScore('s', 'easy', 500), { best: 500, isNewBest: true, previous: 0 });
  assert.deepEqual(saveBestScore('s', 'easy', 400), { best: 500, isNewBest: false, previous: 500 });
  assert.equal(loadBestRecord('s', 'easy').bestGrade, null);
});

// ---------- 결과 상태 ----------
const chart = n => ({ notes: Array.from({ length: n }, (_, i) => ({ time: 1000 + i * 500, lane: i % 4 })) });

function play(n, opts, fn) {
  const s = createGame(chart(n), opts);
  startGame(s);
  fn(s);
  return resultRecord(s, { songId: 'x', difficulty: opts.difficulty, noteSpeed: 1 });
}

test('CLEAR / GAME_OVER / NO_FAIL_CLEAR 상태 구분 (등급과 별개)', () => {
  const clear = play(4, { difficulty: 'hard' }, s => {
    for (let i = 0; i < 4; i++) hitLane(s, i % 4, 1000 + i * 500);
    updateGame(s, s.endTime);
  });
  assert.equal(clear.status, RESULT_STATUS.CLEAR);
  assert.equal(clear.grade, 'S+');

  const lowClear = play(10, { difficulty: 'hard' }, s => finishGame(s, 99999)); // MISS 10 번째에 0 → GAME OVER
  assert.equal(lowClear.status, RESULT_STATUS.GAME_OVER);

  const missy = play(10, { difficulty: 'easy' }, s => finishGame(s, 99999)); // EASY: MISS 10번 = LIFE 50
  assert.equal(missy.status, RESULT_STATUS.CLEAR, '등급이 F 여도 LIFE 가 남으면 CLEAR');
  assert.equal(missy.grade, 'F');

  const gameOver = play(30, { difficulty: 'hell' }, s => updateGame(s, 99999));
  assert.equal(gameOver.status, RESULT_STATUS.GAME_OVER);
  assert.equal(gameOver.grade, 'F');

  const noFail = play(30, { difficulty: 'hell', noFail: true }, s => { updateGame(s, 99999); });
  assert.equal(noFail.status, RESULT_STATUS.NO_FAIL_CLEAR);
  assert.equal(noFail.noFail, true);

  const noFailSafe = play(4, { difficulty: 'hard', noFail: true }, s => {
    for (let i = 0; i < 4; i++) hitLane(s, i % 4, 1000 + i * 500);
    updateGame(s, s.endTime);
  });
  assert.equal(noFailSafe.status, RESULT_STATUS.CLEAR, 'NO FAIL 을 켰어도 LIFE 가 남았으면 CLEAR');

  // 이전 필드는 status 에서 파생
  for (const r of [clear, gameOver, noFail, noFailSafe]) {
    assert.equal(r.cleared, r.status === RESULT_STATUS.CLEAR);
    assert.equal(r.gameOver, r.status === RESULT_STATUS.GAME_OVER);
    assert.equal(r.schema, 3);
  }

  // 랭킹: CLEAR + NO FAIL 아님 + 자동 플레이/미리보기 아님
  assert.equal(isRankingEligible(clear), true);
  assert.equal(isRankingEligible(missy), true);
  assert.equal(isRankingEligible(gameOver), false);
  assert.equal(isRankingEligible(noFail), false);
  assert.equal(isRankingEligible(noFailSafe), false, 'NO FAIL 을 켠 판은 CLEAR 여도 제외');
  assert.equal(isRankingEligible(clear, { autoplay: true }), false);
  assert.equal(isRankingEligible(clear, { preview: true }), false);
});

test('resultStatus 는 게임 상태에서 바로 계산', () => {
  const s = createGame(chart(2), { difficulty: 'normal' });
  startGame(s);
  assert.equal(resultStatus(s), RESULT_STATUS.CLEAR);
});

test('이전 버전 결과 기록(status 없음)도 상태를 채워 읽는다', () => {
  store.setItem(STORAGE_KEYS.results, JSON.stringify([
    { songId: 'a', score: 1, gameOver: true, cleared: false, noFail: false },
    { songId: 'b', score: 2, gameOver: false, cleared: false, noFail: true },
    { songId: 'c', score: 3, gameOver: false, cleared: true, noFail: false },
    { songId: 'd', score: 4, accuracy: 90 }, // schema 1 (상태 정보 없음)
    { songId: 'e', status: 'NO_FAIL_CLEAR' },
    'garbage',
  ]));
  assert.deepEqual(loadResults().map(r => [r.songId, r.status]),
    [['a', 'GAME_OVER'], ['b', 'NO_FAIL_CLEAR'], ['c', 'CLEAR'], ['d', 'CLEAR'], ['e', 'NO_FAIL_CLEAR']]);
});
