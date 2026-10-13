// 최고 기록은 "정상 클리어 판"(status CLEAR + NO FAIL 미사용 + 자동 플레이/미리보기 아님)에서만 갱신된다.
// (최근 기록 저장 규칙은 recent-record.test.mjs)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { RESULT_STATUS } from '../../js/config.js';
import { createGame, hitLane, isNormalClear, notNormalClearReason, resultRecord, startGame, updateGame } from '../../js/engine.js';
import { STORAGE_KEYS, loadBestRecord, loadResults, saveBestRecord, saveResult, setStorageBackend } from '../../js/storage.js';
import { MemoryStorage } from './helpers.mjs';

let store;
beforeEach(() => {
  store = new MemoryStorage();
  setStorageBackend(store);
});

const SONG = 'wony-cover-01';
const chart = n => ({ notes: Array.from({ length: n }, (_, i) => ({ time: 1000 + i * 500, lane: i % 4 })) });
const t = i => 1000 + i * 500;

/** 실제 엔진으로 한 판: 앞의 hits 개는 delta(ms) 어긋나게 치고 나머지는 놓친다. GAME OVER 면 거기서 끝. */
function play({ difficulty = 'hard', noFail = false, notes = 40, hits = notes, delta = 0 }) {
  const s = createGame(chart(notes), { difficulty, noFail });
  startGame(s);
  for (let i = 0; i < hits; i++) hitLane(s, i % 4, t(i) + delta);
  updateGame(s, s.endTime + 10000);
  return { ...resultRecord(s, { songId: SONG, difficulty, noteSpeed: 1 }), playedAt: new Date().toISOString() };
}

const bests = (difficulty = 'hard') => {
  const b = loadBestRecord(SONG, difficulty);
  return [b.bestScore, b.bestGrade, b.bestAccuracy, b.bestMaxCombo];
};

test('정상 클리어 판 정의', () => {
  const clear = play({ hits: 40 });
  assert.equal(clear.status, RESULT_STATUS.CLEAR);
  assert.equal(notNormalClearReason(clear), null);
  assert.equal(isNormalClear(clear), true);
  assert.equal(notNormalClearReason(clear, { autoplay: true }), 'AUTOPLAY');
  assert.equal(notNormalClearReason(clear, { preview: true }), 'PREVIEW');
  assert.equal(notNormalClearReason({ ...clear, autoplay: true }), 'AUTOPLAY', '기록에 붙은 플래그도 확인');
  assert.equal(notNormalClearReason({ ...clear, noFail: true }), 'NO_FAIL');
  assert.equal(notNormalClearReason({ ...clear, noFail: undefined }), 'NO_FAIL', 'NO FAIL 여부를 모르면 정상 클리어로 보지 않음');
  assert.equal(notNormalClearReason({ ...clear, status: undefined }), 'NOT_CLEAR');
  assert.equal(notNormalClearReason(null), 'NOT_CLEAR');
});

test('정상 CLEAR 에서 bestScore / bestGrade / bestAccuracy / bestMaxCombo 가 각각 갱신된다', () => {
  const first = play({ hits: 40, delta: 100 }); // 전부 GREAT
  assert.equal(first.grade, 'B');
  assert.equal(saveBestRecord(first).saved, true);
  assert.deepEqual(bests(), [first.score, 'B', 80, 40]);

  const only = over => saveBestRecord({ ...first, score: 1, grade: 'F', accuracy: 1, maxCombo: 1, ...over }).improved;
  assert.deepEqual(only({ score: first.score + 1 }), { score: true, grade: false, accuracy: false, maxCombo: false });
  assert.deepEqual(only({ grade: 'A' }), { score: false, grade: true, accuracy: false, maxCombo: false });
  assert.deepEqual(only({ accuracy: 85.5 }), { score: false, grade: false, accuracy: true, maxCombo: false });
  assert.deepEqual(only({ maxCombo: 41 }), { score: false, grade: false, accuracy: false, maxCombo: true });
  assert.deepEqual(bests(), [first.score + 1, 'A', 85.5, 41]);

  const perfect = play({ hits: 50, notes: 50 }); // 실제 PERFECT 클리어: 네 항목 모두 갱신
  assert.deepEqual(saveBestRecord(perfect).improved, { score: true, grade: true, accuracy: true, maxCombo: true });
  assert.deepEqual(bests(), [perfect.score, 'S+', 100, 50]);
});

