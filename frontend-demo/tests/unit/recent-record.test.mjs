// 기록 정책 (storage.js 상단 표):
//                  최고 기록   최근 기록   온라인 랭킹
//   정상 CLEAR        저장        저장        대상
//   GAME_OVER         X           저장        제외
//   NO FAIL 사용      X           저장        제외
//   AUTO / PREVIEW    X           X           제외
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { RESULT_STATUS } from '../../js/config.js';
import {
  createGame, hitLane, isRecentRecordAllowed, recentRecordSkipReason, resultRecord, startGame, updateGame,
} from '../../js/engine.js';
import { isRankingEligible } from '../../js/ranking.js';
import { STORAGE_KEYS, loadBestRecord, loadResults, saveBestRecord, saveResult, setStorageBackend } from '../../js/storage.js';
import { MemoryStorage } from './helpers.mjs';

let store;
beforeEach(() => {
  store = new MemoryStorage();
  setStorageBackend(store);
});

const SONG = 'wony-cover-01';
const chart = n => ({ notes: Array.from({ length: n }, (_, i) => ({ time: 1000 + i * 500, lane: i % 4 })) });

function play({ noFail = false, notes = 20, hits = notes }) {
  const s = createGame(chart(notes), { difficulty: 'hard', noFail });
  startGame(s);
  for (let i = 0; i < hits; i++) hitLane(s, i % 4, 1000 + i * 500);
  updateGame(s, s.endTime + 10000);
  return { ...resultRecord(s, { songId: SONG, difficulty: 'hard', noteSpeed: 1 }), playedAt: '2026-10-14T00:00:00Z' };
}

/** 게임 화면(game.js showResult)과 같은 순서로 저장 */
function finish(record, context = {}) {
  const r = { ...record, ...context };
  const best = saveBestRecord(r, context);
  const recent = saveResult({ ...r, ranking: { eligible: isRankingEligible(r, context), submitted: false } }, context);
  return { best, recent, ranking: isRankingEligible(r, context) };
}

const clear = () => play({});
const gameOver = () => play({ notes: 40, hits: 5 });
const noFailClear = () => play({ noFail: true, notes: 40, hits: 5 });
const noFailSafe = () => play({ noFail: true });

test('최근 기록 규칙 helper: AUTO/PREVIEW 만 제외', () => {
  assert.equal(recentRecordSkipReason(clear()), null);
  assert.equal(recentRecordSkipReason(gameOver()), null);
  assert.equal(recentRecordSkipReason(noFailClear()), null);
  assert.equal(recentRecordSkipReason(noFailSafe()), null);
  assert.equal(recentRecordSkipReason(clear(), { autoplay: true }), 'AUTOPLAY');
  assert.equal(recentRecordSkipReason(clear(), { preview: true }), 'PREVIEW');
  assert.equal(recentRecordSkipReason({ ...clear(), autoplay: true }), 'AUTOPLAY', '기록에 붙은 플래그도 확인');
  assert.equal(recentRecordSkipReason({ ...clear(), preview: true }), 'PREVIEW');
  assert.equal(recentRecordSkipReason(null), 'INVALID');
  assert.equal(isRecentRecordAllowed(gameOver()), true);
});

test('AUTO 판은 최근 기록에 저장되지 않는다', () => {
  const r = finish(clear(), { autoplay: true });
  assert.deepEqual(r.recent, { saved: false, skipped: 'AUTOPLAY' });
  assert.equal(store.getItem(STORAGE_KEYS.results), null);
  assert.deepEqual(loadResults(), []);
});

test('PREVIEW 판은 최근 기록에 저장되지 않는다', () => {
  const r = finish(clear(), { preview: true });
  assert.deepEqual(r.recent, { saved: false, skipped: 'PREVIEW' });
  assert.equal(store.getItem(STORAGE_KEYS.results), null);
});

