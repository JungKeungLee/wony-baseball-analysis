// 온라인 기록 · 랭킹 클라이언트 (js/ranking.js). fetch 를 가짜로 바꿔 서버 응답별 동작 확인.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGame, hitLane, resultRecord, startGame, updateGame } from '../../js/engine.js';
import {
  bestOf, getOnlineStatus, isOnlineSubmittable, isRankingEligible, loadMyRecords, loadRanking, setFetch, submitRanking, toRankingRow,
} from '../../js/ranking.js';

const POLICY = JSON.parse(readFileSync(new URL('../../../shared/record_policy_cases.json', import.meta.url), 'utf-8'));
// 006 이 rhythm_submit_play 를 교체 (play_id 추가)
const SQL_FUNCTIONS = readFileSync(new URL('../../../supabase/sql/006_rhythm_play_id_and_churu.sql', import.meta.url), 'utf-8');

let calls;
function fakeServer(handler) {
  calls = [];
  setFetch(async (url, opts = {}) => {
    calls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null });
    const { status = 200, body = {} } = (await handler(url, opts)) || {};
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  });
}

function clearRecord({ noFail = false } = {}) {
  const s = createGame({ notes: [{ time: 1000, lane: 0 }, { time: 1500, lane: 3 }] }, { difficulty: 'hard', noFail });
  startGame(s);
  hitLane(s, 0, 1000);
  hitLane(s, 3, 1500);
  updateGame(s, s.endTime);
  return { ...resultRecord(s, { songId: 'demo-beat', difficulty: 'hard', noteSpeed: 1.75 }), playedAt: '2026-10-14T00:00:00Z' };
}

beforeEach(() => fakeServer(() => ({ body: { ok: true, ranked: true, best: { best_score: 2000 }, improved: { score: true } } })));

test('toRankingRow: DB 함수(rhythm_submit_play)가 읽는 컬럼과 정확히 같은 키, user_id 없음', () => {
  const row = toRankingRow(clearRecord());
  const insertCols = SQL_FUNCTIONS.match(/insert into public\.rhythm_play_records \(([^)]+)\)/)[1]
    .split(',').map(c => c.trim()).filter(c => c !== 'user_id');
  assert.deepEqual(Object.keys(row).sort(), insertCols.sort());
  assert.equal('user_id' in row, false);
  assert.match(row.play_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual({ ...row, play_id: 'x' }, {
    play_id: 'x', song_id: 'demo-beat', difficulty: 'hard', lane_count: 4, note_speed: 1.75, status: 'CLEAR', no_fail: false,
    score: 2000, grade: 'S+', accuracy: 100, max_combo: 2, perfect_count: 2, great_count: 0, good_count: 0,
    miss_count: 0, total_notes: 2, final_life: 5, result_version: 3,
  });
});

test('기록 정책 (shared fixture): 서버로 보내는 판 / 랭킹 대상', () => {
  for (const c of POLICY.cases) {
    const record = { ...clearRecord({ noFail: c.noFail }), status: c.status };
    const ctx = { autoplay: c.autoplay, preview: c.preview };
    assert.equal(isOnlineSubmittable(record, ctx), c.expect.sendOnline, c.name);
    assert.equal(isRankingEligible(record, ctx), c.expect.ranking, c.name);
  }
});

