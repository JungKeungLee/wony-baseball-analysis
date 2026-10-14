// supabase/sql/*.sql 을 실제 Postgres(PGlite, 메모리)에서 실행해 검증. 운영 Supabase 에는 접속하지 않음.
//   cd supabase/tests && npm install && npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { accuracy as jsAccuracy, rankGrade } from '../../frontend-demo/js/judge.js';
import { isNormalClear, recentRecordSkipReason } from '../../frontend-demo/js/engine.js';
import { toRankingRow } from '../../frontend-demo/js/ranking.js';

const SQL = name => readFileSync(new URL(`../sql/${name}`, import.meta.url), 'utf-8');
const STUB = readFileSync(new URL('./supabase_stub.sql', import.meta.url), 'utf-8');
const POLICY = JSON.parse(readFileSync(new URL('../../shared/record_policy_cases.json', import.meta.url), 'utf-8'));
const APPLY = ['001_rhythm_tables.sql', '002_rhythm_indexes.sql', '003_rhythm_functions.sql', '004_rhythm_rls.sql', '006_rhythm_play_id_and_churu.sql', '007_rhythm_my_records.sql', '008_rhythm_note_speed_6x.sql'];
const SECRET = 'test-secret-' + 'x'.repeat(40);

async function freshDb({ secret = SECRET } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(STUB);
  for (const f of APPLY) await db.exec(SQL(f));
  if (secret) await db.query("insert into rhythm_private.settings (key, value) values ('server_hmac_secret', $1)", [secret]);
  return db;
}

async function addMember(db, { nickname = '회원', isPublic = true, email } = {}) {
  const id = randomUUID();
  await db.query('insert into auth.users (id, email) values ($1, $2)', [id, email || `${id}@example.com`]);
  await db.query('insert into public.profiles (id, email, nickname, is_public) values ($1, $2, $3, $4)', [id, email || `${id}@example.com`, nickname, isPublic]);
  return id;
}

/** 역할(anon/authenticated)과 auth.uid() 를 바꿔서 실행 */
async function as(db, role, uid, fn) {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [uid || '']);
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
  }
}

/** 게임 엔진과 같은 규칙으로 결과(JS 형식) → toRankingRow 로 DB 형식 */
function makeRow({ status = 'CLEAR', noFail = false, p = 10, g = 0, gd = 0, m = 0, total, bonus = 0, combo, life, song = 'wony-cover-01', diff = 'hard', laneCount = 4, speed = 1.5, playId = randomUUID() } = {}) {
  const totalNotes = total ?? p + g + gd + m;
  const counts = { PERFECT: p, GREAT: g, GOOD: gd, MISS: m };
  const acc = jsAccuracy(counts, totalNotes);
  return toRankingRow({
    playId, schema: 3, status, songId: song, difficulty: diff, laneCount, noteSpeed: speed,
    score: p * 1000 + g * 700 + gd * 400 + bonus, maxCombo: combo ?? p + g + gd,
    perfect: p, great: g, good: gd, miss: m, totalNotes, accuracy: acc,
    life: life ?? (status === 'CLEAR' ? 100 : 0), grade: rankGrade(acc, { gameOver: status === 'GAME_OVER' }), noFail,
  });
}

function sign(payloadObj, secret = SECRET) {
  const payload = JSON.stringify(payloadObj);
  return { payload, signature: createHmac('sha256', secret).update(payload).digest('hex') };
}

const now = () => Math.floor(Date.now() / 1000);

async function submit(db, userId, record, { secret = SECRET, ts = now(), nonce = randomBytes(16).toString('hex'), action = 'submit', role = 'anon' } = {}) {
  const { payload, signature } = sign({ action, user_id: userId, ts, nonce, record }, secret);
  return as(db, role, null, async () => (await db.query('select public.rhythm_submit_play($1, $2) as r', [payload, signature])).rows[0].r);
}

async function rankingSigned(db, viewer, song, diff, { limit = 50, laneCount = 4, around } = {}) {
  const { payload, signature } = sign({ action: 'ranking', user_id: viewer, ts: now(), song_id: song, difficulty: diff, lane_count: laneCount, limit, ...(around === undefined ? {} : { around }) });
  return as(db, 'anon', null, async () => (await db.query('select public.rhythm_get_ranking_signed($1, $2) as r', [payload, signature])).rows[0].r);
}

const best = async (db, uid, song = 'wony-cover-01', diff = 'hard') =>
  (await db.query('select * from public.rhythm_scores where user_id = $1 and song_id = $2 and difficulty = $3', [uid, song, diff])).rows[0];

// ─────────────────────────────────────────────────────────────────────────────

test('SQL 적용 + 재실행(멱등) + verify_rhythm.sql 전부 ok', async () => {
  const db = await freshDb();
  for (const f of APPLY) await db.exec(SQL(f)); // 두 번째 실행도 오류 없음
  const res = await db.exec(SQL('verify_rhythm.sql'));
  const checks = res[0].rows;
  assert.ok(checks.length >= 30, `checks ${checks.length}`);
  const failed = checks.filter(r => r.ok !== true);
  assert.deepEqual(failed, [], JSON.stringify(failed));
  assert.ok(!JSON.stringify(res).includes(SECRET), '검증 SQL 은 비밀값을 출력하지 않음');
});

