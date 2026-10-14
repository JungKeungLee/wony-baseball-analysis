// 기록 정책 (로그인 필수 이후): 기록은 이 기기에 저장하지 않고 서버(DB)에만 남는다.
//                  최고 기록   최근 플레이   온라인 랭킹 · 츄르
//   정상 CLEAR        DB          DB           대상
//   GAME_OVER         X           DB           제외
//   NO FAIL 사용      X           DB           제외      (NO_FAIL_CLEAR 및 LIFE 가 남은 CLEAR 모두)
//   AUTO / PREVIEW    X           X            제외      (서버로 보내지 않음)
// 판단 함수는 engine.js / ranking.js, DB 는 같은 규칙(rhythm_private.is_normal_clear)으로 다시 확인 (supabase/tests).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RESULT_STATUS } from '../../js/config.js';
import {
  createGame, finishGame, hitLane, isNormalClear, isRecentRecordAllowed, notNormalClearReason, recentRecordSkipReason,
  resultRecord, resultStatus, startGame, updateGame,
} from '../../js/engine.js';
import { gradeOrder, isBetterGrade } from '../../js/judge.js';
import { isOnlineSubmittable, isRankingEligible } from '../../js/ranking.js';

const POLICY = JSON.parse(readFileSync(new URL('../../../shared/record_policy_cases.json', import.meta.url), 'utf-8'));
const SONG = 'wony-cover-01';
const chart = n => ({ notes: Array.from({ length: n }, (_, i) => ({ time: 1000 + i * 500, lane: i % 4 })) });

/** 실제 엔진으로 한 판: 앞의 hits 개만 정확히 치고 나머지는 놓친다 */
function play({ difficulty = 'hard', noFail = false, notes = 20, hits = notes } = {}) {
  const s = createGame(chart(notes), { difficulty, noFail });
  startGame(s);
  for (let i = 0; i < hits; i++) hitLane(s, i % 4, 1000 + i * 500);
  updateGame(s, s.endTime + 10000);
  return resultRecord(s, { songId: SONG, difficulty, noteSpeed: 1 });
}

const clear = () => play();
const gameOver = () => play({ notes: 40, hits: 5 });
const noFailClear = () => play({ noFail: true, notes: 40, hits: 5 });
const noFailSafe = () => play({ noFail: true });

test('정상 클리어 판 정의 (최고 기록 · 랭킹 · 츄르 대상)', () => {
  const r = clear();
  assert.equal(r.status, RESULT_STATUS.CLEAR);
  assert.equal(notNormalClearReason(r), null);
  assert.equal(isNormalClear(r), true);
  assert.equal(notNormalClearReason(r, { autoplay: true }), 'AUTOPLAY');
  assert.equal(notNormalClearReason(r, { preview: true }), 'PREVIEW');
  assert.equal(notNormalClearReason({ ...r, autoplay: true }), 'AUTOPLAY', '기록에 붙은 플래그도 확인');
  assert.equal(notNormalClearReason({ ...r, noFail: true }), 'NO_FAIL');
  assert.equal(notNormalClearReason({ ...r, noFail: undefined }), 'NO_FAIL', 'NO FAIL 여부를 모르면 정상 클리어로 보지 않음');
  assert.equal(notNormalClearReason({ ...r, status: undefined }), 'NOT_CLEAR');
  assert.equal(notNormalClearReason(null), 'NOT_CLEAR');
  assert.equal(notNormalClearReason(gameOver()), 'GAME_OVER');
  assert.equal(notNormalClearReason(noFailClear()), 'NO_FAIL_CLEAR');
  assert.equal(notNormalClearReason(noFailSafe()), 'NO_FAIL');
});

test('서버로 보내는 판 (최근 플레이 기록): AUTO / PREVIEW 만 제외', () => {
  for (const r of [clear(), gameOver(), noFailClear(), noFailSafe()]) {
    assert.equal(recentRecordSkipReason(r), null);
    assert.equal(isRecentRecordAllowed(r), true);
    assert.equal(isOnlineSubmittable(r), true);
  }
  assert.equal(recentRecordSkipReason(clear(), { autoplay: true }), 'AUTOPLAY');
  assert.equal(recentRecordSkipReason(clear(), { preview: true }), 'PREVIEW');
  assert.equal(recentRecordSkipReason({ ...clear(), preview: true }), 'PREVIEW');
  assert.equal(recentRecordSkipReason(null), 'INVALID');
  assert.equal(isOnlineSubmittable(clear(), { autoplay: true }), false);
  assert.equal(isOnlineSubmittable(clear(), { preview: true }), false);
});

test('정책 표 (shared fixture, 서버 · DB 와 같은 사례)', () => {
  for (const c of POLICY.cases) {
    const record = { ...clear(), status: c.status, noFail: c.noFail };
    const ctx = { autoplay: c.autoplay, preview: c.preview };
    assert.equal(isNormalClear(record, ctx), c.expect.bestRecord, `${c.name} best`);
    assert.equal(isOnlineSubmittable(record, ctx), c.expect.sendOnline, `${c.name} send`);
    assert.equal(isRankingEligible(record, ctx), c.expect.ranking, `${c.name} ranking`);
  }
});

test('CLEAR / GAME_OVER / NO_FAIL_CLEAR 상태 구분 (등급과 별개)', () => {
  const r = clear();
  assert.equal(r.grade, 'S+');
  const missy = (() => {
    const s = createGame(chart(9), { difficulty: 'easy' });
    startGame(s);
    finishGame(s, 99999);   // EASY: MISS 9번 = LIFE 1 남음
    return resultRecord(s, { songId: SONG, difficulty: 'easy', noteSpeed: 1 });
  })();
  assert.equal(missy.status, RESULT_STATUS.CLEAR, '등급이 F 여도 LIFE 가 남으면 CLEAR');
  assert.equal(missy.grade, 'F');
  assert.equal(isRankingEligible(missy), true);
  const over = gameOver();
  assert.equal(over.status, RESULT_STATUS.GAME_OVER);
  assert.equal(over.grade, 'F');
  assert.equal(noFailClear().status, RESULT_STATUS.NO_FAIL_CLEAR);
  assert.equal(noFailSafe().status, RESULT_STATUS.CLEAR, 'NO FAIL 을 켰어도 LIFE 가 남았으면 CLEAR');
  assert.equal(isRankingEligible(noFailSafe()), false, 'NO FAIL 을 켠 판은 CLEAR 여도 제외');
  for (const x of [r, over, noFailClear()]) {
    assert.equal(x.cleared, x.status === RESULT_STATUS.CLEAR);
    assert.equal(x.gameOver, x.status === RESULT_STATUS.GAME_OVER);
    assert.equal(x.schema, 3);
  }
  const s = createGame(chart(2), { difficulty: 'normal' });
  startGame(s);
  assert.equal(resultStatus(s), RESULT_STATUS.CLEAR);
});

test('등급 순서 (S+ > S > A > … > F)', () => {
  assert.ok(isBetterGrade('S+', 'S') && isBetterGrade('A', 'B') && isBetterGrade('D', 'F') && isBetterGrade('F', null));
  assert.ok(!isBetterGrade('B', 'A') && !isBetterGrade('A', 'A') && !isBetterGrade('Z', 'F'));
  assert.equal(gradeOrder('없음'), Infinity);
});