test('GAME_OVER 에서는 bestMaxCombo 가 갱신되지 않는다', () => {
  saveBestRecord(play({ hits: 10, notes: 10 })); // 정상 클리어: 콤보 10
  const gameOver = play({ notes: 60, hits: 45 }); // 45콤보 후 MISS 10번 → GAME OVER
  assert.equal(gameOver.status, RESULT_STATUS.GAME_OVER);
  assert.equal(gameOver.maxCombo, 45);
  const r = saveBestRecord(gameOver);
  assert.equal(r.skipped, 'GAME_OVER');
  assert.equal(r.saved, false);
  assert.equal(loadBestRecord(SONG, 'hard').bestMaxCombo, 10);
});

test('NO_FAIL_CLEAR 에서는 bestScore 가 갱신되지 않는다', () => {
  saveBestRecord(play({ hits: 4, notes: 4 }));
  const before = loadBestRecord(SONG, 'hard').bestScore;
  const noFailClear = play({ noFail: true, notes: 80, hits: 50 }); // 50 PERFECT 후 MISS → LIFE 0 → 끝까지
  assert.equal(noFailClear.status, RESULT_STATUS.NO_FAIL_CLEAR);
  assert.ok(noFailClear.score > before);
  assert.equal(saveBestRecord(noFailClear).skipped, 'NO_FAIL_CLEAR');
  assert.equal(loadBestRecord(SONG, 'hard').bestScore, before);
});

test('NO FAIL ON + LIFE 남음 + status CLEAR 여도 최고 기록은 갱신되지 않는다', () => {
  const noFailSafe = play({ noFail: true, hits: 40 });
  assert.equal(noFailSafe.status, RESULT_STATUS.CLEAR);
  assert.equal(noFailSafe.noFail, true);
  assert.ok(noFailSafe.life > 0);
  assert.equal(saveBestRecord(noFailSafe).skipped, 'NO_FAIL');
  assert.deepEqual(bests(), [0, null, null, null]);
  assert.equal(store.getItem(STORAGE_KEYS.scores), null, '저장소를 건드리지 않음');
});

test('자동 플레이 / 미리보기 판도 최고 기록 갱신 안 됨', () => {
  const clear = play({ hits: 40 });
  assert.equal(saveBestRecord(clear, { autoplay: true }).skipped, 'AUTOPLAY');
  assert.equal(saveBestRecord(clear, { preview: true }).skipped, 'PREVIEW');
  assert.deepEqual(bests(), [0, null, null, null]);
});

test('EASY 등급 F 라도 LIFE 가 남고 NO FAIL 을 안 썼으면 CLEAR → 최고 기록 갱신', () => {
  const r = play({ difficulty: 'easy', notes: 10, hits: 0 }); // 10개 모두 MISS → LIFE 50
  assert.equal(r.status, RESULT_STATUS.CLEAR);
  assert.equal(r.grade, 'F');
  assert.equal(r.life, 50);
  assert.equal(saveBestRecord(r).saved, true);
  assert.deepEqual(bests('easy'), [0, 'F', 0, 0]);
});

test('기존 최고 기록은 실패/NO FAIL/AUTO/PREVIEW 판으로 덮이지 않는다', () => {
  const clear = play({ hits: 40, delta: 100 }); // GREAT 클리어
  saveBestRecord(clear);
  saveResult(clear);
  const snapshot = store.getItem(STORAGE_KEYS.scores);

  const others = [
    play({ notes: 60, hits: 50 }),               // GAME_OVER: 콤보 50 (더 높음)
    play({ noFail: true, notes: 80, hits: 60 }), // NO_FAIL_CLEAR: 점수 더 높음
    play({ noFail: true, hits: 40 }),            // NO FAIL + CLEAR: 전부 PERFECT (모든 항목 더 좋음)
    { ...play({ hits: 40 }), autoplay: true },   // 자동 플레이
    { ...play({ hits: 40 }), preview: true },    // 미리보기
  ];
  for (const f of others) {
    assert.ok(saveBestRecord(f).skipped, `${f.status} 은 건너뜀`);
    saveResult(f);
  }
  assert.equal(store.getItem(STORAGE_KEYS.scores), snapshot, '최고 기록 그대로');
  assert.deepEqual(bests(), [clear.score, 'B', 80, 40]);

  // 최근 기록: 실제 플레이 4건만 (AUTO/PREVIEW 제외)
  const recent = loadResults();
  assert.deepEqual(recent.map(r => [r.status, r.noFail]),
    [['CLEAR', true], ['NO_FAIL_CLEAR', true], ['GAME_OVER', false], ['CLEAR', false]]);
});