test('적용 전후 profiles 정의 · 정책 · 데이터 변화 없음', async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(STUB);
  const a = await addMember(db, { nickname: '기존회원' });
  const snapshot = async () => JSON.stringify({
    policies: (await db.query("select policyname, cmd, roles, qual, with_check from pg_policies where tablename = 'profiles' order by policyname")).rows,
    cols: (await db.query("select column_name, data_type, is_nullable, column_default from information_schema.columns where table_name = 'profiles' order by column_name")).rows,
    grants: (await db.query("select grantee, privilege_type, column_name from information_schema.column_privileges where table_name = 'profiles' order by 1, 2, 3")).rows,
    triggers: (await db.query("select tgname from pg_trigger where tgrelid = 'public.profiles'::regclass and not tgisinternal order by 1")).rows,
    rls: (await db.query("select relrowsecurity from pg_class where oid = 'public.profiles'::regclass")).rows,
    data: (await db.query('select * from public.profiles order by id')).rows,
    users: (await db.query('select * from auth.users order by id')).rows,
  });
  const before = await snapshot();
  for (const f of APPLY) await db.exec(SQL(f));
  assert.equal(await snapshot(), before);
  await db.exec(SQL('rollback_rhythm.sql'));
  assert.equal(await snapshot(), before, 'rollback 후에도 그대로');
  assert.ok((await db.query('select id from public.profiles where id = $1', [a])).rows.length === 1);
});

test('미로그인/로그인 회원 모두 테이블에 직접 쓰기 불가 (user_id 위조 포함)', async () => {
  const db = await freshDb();
  const me = await addMember(db);
  const other = await addMember(db);
  const row = makeRow();
  const cols = Object.keys(row);
  const insert = uid => `insert into public.rhythm_play_records (user_id, ${cols.join(', ')}) values ('${uid}', ${cols.map(c => (typeof row[c] === 'string' ? `'${row[c]}'` : row[c])).join(', ')})`;
  await assert.rejects(as(db, 'anon', null, () => db.exec(insert(me))), /permission denied/);
  await assert.rejects(as(db, 'authenticated', me, () => db.exec(insert(me))), /permission denied/, '본인 user_id 라도 직접 INSERT 불가');
  await assert.rejects(as(db, 'authenticated', me, () => db.exec(insert(other))), /permission denied/, '다른 회원 user_id 위조 불가');
  await assert.rejects(as(db, 'authenticated', me, () => db.exec(
    `insert into public.rhythm_scores (user_id, song_id, difficulty, best_score, best_score_at, best_grade, best_accuracy, best_max_combo) values ('${me}', 'x1', 'hard', 999999, now(), 'S+', 100, 999)`)), /permission denied/);
  assert.equal((await db.query('select count(*)::int c from public.rhythm_play_records')).rows[0].c, 0);
});

test('다른 회원 기록 UPDATE / DELETE 불가, 비공개 스키마 접근 불가', async () => {
  const db = await freshDb();
  const me = await addMember(db);
  const other = await addMember(db);
  await submit(db, other, makeRow());
  for (const sql of [
    `update public.rhythm_scores set best_score = 1 where user_id = '${other}'`,
    `delete from public.rhythm_scores where user_id = '${other}'`,
    `update public.rhythm_play_records set score = 1 where user_id = '${other}'`,
    `delete from public.rhythm_play_records where user_id = '${other}'`,
    `update public.rhythm_play_records set score = 1 where user_id = '${me}'`,
    'select * from rhythm_private.settings',
    `insert into rhythm_private.used_nonces values ('${'0'.repeat(32)}', now())`,
  ]) {
    await assert.rejects(as(db, 'authenticated', me, () => db.exec(sql)), /permission denied/, sql);
  }
  assert.equal((await best(db, other)).best_score, 10000);
});

test('조회: 로그인 회원은 랭킹(최고 기록) 전체 + 본인 플레이 기록만, 비로그인은 불가', async () => {
  const db = await freshDb();
  const me = await addMember(db);
  const other = await addMember(db);
  await submit(db, me, makeRow());
  await submit(db, other, makeRow({ p: 9, g: 1 }));
  const scores = await as(db, 'authenticated', me, async () => (await db.query('select user_id from public.rhythm_scores')).rows);
  assert.equal(scores.length, 2);
  const records = await as(db, 'authenticated', me, async () => (await db.query('select user_id from public.rhythm_play_records')).rows);
  assert.deepEqual(records.map(r => r.user_id), [me]);
  await assert.rejects(as(db, 'anon', null, () => db.exec('select * from public.rhythm_scores')), /permission denied/);
  await assert.rejects(as(db, 'anon', null, () => db.exec('select * from public.rhythm_play_records')), /permission denied/);
});

