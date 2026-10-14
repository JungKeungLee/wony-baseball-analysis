// 순위 변화 문구 · 츄르 보상 · 게스트 지갑 · play_id (중복 방지)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CHURU_REWARDS, churuRewardFor } from '../../js/config.js';
import { createGame, hitLane, newPlayId, resultRecord, startGame, updateGame } from '../../js/engine.js';
import { describeRankChange, animateNumber } from '../../js/rank-change.js';
import { isRankingEligible, loadRanking, rankingExclusionText, setFetch, submitRanking } from '../../js/ranking.js';
import * as wallet from '../../js/wallet.js';
import { isRewardEligible, rewardFor, rewardLabel, walletText, walletView } from '../../js/wallet.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function record({ difficulty = 'hard', status = 'CLEAR', noFail = false, songId = 'demo-beat' } = {}) {
  const s = createGame({ notes: [{ time: 1000, lane: 0 }, { time: 1500, lane: 3 }] }, { difficulty, noFail });
  startGame(s);
  hitLane(s, 0, 1000);
  hitLane(s, 3, 1500);
  updateGame(s, s.endTime);
  return { ...resultRecord(s, { songId, difficulty, noteSpeed: 1.5 }), status };
}

// ── 순위 변화 ───────────────────────────────────────────────────────────────
test('순위 변화: 상승 (12위 → 7위 ▲ 5단계 상승!) + TOP 10 진입', () => {
  const r = describeRankChange({ rankBefore: 12, rankAfter: 7, totalRanked: 40 });
  assert.equal(r.kind, 'up');
  assert.equal(r.transition, '12위 → 7위');
  assert.equal(r.change, '▲ 5단계 상승!');
  assert.deepEqual(r.badges, ['🎉 TOP 10 진입!']);
  assert.equal(r.medal, '');
});

test('순위 변화: 첫 랭킹 진입, 처음부터 TOP 10 이면 같이 표시', () => {
  assert.deepEqual(describeRankChange({ rankBefore: null, rankAfter: 25, totalRanked: 25 }).badges, ['첫 랭킹 진입!']);
  const first = describeRankChange({ rankAfter: 4, totalRanked: 9 });
  assert.equal(first.kind, 'first');
  assert.equal(first.transition, '4위 / 9명');
  assert.deepEqual(first.badges, ['첫 랭킹 진입!', '🎉 TOP 10 진입!']);
});

test('순위 변화: 메달 3 🥉 · 2 🥈 · 1 🥇, 1위 달성 👑', () => {
  assert.equal(describeRankChange({ rankBefore: 5, rankAfter: 3 }).medal, '🥉');
  assert.equal(describeRankChange({ rankBefore: 5, rankAfter: 2 }).medal, '🥈');
  const top = describeRankChange({ rankBefore: 2, rankAfter: 1 });
  assert.equal(top.medal, '🥇');
  assert.deepEqual(top.badges, ['👑 1위 달성!']);
  assert.deepEqual(describeRankChange({ rankBefore: 1, rankAfter: 1 }).badges, [], '이미 1위였으면 1위 달성 문구 없음');
  assert.deepEqual(describeRankChange({ rankBefore: null, rankAfter: 1 }).badges, ['첫 랭킹 진입!', '🎉 TOP 10 진입!', '👑 1위 달성!']);
});

test('순위 변화: 유지 · 새 최고 점수 + 순위 유지 · 하락 · 재전송 · 랭킹 없음', () => {
  const same = describeRankChange({ rankBefore: 7, rankAfter: 7 });
  assert.deepEqual([same.kind, same.change, same.badges], ['same', '순위 유지', []]);
  const better = describeRankChange({ rankBefore: 7, rankAfter: 7, improvedScore: true });
  assert.deepEqual([better.change, better.badges], ['순위 유지', ['새 최고 점수!']]);
  assert.equal(describeRankChange({ rankBefore: 3, rankAfter: 4 }).change, '▼ 1단계');
  assert.equal(describeRankChange({ rankBefore: null, rankAfter: 7, duplicate: true }).kind, 'recorded');
  assert.equal(describeRankChange({ rankBefore: 3, rankAfter: null }), null);
  assert.equal(describeRankChange({}), null);
  assert.equal(describeRankChange({ rankAfter: 0 }), null);
});