test('저장 함수를 직접 불러도 AUTO/PREVIEW 는 걸러진다 (context 없이 기록 플래그만 있어도)', () => {
  assert.deepEqual(saveResult({ ...clear(), autoplay: true }), { saved: false, skipped: 'AUTOPLAY' });
  assert.deepEqual(saveResult({ ...clear(), preview: true }), { saved: false, skipped: 'PREVIEW' });
  assert.deepEqual(loadResults(), []);
});

test('GAME_OVER 판은 최근 기록에 저장 (최고 기록 X, 랭킹 X)', () => {
  const rec = gameOver();
  assert.equal(rec.status, RESULT_STATUS.GAME_OVER);
  const r = finish(rec);
  assert.deepEqual(r.recent, { saved: true, skipped: null });
  assert.equal(r.best.skipped, 'GAME_OVER');
  assert.equal(r.ranking, false);
  assert.equal(loadResults()[0].status, 'GAME_OVER');
});

test('NO FAIL 판(NO_FAIL_CLEAR / LIFE 남은 CLEAR)은 최근 기록에 저장 (최고 기록 X, 랭킹 X)', () => {
  for (const rec of [noFailClear(), noFailSafe()]) {
    assert.equal(rec.noFail, true);
    const r = finish(rec);
    assert.equal(r.recent.saved, true);
    assert.ok(['NO_FAIL_CLEAR', 'NO_FAIL'].includes(r.best.skipped));
    assert.equal(r.ranking, false);
  }
  assert.deepEqual(loadResults().map(r => r.status), ['CLEAR', 'NO_FAIL_CLEAR']);
  assert.equal(loadBestRecord(SONG, 'hard').bestScore, 0);
});

test('정상 CLEAR 판은 최고 기록 + 최근 기록 + 랭킹 대상', () => {
  const rec = clear();
  const r = finish(rec);
  assert.equal(r.best.saved, true);
  assert.equal(r.best.skipped, null);
  assert.deepEqual(r.recent, { saved: true, skipped: null });
  assert.equal(r.ranking, true);
  assert.equal(loadResults()[0].ranking.eligible, true);
  assert.equal(loadBestRecord(SONG, 'hard').bestScore, rec.score);
});

test('정책 표 전체: 다섯 종류를 섞어 저장', () => {
  const plays = [
    [clear(), {}], [gameOver(), {}], [noFailClear(), {}], [noFailSafe(), {}],
    [clear(), { autoplay: true }], [clear(), { preview: true }],
  ];
  const out = plays.map(([rec, ctx]) => finish(rec, ctx));
  assert.deepEqual(out.map(o => [o.best.saved, o.recent.saved, o.ranking]), [
    [true, true, true],    // 정상 CLEAR
    [false, true, false],  // GAME_OVER
    [false, true, false],  // NO FAIL (LIFE 0 이후 완료)
    [false, true, false],  // NO FAIL (LIFE 남음)
    [false, false, false], // AUTO
    [false, false, false], // PREVIEW
  ]);
  assert.equal(loadResults().length, 4);
});

test('최근 기록 50건 제한 유지 (AUTO/PREVIEW 는 자리를 차지하지 않음)', () => {
  for (let i = 0; i < 60; i++) saveResult({ ...gameOver(), score: i });
  for (let i = 0; i < 10; i++) saveResult({ ...clear(), score: 999 }, { autoplay: true });
  const list = loadResults();
  assert.equal(list.length, 50);
  assert.equal(list[0].score, 59);
  assert.equal(list[49].score, 10);
});

test('이전 빌드가 남긴 AUTO/PREVIEW 최근 기록은 읽을 때 걸러진다', () => {
  store.setItem(STORAGE_KEYS.results, JSON.stringify([
    { ...clear(), autoplay: true }, { ...gameOver() }, { ...clear(), preview: true }, { ...clear() },
  ]));
  assert.deepEqual(loadResults().map(r => r.status), ['GAME_OVER', 'CLEAR']);
  saveResult(noFailSafe());
  const raw = JSON.parse(store.getItem(STORAGE_KEYS.results));
  assert.equal(raw.length, 3, '다음 저장 때 목록에서도 사라짐');
  assert.ok(raw.every(r => !r.autoplay && !r.preview));
});