test('서명: 올바른 서명만 저장, 위조/만료/재전송/다른 action/미등록 회원/비밀값 미설정 거절', async () => {
  const db = await freshDb();
  const me = await addMember(db);
  const ok = await submit(db, me, makeRow());
  assert.equal(ok.ranked, true);
  await assert.rejects(submit(db, me, makeRow(), { secret: 'wrong-secret-' + 'y'.repeat(40) }), /invalid signature/);
  await assert.rejects(submit(db, me, makeRow(), { ts: now() - 301 }), /request expired/);
  await assert.rejects(submit(db, me, makeRow(), { ts: now() + 301 }), /request expired/);
  await assert.rejects(submit(db, me, makeRow(), { action: 'ranking' }), /wrong action/);
  await assert.rejects(submit(db, randomUUID(), makeRow()), /unknown member/);
  const nonce = randomBytes(16).toString('hex');
  const ts = now();
  await submit(db, me, makeRow(), { nonce, ts });
  await assert.rejects(submit(db, me, makeRow(), { nonce, ts }), /replayed request/);
  // 서명된 payload 의 user_id 를 바꾸면 서명이 깨짐
  const { payload, signature } = sign({ action: 'submit', user_id: me, ts: now(), nonce: randomBytes(16).toString('hex'), record: makeRow() });
  const other = await addMember(db);
  const forged = payload.replace(me, other);
  await assert.rejects(as(db, 'anon', null, () => db.query('select public.rhythm_submit_play($1, $2)', [forged, signature])), /invalid signature/);
  assert.equal((await db.query('select count(*)::int c from public.rhythm_play_records where user_id = $1', [other])).rows[0].c, 0);

  const noSecret = await freshDb({ secret: null });
  const m2 = await addMember(noSecret);
  await assert.rejects(submit(noSecret, m2, makeRow()), /not configured/);
});

test('기록 정책 (shared fixture): CLEAR 만 최고 기록/랭킹, GAME_OVER · NO FAIL 은 플레이 기록만', async () => {
  const db = await freshDb();
  for (const c of POLICY.cases) {
    // 게임 JS 와 같은 판단인지 먼저
    const record = { status: c.status, noFail: c.noFail };
    const ctx = { autoplay: c.autoplay, preview: c.preview };
    assert.equal(isNormalClear(record, ctx), c.expect.bestRecord, `JS bestRecord: ${c.name}`);
    assert.equal(recentRecordSkipReason(record, ctx) === null, c.expect.sendOnline, `JS sendOnline: ${c.name}`);
    if (!c.expect.sendOnline) continue; // AUTO / PREVIEW 는 DB 로 가지 않음
    const uid = await addMember(db);
    const row = c.status === 'CLEAR'
      ? makeRow({ noFail: c.noFail })
      : c.status === 'GAME_OVER' ? makeRow({ status: 'GAME_OVER', p: 3, m: 10, total: 30, life: 0 }) : makeRow({ status: 'NO_FAIL_CLEAR', noFail: true, p: 15, m: 15, life: 0 });
    const r = await submit(db, uid, row);
    assert.equal(r.ranked, c.expect.ranking, `DB ranked: ${c.name}`);
    assert.equal(Boolean(await best(db, uid)), c.expect.bestRecord, `DB best: ${c.name}`);
    assert.equal((await db.query('select count(*)::int c from public.rhythm_play_records where user_id = $1', [uid])).rows[0].c, 1, `DB recent: ${c.name}`);
  }
});

test('최고 기록: upsert, 낮은 점수가 덮지 않음, 등급/정확도/콤보 각각 독립 갱신', async () => {
  const db = await freshDb();
  const me = await addMember(db);
  // 1) 첫 클리어: GREAT 위주 (B)
  let r = await submit(db, me, makeRow({ p: 0, g: 10 }));
  assert.deepEqual(r.improved, { score: true, grade: true, accuracy: true, max_combo: true });
  let b = await best(db, me);
  assert.deepEqual([b.best_score, b.best_grade, Number(b.best_accuracy), b.best_max_combo, b.clear_count], [7000, 'B', 80, 10, 1]);
  // 2) 점수만 더 높음 (콤보 보너스), 콤보/정확도는 같거나 낮음
  r = await submit(db, me, makeRow({ p: 0, g: 10, bonus: 500, combo: 5 }));
  assert.deepEqual(r.improved, { score: true, grade: false, accuracy: false, max_combo: false });
  // 3) 낮은 점수지만 정확도/등급 더 좋음 (총 노트 적은 곡이 아니라 같은 곡: GOOD 대신 PERFECT 섞인 판)
  r = await submit(db, me, makeRow({ p: 5, g: 0, gd: 0, m: 5, total: 10, combo: 5, life: 50 }));
  b = await best(db, me);
  assert.equal(b.best_score, 7500, '낮은 점수(5000)가 최고 점수를 덮지 않음');
  assert.equal(b.best_max_combo, 10);
  // 4) 정확도만 갱신: 9 PERFECT + 1 MISS (90%, A) → 등급 A 로, 정확도 90
  r = await submit(db, me, makeRow({ p: 9, m: 1, combo: 9 }));
  assert.deepEqual(r.improved, { score: true, grade: true, accuracy: true, max_combo: false });
  b = await best(db, me);
  assert.deepEqual([b.best_grade, Number(b.best_accuracy), b.best_max_combo], ['A', 90, 10]);
  // 5) 콤보만 갱신하는 판 (긴 판이지만 정확도 낮음)
  r = await submit(db, me, makeRow({ p: 0, g: 0, gd: 20, total: 20, combo: 20 }));
  assert.equal(r.improved.max_combo, true);
  assert.equal(r.improved.grade, false);
  b = await best(db, me);
  assert.deepEqual([b.best_score, b.best_grade, Number(b.best_accuracy), b.best_max_combo, b.clear_count], [9000, 'A', 90, 20, 5]);
  // GAME_OVER / NO FAIL 판은 더 높아도 반영 안 됨
  r = await submit(db, me, makeRow({ status: 'GAME_OVER', p: 25, m: 10, total: 60, bonus: 2000, combo: 25, life: 0 }));
  assert.equal(r.ranked, false);
  r = await submit(db, me, makeRow({ noFail: true, p: 30, bonus: 3000 }));
  assert.equal(r.ranked, false);
  b = await best(db, me);
  assert.deepEqual([b.best_score, b.best_max_combo, b.clear_count], [9000, 20, 5]);
  assert.equal((await db.query('select count(*)::int c from public.rhythm_play_records where user_id = $1', [me])).rows[0].c, 7);
});