test('숫자 연출: 동작 줄이기(reduced motion)면 바로 최종값', async () => {
  const el = { textContent: '' };
  await animateNumber(el, 12, 7, { reducedMotion: true, format: n => `${n}위` });
  assert.equal(el.textContent, '7위');
  await animateNumber(el, 26, 30, { reducedMotion: false }); // node 에는 requestAnimationFrame 이 없음 → 바로 최종값
  assert.equal(el.textContent, '30');
});

// ── 츄르 보상 ───────────────────────────────────────────────────────────────
test('츄르 보상: EASY 1 · NORMAL 2 · HARD 4 · HELL 7, 곡별 배율 · 보너스로 확장', () => {
  assert.deepEqual({ ...CHURU_REWARDS }, { easy: 1, normal: 2, hard: 4, hell: 7 });
  for (const [d, n] of Object.entries(CHURU_REWARDS)) assert.equal(rewardFor(record({ difficulty: d })), n);
  const songs = { 'event-song': { multiplier: 1.5, bonus: 2 }, 'bonus-only': { bonus: 3 } };
  assert.equal(churuRewardFor('hard', 'event-song', songs), 8);
  assert.equal(churuRewardFor('easy', 'bonus-only', songs), 4);
  assert.equal(churuRewardFor('hard', 'other', songs), 4);
  assert.equal(churuRewardFor('insane', 'x'), 0);
  assert.equal(rewardLabel(record({ difficulty: 'hard' })), 'HARD 클리어 보상');
});

test('츄르 지급 조건 = 랭킹 조건 (같은 함수): 정상 CLEAR 만', () => {
  assert.equal(isRewardEligible, isRankingEligible);
  assert.equal(isRewardEligible(record()), true);
  assert.equal(isRewardEligible(record({ status: 'GAME_OVER' })), false);
  assert.equal(isRewardEligible(record({ status: 'NO_FAIL_CLEAR', noFail: true })), false);
  assert.equal(isRewardEligible(record({ noFail: true })), false, 'NO FAIL 을 켜고 CLEAR');
  assert.equal(isRewardEligible(record(), { autoplay: true }), false);
  assert.equal(isRewardEligible(record(), { preview: true }), false);
});

test('랭킹 제외 안내 문구', () => {
  assert.equal(rankingExclusionText(record()), null);
  assert.equal(rankingExclusionText(record({ noFail: true })), 'NO FAIL 플레이는 온라인 랭킹에 반영되지 않습니다.');
  assert.equal(rankingExclusionText(record({ status: 'NO_FAIL_CLEAR', noFail: true })), 'NO FAIL 플레이는 온라인 랭킹에 반영되지 않습니다.');
  assert.equal(rankingExclusionText(record({ status: 'GAME_OVER' })), 'GAME OVER 플레이는 온라인 랭킹에 반영되지 않습니다.');
  assert.equal(rankingExclusionText(record(), { autoplay: true }), '자동 플레이는 온라인 랭킹에 반영되지 않습니다.');
  assert.equal(rankingExclusionText(record(), { preview: true }), '미리보기 플레이는 온라인 랭킹에 반영되지 않습니다.');
});

// ── 츄르 지갑: 로그인 회원의 서버 잔액만 (이 기기에는 저장 · 지급하지 않음) ─────────────
test('지갑 표시: 로그인 회원 = 서버 잔액, 비로그인 = 없음 (로컬 지급 기능 없음)', () => {
  assert.deepEqual(walletView({ onlineEnabled: true, loggedIn: true, churuBalance: 26 }), { balance: 26 });
  assert.deepEqual(walletView({ onlineEnabled: true, loggedIn: true, churuBalance: null }), { balance: null });
  assert.deepEqual(walletView({ onlineEnabled: true, loggedIn: false, churuBalance: 99 }), { balance: null });
  assert.deepEqual(walletView({ onlineEnabled: false }), { balance: null });
  assert.equal(walletText(1234), '🐟 츄르 1,234');
  assert.equal(walletText(null), '🐟 츄르 -');
  const api = Object.keys(wallet).join(' ');
  assert.ok(!/grantLocal|LocalBalance|WALLET_STORAGE/.test(api), api);
});