test('정상 CLEAR: 결과 1건을 POST /api/rhythm/results 로 1번 보냄', async () => {
  const rec = clearRecord();
  const r = await submitRanking(rec);
  assert.deepEqual(r, {
    submitted: true, ranked: true, duplicate: false, best: { best_score: 2000 }, improved: { score: true },
    rankBefore: null, rankAfter: null, totalRanked: null, bestBefore: null,
    churu: { granted: false, amount: 0, balanceBefore: null, balanceAfter: null },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/rhythm/results');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.credentials, 'same-origin');
  assert.deepEqual(calls[0].body, toRankingRow(rec));
});

test('AUTO / PREVIEW 는 서버 요청 자체를 하지 않음', async () => {
  assert.deepEqual(await submitRanking(clearRecord(), { autoplay: true }), { submitted: false, reason: 'autoplay' });
  assert.deepEqual(await submitRanking(clearRecord(), { preview: true }), { submitted: false, reason: 'preview' });
  assert.deepEqual(await submitRanking({ ...clearRecord(), autoplay: true }), { submitted: false, reason: 'autoplay' });
  assert.equal(calls.length, 0);
});

test('GAME_OVER / NO FAIL 판도 실제 플레이라 보냄 (랭킹 여부는 서버/DB 가 같은 규칙으로 판단)', async () => {
  fakeServer(() => ({ body: { ok: true, ranked: false, best: null, improved: {} } }));
  const r = await submitRanking(clearRecord({ noFail: true }));
  assert.equal(r.submitted, true);
  assert.equal(r.ranked, false);
  assert.equal(calls[0].body.no_fail, true);
});

test('서버 응답별 실패 이유 (예외 없이 반환)', async () => {
  for (const [status, reason] of [[401, 'login-required'], [503, 'not-configured'], [429, 'too-many'], [422, 'rejected'], [400, 'rejected'], [502, 'failed'], [500, 'failed']]) {
    fakeServer(() => ({ status, body: { ok: false } }));
    assert.deepEqual(await submitRanking(clearRecord()), { submitted: false, reason }, String(status));
  }
  fakeServer(() => { throw new TypeError('Failed to fetch'); });
  assert.deepEqual(await submitRanking(clearRecord()), { submitted: false, reason: 'failed' });
  fakeServer(() => ({ status: 200, body: null }));
  assert.equal((await submitRanking(clearRecord())).submitted, false, 'JSON 이 깨져도 실패로만 처리');
});

test('loadRanking: 곡 + 난이도 + 레인 수 조회, 실패해도 빈 목록', async () => {
  fakeServer(() => ({ body: { ok: true, rows: [{ rank: 1, nickname: '사용자A', bestScore: 200000, isMe: false }] } }));
  const r = await loadRanking('wony-cover-01', 'hard', { limit: 10 });
  assert.deepEqual(r, { ok: true, rows: [{ rank: 1, nickname: '사용자A', bestScore: 200000, isMe: false }] });
  assert.equal(calls[0].url, '/api/rhythm/ranking?song=wony-cover-01&difficulty=hard&laneCount=4&limit=10');
  fakeServer(() => ({ status: 401, body: { ok: false } }));
  assert.deepEqual(await loadRanking('x1', 'easy'), { ok: false, rows: [], reason: 'login-required' });
  fakeServer(() => { throw new Error('network'); });
  assert.deepEqual(await loadRanking('x1', 'easy'), { ok: false, rows: [], reason: 'failed' });
});

test('getOnlineStatus: 로그인 상태, 서버에 닿지 않으면 온라인 꺼짐으로', async () => {
  fakeServer(() => ({ body: { loggedIn: true, nickname: '워니팬', onlineEnabled: true, loginUrl: null } }));
  assert.deepEqual(await getOnlineStatus(), { loggedIn: true, nickname: '워니팬', onlineEnabled: true, loginUrl: null, churuBalance: null });
  fakeServer(() => ({ body: { loggedIn: true, nickname: '워니팬', onlineEnabled: true, loginUrl: null, churuBalance: 26 } }));
  assert.equal((await getOnlineStatus()).churuBalance, 26);
  for (const bad of [-1, 1.5, '26', true]) {
    fakeServer(() => ({ body: { loggedIn: true, onlineEnabled: true, churuBalance: bad } }));
    assert.equal((await getOnlineStatus()).churuBalance, null, String(bad));
  }
  fakeServer(() => { throw new Error('offline'); });
  assert.deepEqual(await getOnlineStatus(), { loggedIn: false, onlineEnabled: false, error: true });
});

test('loadMyRecords: 내 기록은 서버에서만, 실패 · 세션 만료도 예외 없이', async () => {
  const best = [{ songId: 'demo-beat', difficulty: 'hard', laneCount: 4, bestScore: 30000, bestGrade: 'S+' }];
  fakeServer(() => ({ body: { ok: true, best, recent: [] } }));
  assert.deepEqual(await loadMyRecords(), { ok: true, best, recent: [] });
  assert.equal(calls[0].url, '/api/rhythm/records');
  assert.equal(calls[0].opts.credentials, 'same-origin');
  assert.equal(bestOf(best, 'demo-beat', 'hard').bestScore, 30000);
  assert.equal(bestOf(best, 'demo-beat', 'easy'), null);
  assert.equal(bestOf(best, 'demo-beat', 'hard', 6), null, '레인 수 구분');
  fakeServer(() => ({ status: 401, body: { ok: false } }));
  assert.deepEqual(await loadMyRecords(), { ok: false, best: [], recent: [], reason: 'login-required' });
  fakeServer(() => { throw new Error('offline'); });
  assert.equal((await loadMyRecords()).reason, 'failed');
});

test('세션 만료(401): 같은 판을 다시 보내지 않음 (중복 저장 · 지급 없음)', async () => {
  fakeServer(() => ({ status: 401, body: { ok: false, error: 'login_required' } }));
  assert.deepEqual(await submitRanking(clearRecord(), {}, { retryDelayMs: 0 }), { submitted: false, reason: 'login-required' });
  assert.equal(calls.length, 1);
});