test('DB 제약: 비정상 결과 값 거절', async () => {
  const db = await freshDb();
  const me = await addMember(db);
  const good = makeRow();
  const bad = {
    '음수 점수': { score: -1 },
    '점수 범위 초과 (콤보 보너스 최대보다 큼)': { score: 10 * 1100 + 1 },
    '점수 범위 미달': { score: 9999 },
    '정확도 100 초과': { accuracy: 100.5 },
    '정확도 불일치': { accuracy: 50 },
    '등급 불일치': { grade: 'A' },
    '허용되지 않은 난이도': { difficulty: 'insane' },
    '허용되지 않은 레인 수': { lane_count: 5 },
    'LIFE 범위 초과': { final_life: 101 },
    '판정 합계 > 총 노트': { perfect_count: 11 },
    'CLEAR 인데 판정 합계 부족': { total_notes: 11 },
    '최대 콤보 > 판정 수': { max_combo: 11 },
    'GAME_OVER 인데 LIFE 남음': { status: 'GAME_OVER', grade: 'F' },
    'CLEAR 인데 LIFE 0': { final_life: 0 },
    'NO_FAIL_CLEAR 인데 NO FAIL 아님': { status: 'NO_FAIL_CLEAR', final_life: 0 },
    '알 수 없는 상태': { status: 'AUTO' },
    '잘못된 곡 ID': { song_id: '../etc/passwd' },
    '배속 범위 밖': { note_speed: 10 },
    '노트 0개': { total_notes: 0, perfect_count: 0, score: 0, max_combo: 0 },
  };
  for (const [name, patch] of Object.entries(bad)) {
    await assert.rejects(submit(db, me, { ...good, ...patch }), /violates|invalid|out of range|null value|overflow/, name);
  }
  assert.equal((await db.query('select count(*)::int c from public.rhythm_play_records')).rows[0].c, 0);
  await submit(db, me, good); // 정상 값은 통과
});

test('등급 경계: DB grade_for == 게임 rankGrade (shared fixture)', async () => {
  const db = await freshDb();
  for (const [acc, status, expected] of POLICY.gradeBoundaries) {
    const sql = (await db.query('select rhythm_private.grade_for($1::numeric, $2) g', [acc, status])).rows[0].g;
    assert.equal(sql, expected, `SQL ${acc} ${status}`);
    assert.equal(rankGrade(acc, { gameOver: status === 'GAME_OVER' }), expected, `JS ${acc} ${status}`);
  }
});