// ── play_id ────────────────────────────────────────────────────────────────
test('playId: 판마다 새 UUID, 결과 기록 · 온라인 행에 포함', () => {
  const ids = new Set(Array.from({ length: 50 }, () => newPlayId()));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, UUID);
  assert.match(newPlayId({ getRandomValues: b => b.fill(7) }), UUID, 'randomUUID 없는 브라우저');
  assert.match(newPlayId({}), UUID);
  const a = record();
  const b = record();
  assert.notEqual(a.playId, b.playId);
});

let calls;
function fakeServer(handler) {
  calls = [];
  setFetch(async (url, opts = {}) => {
    calls.push({ url, body: opts.body ? JSON.parse(opts.body) : null });
    const { status = 200, body = {} } = (await handler(url, calls.length)) || {};
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  });
}
beforeEach(() => fakeServer(() => ({ body: { ok: true } })));

test('온라인 저장: 장애면 같은 play_id 로 1번만 다시 보냄, 로그인 필요 · 거절은 재시도 안 함', async () => {
  fakeServer((url, n) => (n === 1 ? { status: 502, body: { ok: false } } : { body: { ok: true, ranked: true, duplicate: false } }));
  const r = await submitRanking(record(), {}, { retryDelayMs: 0 });
  assert.equal(r.submitted, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.play_id, calls[1].body.play_id);
  fakeServer(() => ({ status: 502, body: { ok: false } }));
  assert.deepEqual(await submitRanking(record(), {}, { retryDelayMs: 0 }), { submitted: false, reason: 'failed' });
  assert.equal(calls.length, 2, '최대 2번');
  for (const status of [401, 400, 422, 429]) {
    fakeServer(() => ({ status, body: { ok: false } }));
    await submitRanking(record(), {}, { retryDelayMs: 0 });
    assert.equal(calls.length, 1, String(status));
  }
});

test('온라인 저장 응답: 순위 전/후 · 츄르는 서버 값만, 지급량을 보내지 않음', async () => {
  fakeServer(() => ({ body: {
    ok: true, ranked: true, duplicate: false, rankBefore: 12, rankAfter: 7, totalRanked: 40, bestBefore: 1000,
    best: { best_score: 2000 }, improved: { score: true },
    churu: { granted: true, amount: 4, balanceBefore: 26, balanceAfter: 30 },
  } }));
  const r = await submitRanking(record());
  assert.deepEqual([r.rankBefore, r.rankAfter, r.totalRanked, r.bestBefore], [12, 7, 40, 1000]);
  assert.deepEqual(r.churu, { granted: true, amount: 4, balanceBefore: 26, balanceAfter: 30 });
  const sent = JSON.stringify(calls[0].body);
  for (const k of ['churu', 'reward', 'balance', 'price', 'user_id']) assert.ok(!sent.includes(k), k);
  fakeServer(() => ({ body: { ok: true, ranked: false, churu: { granted: false, amount: 99, balanceAfter: 99 } } }));
  assert.deepEqual((await submitRanking(record())).churu, { granted: false, amount: 0, balanceBefore: null, balanceAfter: null });
});

test('랭킹 미리보기: around 를 붙여 내 주변 순위 조회 (곡 + 난이도, 배속 구분 없음)', async () => {
  fakeServer(() => ({ body: { ok: true, rows: [] } }));
  await loadRanking('demo-beat', 'hard', { limit: 3, around: 2 });
  assert.equal(calls[0].url, '/api/rhythm/ranking?song=demo-beat&difficulty=hard&laneCount=4&limit=3&around=2');
  assert.ok(!calls[0].url.includes('speed'));
});
