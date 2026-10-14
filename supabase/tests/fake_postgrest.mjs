// 테스트 전용 가짜 Supabase REST (PostgREST 의 /rest/v1/rpc/<함수> 만 흉내).
// PGlite(실제 Postgres)에 supabase/sql 001~004 + 006 + 007 을 적용하고, 요청을 anon 역할로 그 함수에 그대로 넘깁니다.
// → 브라우저 → WONY RHYTHM 서버 → HTTP → 실제 SQL 함수 전체 흐름을 운영 DB 없이 확인 (frontend-demo/tests/online-e2e.mjs)
//
//   node fake_postgrest.mjs --port 54399 --secret <RHYTHM_DB_SECRET> --members '[{"id":"…","nickname":"…"}]'
//   GET  /_test/state   테스트 확인용 (플레이 기록 · 최고 기록 · 지갑 · 츄르 지급 기록)
//   POST /_test/fail    {"on": true} 이면 모든 RPC 에 503 (장애 흉내)
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, a) => (v.startsWith('--') ? [...acc, [v.slice(2), a[i + 1]]] : acc), []));
const port = Number(args.port || 54399);
const SQL = name => readFileSync(new URL(`../sql/${name}`, import.meta.url), 'utf-8');

const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(readFileSync(new URL('./supabase_stub.sql', import.meta.url), 'utf-8'));
for (const f of ['001_rhythm_tables.sql', '002_rhythm_indexes.sql', '003_rhythm_functions.sql', '004_rhythm_rls.sql', '006_rhythm_play_id_and_churu.sql', '007_rhythm_my_records.sql']) await db.exec(SQL(f));
await db.query("insert into rhythm_private.settings (key, value) values ('server_hmac_secret', $1)", [args.secret]);
for (const m of JSON.parse(args.members || '[]')) {
  await db.query('insert into auth.users (id, email) values ($1, $2)', [m.id, `${m.id}@example.com`]);
  await db.query('insert into public.profiles (id, email, nickname, is_public) values ($1, $2, $3, $4)', [m.id, `${m.id}@example.com`, m.nickname, m.isPublic !== false]);
}

const ALLOWED = new Set(['rhythm_submit_play', 'rhythm_get_ranking_signed', 'rhythm_get_wallet_signed', 'rhythm_get_my_records_signed']);
let failing = false;
let queue = Promise.resolve(); // PGlite 는 연결 하나: 요청을 순서대로

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  let raw = '';
  req.on('data', c => (raw += c));
  req.on('end', () => {
    queue = queue.then(async () => {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/_test/state') {
        const records = (await db.query('select play_id, user_id, song_id, difficulty, status, no_fail, score, ranked from public.rhythm_play_records order by created_at')).rows;
        const scores = (await db.query('select user_id, song_id, difficulty, best_score, best_grade, clear_count from public.rhythm_scores')).rows;
        const wallets = (await db.query('select user_id, churu_balance from public.rhythm_wallet')).rows;
        const ledger = (await db.query('select user_id, play_id, amount, balance_after from public.rhythm_churu_ledger order by id')).rows;
        return send(res, 200, { records, scores, wallets, ledger });
      }
      if (url.pathname === '/_test/fail') {
        failing = JSON.parse(raw || '{}').on === true;
        return send(res, 200, { failing });
      }
      const fn = url.pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/)?.[1];
      if (req.method !== 'POST' || !ALLOWED.has(fn)) return send(res, 404, { message: 'not found' });
      if (!req.headers.apikey) return send(res, 401, { message: 'No API key found in request' });
      if (failing) return send(res, 503, { message: 'service unavailable' });
      const { p_payload: payload, p_signature: signature } = JSON.parse(raw || '{}');
      try {
        await db.exec('set role anon');
        const { rows } = await db.query(`select public.${fn}($1, $2) as r`, [payload, signature]);
        send(res, 200, rows[0].r);
      } catch (err) {
        // PostgREST 처럼: raise exception → 400 + SQLSTATE code
        send(res, 400, { code: err.code, message: err.message });
      } finally {
        await db.exec('reset role');
      }
    }).catch(err => send(res, 500, { message: String(err) }));
  });
}).listen(port, '127.0.0.1', () => console.log(`fake postgrest ready on ${port}`));