test('랭킹: 회원당 최고 기록 1줄, 점수순 + 먼저 달성 순, 닉네임(비공개 숨김), 이메일/user_id 없음', async () => {
  const db = await freshDb();
  const a = await addMember(db, { nickname: '사용자A', email: 'a@private.example' });
  const b = await addMember(db, { nickname: '사용자B' });
  const c = await addMember(db, { nickname: '숨김회원', isPublic: false });
  const d = await addMember(db, { nickname: '사용자D' });
  await submit(db, a, makeRow({ p: 10, bonus: 1000 }));  // 11000
  await submit(db, a, makeRow({ p: 9, g: 1 }));          // 9700 (낮은 기록은 랭킹에 안 나옴)
  await submit(db, b, makeRow({ p: 10, bonus: 500 }));   // 10500
  await submit(db, c, makeRow({ p: 10 }));               // 10000
  await submit(db, d, makeRow({ p: 10 }));               // 10000 (c 보다 늦게)
  await submit(db, d, makeRow({ status: 'GAME_OVER', p: 30, m: 10, total: 60, bonus: 3000, life: 0 })); // 랭킹 영향 없음
  await submit(db, b, makeRow({ diff: 'easy', p: 10 }));  // 다른 난이도

  const rows = await rankingSigned(db, b, 'wony-cover-01', 'hard');
  assert.deepEqual(rows.map(r => [r.rank, r.nickname, r.best_score, r.is_me]),
    [[1, '사용자A', 11000, false], [2, '사용자B', 10500, true], [3, null, 10000, false], [4, '사용자D', 10000, false]]);
  const text = JSON.stringify(rows);
  assert.ok(!text.includes('a@private.example') && !text.includes(a), '이메일 · user_id 노출 없음');
  assert.deepEqual(Object.keys(rows[0]).sort(), ['achieved_at', 'avatar_url', 'best_accuracy', 'best_grade', 'best_max_combo', 'best_score', 'is_me', 'nickname', 'rank']);

  // 비공개 회원 본인에게는 자기 닉네임이 보임
  const asC = await rankingSigned(db, c, 'wony-cover-01', 'hard');
  assert.equal(asC.find(r => r.is_me).nickname, '숨김회원');
  // 상위 limit 밖이어도 본인 행 포함
  const top1 = await rankingSigned(db, d, 'wony-cover-01', 'hard', { limit: 1 });
  assert.deepEqual(top1.map(r => [r.rank, r.is_me]), [[1, false], [4, true]]);
  // 다른 난이도는 따로
  assert.deepEqual((await rankingSigned(db, a, 'wony-cover-01', 'easy')).map(r => r.nickname), ['사용자B']);

  // 로그인 회원 직접 조회 (WONY PHONE 용)
  const direct = await as(db, 'authenticated', a, async () => (await db.query("select * from public.rhythm_get_ranking('wony-cover-01', 'hard')")).rows);
  assert.deepEqual(direct.map(r => r.nickname), ['사용자A', '사용자B', null, '사용자D']);
  await assert.rejects(as(db, 'anon', null, () => db.query("select * from public.rhythm_get_ranking('wony-cover-01', 'hard')")), /permission denied/);
  // 서명 없는 랭킹 조회 불가
  await assert.rejects(as(db, 'anon', null, () => db.query("select public.rhythm_get_ranking_signed('{\"action\":\"ranking\"}', 'abc')")), /invalid signature/);
});

test('회원 탈퇴(profiles 삭제) 시 리듬 기록도 함께 삭제', async () => {
  const db = await freshDb();
  const me = await addMember(db);
  await submit(db, me, makeRow());
  await db.query('delete from auth.users where id = $1', [me]);
  assert.equal((await db.query('select count(*)::int c from public.rhythm_play_records')).rows[0].c, 0);
  assert.equal((await db.query('select count(*)::int c from public.rhythm_scores')).rows[0].c, 0);
});

test('rollback: 리듬 객체만 제거, 다시 적용 가능', async () => {
  const db = await freshDb();
  const me = await addMember(db, { nickname: '남아야 함' });
  await submit(db, me, makeRow());
  await db.exec(SQL('rollback_rhythm.sql'));
  const left = (await db.query(`select
      to_regclass('public.rhythm_scores') a, to_regclass('public.rhythm_play_records') b,
      to_regprocedure('public.rhythm_submit_play(text,text)') c, to_regprocedure('public.rhythm_get_ranking(text,text,integer,integer)') d,
      (select count(*)::int from pg_namespace where nspname = 'rhythm_private') e`)).rows[0];
  assert.deepEqual(left, { a: null, b: null, c: null, d: null, e: 0 });
  assert.equal((await db.query('select nickname from public.profiles where id = $1', [me])).rows[0].nickname, '남아야 함');
  assert.ok((await db.query("select 1 from pg_extension where extname = 'pgcrypto'")).rows.length === 1, 'pgcrypto 는 남김');
  for (const f of APPLY) await db.exec(SQL(f));
  await db.query("insert into rhythm_private.settings (key, value) values ('server_hmac_secret', $1)", [SECRET]);
  assert.equal((await submit(db, me, makeRow())).ranked, true);
});

test('005 템플릿 그대로 실행하면 실패 (실제 비밀값을 넣었는지 확인 장치)', async () => {
  const db = await freshDb({ secret: null });
  await assert.rejects(db.exec(SQL('005_rhythm_server_secret.TEMPLATE.sql')), /violates check constraint/);
});

// ── 006: play_id · 순위 변화 · 츄르 ─────────────────────────────────────────────
const CONFIG_JS = readFileSync(new URL('../../frontend-demo/js/config.js', import.meta.url), 'utf-8');
const wallet = async (db, uid) => (await db.query('select churu_balance from public.rhythm_wallet where user_id = $1', [uid])).rows[0]?.churu_balance ?? 0;
const count = async (db, table) => (await db.query(`select count(*)::int c from public.${table}`)).rows[0].c;

async function walletSigned(db, uid, { action = 'wallet' } = {}) {
  const { payload, signature } = sign({ action, user_id: uid, ts: now() });
  return as(db, 'anon', null, async () => (await db.query('select public.rhythm_get_wallet_signed($1, $2) as r', [payload, signature])).rows[0].r);
}

test('006 play_id: 같은 판을 여러 번 보내도 기록 1개 · 츄르 1번, 처음 결과를 그대로 돌려줌', async () => {
  const db = await freshDb();
  const me = await addMember(db);
  const row = makeRow({ diff: 'hard', p: 10 });
  const first = await submit(db, me, row);
  assert.equal(first.duplicate, false);
  assert.deepEqual(first.churu, { granted: true, amount: 4, balance_before: 0, balance_after: 4 });
  for (let i = 0; i < 3; i++) {
    const again = await submit(db, me, row);   // 새 nonce 로 재전송 (네트워크 재시도 · 새로고침)
    assert.equal(again.duplicate, true);
    assert.equal(again.record_id, first.record_id);
    assert.deepEqual(again.churu, first.churu, '같은 지급 결과를 다시 보여줄 뿐 추가 지급 없음');
    assert.equal(again.improved.score, false);
  }
  assert.equal(await count(db, 'rhythm_play_records'), 1);
  assert.equal(await count(db, 'rhythm_churu_ledger'), 1);
  assert.equal(await wallet(db, me), 4);
  assert.equal((await best(db, me)).clear_count, 1, '클리어 횟수도 1번만');
  // play_id 없음 / 형식 오류 거절
  const noPlay = { ...row };
  delete noPlay.play_id;
  await assert.rejects(submit(db, me, noPlay), /play_id is required/);
  await assert.rejects(submit(db, me, { ...row, play_id: 'not-a-uuid' }), /uuid/);
});

test('006 play_id: 다른 회원이 같은 play_id 로 보내면 거절 (남의 판 결과 · 츄르 조회 불가)', async () => {
  const db = await freshDb();
  const a = await addMember(db);
  const b = await addMember(db);
  const row = makeRow();
  await submit(db, a, row);
  await assert.rejects(submit(db, b, row), /belongs to another member/);
  assert.equal(await wallet(db, b), 0);
  assert.equal(await count(db, 'rhythm_play_records'), 1);
});

test('006 츄르: 정상 CLEAR 만 지급, 지급량은 DB 설정(난이도 × 곡별 배율 + 보너스)', async () => {
  const db = await freshDb();
  const me = await addMember(db);
  const expectBase = { easy: 1, normal: 2, hard: 4, hell: 7 };
  for (const [diff, amount] of Object.entries(expectBase)) {
    const r = await submit(db, me, makeRow({ diff }));
    assert.equal(r.churu.amount, amount, diff);
  }
  assert.equal(await wallet(db, me), 14);
  // 랭킹 제외 판: 기록은 남지만 츄르 없음 (같은 조건 함수 is_normal_clear)
  for (const c of POLICY.cases.filter(c => c.expect.sendOnline && !c.expect.ranking)) {
    const over = c.status === 'GAME_OVER';
    const r = await submit(db, me, makeRow({ status: c.status, noFail: c.noFail, p: 5, m: 5, life: over ? 0 : 40 }));
    assert.equal(r.ranked, false, c.name);
    assert.deepEqual(r.churu, { granted: false, amount: 0 }, c.name);
  }
  assert.equal(await wallet(db, me), 14);
  // 곡별 조정 (운영자가 SQL Editor 에서): round(4 × 1.5) + 2 = 8
  await db.query("insert into public.rhythm_song_rewards (song_id, multiplier, bonus) values ('event-song', 1.5, 2)");
  assert.equal((await submit(db, me, makeRow({ song: 'event-song', diff: 'hard' }))).churu.amount, 8);
  // 클라이언트가 보낸 지급량 · 잔액은 무시 (컬럼에 없는 값)
  const forged = await submit(db, me, { ...makeRow({ diff: 'easy' }), churu: 9999, churu_reward: 9999, churu_balance: 9999 });
  assert.equal(forged.churu.amount, 1);
  assert.equal(await wallet(db, me), 23);
  assert.equal((await walletSigned(db, me)).churu_balance, 23);
  // 지갑 조회도 서명 필요 · action 구분
  await assert.rejects(walletSigned(db, me, { action: 'ranking' }), /action/);
  assert.equal((await walletSigned(db, await addMember(db))).churu_balance, 0, '지갑이 없으면 0');
});

test('006 츄르: config.js CHURU_REWARDS 초기값 == DB rhythm_reward_rules', async () => {
  const db = await freshDb();
  const sql = Object.fromEntries((await db.query('select difficulty, base_churu from public.rhythm_reward_rules')).rows.map(r => [r.difficulty, r.base_churu]));
  const block = CONFIG_JS.match(/CHURU_REWARDS\s*=\s*Object\.freeze\(\{([^}]+)\}/)[1];
  const js = Object.fromEntries([...block.matchAll(/(\w+):\s*(\d+)/g)].map(m => [m[1], Number(m[2])]));
  assert.deepEqual(js, sql);
  assert.deepEqual(sql, { easy: 1, normal: 2, hard: 4, hell: 7 });
});

test('006 권한: 지갑 · 지급 기록 · 보상 설정에 앱이 직접 쓰기 불가, 지갑은 본인만 조회', async () => {
  const db = await freshDb();
  const a = await addMember(db);
  const b = await addMember(db);
  await submit(db, a, makeRow());
  await submit(db, b, makeRow());
  for (const role of ['anon', 'authenticated']) {
    const uid = role === 'anon' ? null : a;
    await assert.rejects(as(db, role, uid, () => db.exec(`update public.rhythm_wallet set churu_balance = 999 where user_id = '${a}'`)), /permission denied/);
    await assert.rejects(as(db, role, uid, () => db.exec(`insert into public.rhythm_wallet (user_id, churu_balance) values ('${a}', 999)`)), /permission denied/);
    await assert.rejects(as(db, role, uid, () => db.exec(`insert into public.rhythm_churu_ledger (user_id, play_id, amount, reason, balance_after) values ('${a}', gen_random_uuid(), 999, 'clear_reward', 999)`)), /permission denied/);
    await assert.rejects(as(db, role, uid, () => db.exec('update public.rhythm_reward_rules set base_churu = 999')), /permission denied/);
  }
  await assert.rejects(as(db, 'anon', null, () => db.query('select * from public.rhythm_wallet')), /permission denied/);
  const seen = await as(db, 'authenticated', a, async () => (await db.query('select user_id from public.rhythm_wallet')).rows);
  assert.deepEqual(seen.map(r => r.user_id), [a]);
  const ledger = await as(db, 'authenticated', a, async () => (await db.query('select user_id from public.rhythm_churu_ledger')).rows);
  assert.deepEqual(ledger.map(r => r.user_id), [a]);
  assert.equal(await wallet(db, a), 4);
});

test('006 순위 변화: 저장 전/후 순위 · 전체 인원 · 이전 최고 점수', async () => {
  const db = await freshDb();
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(await addMember(db, { nickname: `회원${i}` }));
  // 점수 109000, 108000, … 104000 → 순위 1~6 (콤보 보너스는 노트당 최대 100점이라 노트 100개)
  for (let i = 0; i < 6; i++) await submit(db, ids[i], makeRow({ p: 100, bonus: 9000 - i * 1000 }));
  const me = await addMember(db, { nickname: '나' });

  const firstEntry = await submit(db, me, makeRow({ p: 100, bonus: 4000 }));   // 104000: 동점이면 먼저 달성한 사람이 앞 → 7위
  assert.deepEqual([firstEntry.rank_before, firstEntry.rank_after, firstEntry.total_ranked, firstEntry.best_before], [null, 7, 7, null]);

  const up = await submit(db, me, makeRow({ p: 100, bonus: 7500 }));      // 107500 → 3위
  assert.deepEqual([up.rank_before, up.rank_after, up.best_before, up.best.best_score, up.improved.score], [7, 3, 104000, 107500, true]);

  const lower = await submit(db, me, makeRow({ p: 100, bonus: 100 }));    // 낮은 점수: 순위 유지 · 최고 점수 그대로
  assert.deepEqual([lower.rank_before, lower.rank_after, lower.improved.score], [3, 3, false]);

  const higherSameRank = await submit(db, me, makeRow({ p: 100, bonus: 7800 }));  // 107800: 점수만 갱신, 순위 유지
  assert.deepEqual([higherSameRank.rank_before, higherSameRank.rank_after, higherSameRank.improved.score], [3, 3, true]);

  const top = await submit(db, me, makeRow({ p: 100, bonus: 9500 }));     // 109500 → 1위
  assert.deepEqual([top.rank_before, top.rank_after], [3, 1]);

  const over = await submit(db, me, makeRow({ status: 'GAME_OVER', p: 3, m: 7, life: 0 }));
  assert.deepEqual([over.ranked, over.rank_after], [false, null], '랭킹 제외 판은 순위 변화 없음');
  // 다른 회원 순위는 밀려남
  assert.equal((await submit(db, ids[0], makeRow({ p: 1, m: 9, life: 40 }))).rank_before, 2);
});

test('006 랭킹 around: 상위 limit + 내 앞뒤 순위, 범위 제한(최대 5)', async () => {
  const db = await freshDb();
  const ids = [];
  for (let i = 0; i < 20; i++) {
    const id = await addMember(db, { nickname: `회원${i + 1}`, isPublic: i !== 10 });
    ids.push(id);
    await submit(db, id, makeRow({ p: 100, bonus: 9500 - i * 100 }));   // 순위 i + 1
  }
  const me = ids[11];  // 12위
  const ranks = async opts => (await rankingSigned(db, me, 'wony-cover-01', 'hard', opts)).map(r => r.rank);
  assert.deepEqual(await ranks({ limit: 3 }), [1, 2, 3, 12], 'around 없으면 기존과 같음 (상위 + 본인)');
  assert.deepEqual(await ranks({ limit: 3, around: 2 }), [1, 2, 3, 10, 11, 12, 13, 14]);
  assert.deepEqual(await ranks({ limit: 3, around: 99 }), [1, 2, 3, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17], '최대 5');
  assert.deepEqual(await ranks({ limit: 10, around: 2 }), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], '겹치면 1번만');
  const rows = await rankingSigned(db, me, 'wony-cover-01', 'hard', { limit: 3, around: 1 });
  assert.equal(rows.find(r => r.rank === 11).nickname, null, '주변 순위도 비공개 닉네임 숨김');
  assert.equal(rows.find(r => r.rank === 12).is_me, true);
  assert.ok(!JSON.stringify(rows).includes(ids[10]), 'user_id 노출 없음');
  // 기록 없는 회원: 상위 limit 만
  assert.deepEqual((await rankingSigned(db, await addMember(db), 'wony-cover-01', 'hard', { limit: 2, around: 3 })).map(r => r.rank), [1, 2]);
});

test('006 rollback: 지갑 · 지급 기록 · 보상 설정까지 제거, 다시 적용 가능', async () => {
  const db = await freshDb();
  const me = await addMember(db);
  await submit(db, me, makeRow());
  await db.exec(SQL('rollback_rhythm.sql'));
  const left = (await db.query(`select to_regclass('public.rhythm_wallet') a, to_regclass('public.rhythm_churu_ledger') b,
      to_regclass('public.rhythm_reward_rules') c, to_regclass('public.rhythm_song_rewards') d,
      to_regprocedure('public.rhythm_get_wallet_signed(text,text)') e`)).rows[0];
  assert.deepEqual(left, { a: null, b: null, c: null, d: null, e: null });
  for (const f of APPLY) await db.exec(SQL(f));
  await db.query("insert into rhythm_private.settings (key, value) values ('server_hmac_secret', $1)", [SECRET]);
  assert.equal((await submit(db, me, makeRow())).churu.amount, 4);
});

// ── 007: 내 기록 조회 (로그인 필수 정책: 기록은 DB 에서만) ──────────────────────────
async function myRecords(db, uid, { action = 'records' } = {}) {
  const { payload, signature } = sign({ action, user_id: uid, ts: now() });
  return as(db, 'anon', null, async () => (await db.query('select public.rhythm_get_my_records_signed($1, $2) as r', [payload, signature])).rows[0].r);
}

test('007 내 기록: 본인 최고 기록(정상 CLEAR) + 최근 플레이 20개, 다른 회원 · user_id 노출 없음', async () => {
  const db = await freshDb();
  const me = await addMember(db);
  const other = await addMember(db);
  await submit(db, me, makeRow({ diff: 'hard', p: 10 }));
  await submit(db, me, makeRow({ diff: 'hard', status: 'GAME_OVER', p: 3, m: 7, life: 0 }));
  await submit(db, me, makeRow({ diff: 'easy', noFail: true, p: 10 }));
  await submit(db, other, makeRow({ diff: 'hard', p: 10, bonus: 500 }));
  const r = await myRecords(db, me);
  assert.deepEqual(r.best.map(b => [b.song_id, b.difficulty, b.best_score, b.clear_count]), [['wony-cover-01', 'hard', 10000, 1]], 'GAME OVER · NO FAIL 은 최고 기록 아님');
  assert.deepEqual(r.recent.map(x => [x.difficulty, x.status, x.no_fail, x.ranked]),
    [['easy', 'CLEAR', true, false], ['hard', 'GAME_OVER', false, false], ['hard', 'CLEAR', false, true]], '최신 순');
  const text = JSON.stringify(r);
  assert.ok(!text.includes(me) && !text.includes(other) && !text.includes('play_id') && !text.includes('"id"'), 'user_id · 내부 id 없음');
  for (let i = 0; i < 25; i++) await submit(db, me, makeRow({ diff: 'normal', status: 'GAME_OVER', p: 3, m: 7, life: 0 }));
  assert.equal((await myRecords(db, me)).recent.length, 20);
  assert.deepEqual(await myRecords(db, await addMember(db)), { best: [], recent: [] });
  await assert.rejects(myRecords(db, me, { action: 'wallet' }), /action/);
  await assert.rejects(as(db, 'anon', null, () => db.query("select public.rhythm_get_my_records_signed('{\"action\":\"records\"}', 'x')")), /invalid signature/);
});

test('008 노트 배속: 1x ~ 6x 저장 가능, 범위 밖은 거절, 6/8키 기록도 따로', async () => {
  const db = await freshDb();
  const me = await addMember(db);
  for (const speed of [1, 1.5, 2, 3, 4, 6, 0.75]) {
    assert.equal((await submit(db, me, makeRow({ speed }))).ranked, true, `${speed}x`);
  }
  await assert.rejects(submit(db, me, makeRow({ speed: 6.5 })), /check constraint/);
  await submit(db, me, makeRow({ laneCount: 8, p: 10, bonus: 500 }));
  const lanes = (await db.query('select lane_count, best_score from public.rhythm_scores where user_id = $1 order by lane_count', [me])).rows;
  assert.deepEqual(lanes.map(r => r.lane_count), [4, 8], 'KEY 모드별 최고 기록 · 랭킹 따로');
});
