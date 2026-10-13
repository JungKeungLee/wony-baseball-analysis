// 온라인 기록 전체 흐름 (운영 DB 없이): 브라우저 → WONY RHYTHM 서버(FastAPI) → HTTP → 실제 SQL 함수(PGlite)
//   WONY PHONE 입장권 → 로그인 → 실제 입력으로 CLEAR → 저장 · 순위 변화 · 츄르 / 같은 판 재전송(중복 없음) /
//   GAME OVER / AUTO / 비로그인 / Supabase 장애
// 실행: cd frontend-demo && CHROMIUM_PATH="<Edge 또는 Chrome>" node tests/online-e2e.mjs
//   (supabase/tests 에서 npm install 필요. 서버 두 개를 직접 띄우고 끝나면 종료)
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const PG_PORT = 54399;
const APP_PORT = 8767;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const LINK = 'e2e-link-' + randomBytes(24).toString('hex');
const DBS = 'e2e-db-' + randomBytes(24).toString('hex');
const A = { id: randomUUID(), nickname: '워니팬A' };
const B = { id: randomUUID(), nickname: '비공개B', isPublic: false };
const PYTHON = process.env.PYTHON || path.join(ROOT, '.venv', 'Scripts', 'python.exe');

function start(cmd, args, opts, readyText) {
  const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  return new Promise((resolve, reject) => {
    const onData = d => {
      log += d;
      if (log.includes(readyText)) resolve(child);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', code => reject(new Error(`${cmd} exited ${code}\n${log}`)));
    setTimeout(() => reject(new Error(`${cmd} not ready\n${log}`)), 60000);
  });
}

/** WONY PHONE server/rhythmLink.ts 와 같은 방식으로 서명한 입장권 */
function ticket(member) {
  const payload = { sub: member.id, role: 'user', name: member.nickname, aud: 'wony-rhythm', exp: Math.floor(Date.now() / 1000) + 60, nonce: randomBytes(16).toString('hex') };
  const body = `v1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${body}.${createHmac('sha256', LINK).update(body).digest('base64url')}`;
}

const pg = await start('node', ['fake_postgrest.mjs', '--port', String(PG_PORT), '--secret', DBS, '--members', JSON.stringify([A, B])],
  { cwd: path.join(ROOT, 'supabase', 'tests') }, 'fake postgrest ready');
const app = await start(PYTHON, ['-m', 'uvicorn', 'app.main:app', '--app-dir', 'backend', '--host', '127.0.0.1', '--port', String(APP_PORT)], {
  cwd: ROOT,
  env: { ...process.env, RHYTHM_LINK_SECRET: LINK, RHYTHM_DB_SECRET: DBS, SUPABASE_URL: `http://127.0.0.1:${PG_PORT}`,
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_e2e', WONY_PHONE_URL: 'https://phone.example/phone', WONY_AUTH_SECRET: '' },
}, 'Application startup complete');

const dbState = async () => (await fetch(`http://127.0.0.1:${PG_PORT}/_test/state`)).json();
const setDbFailing = on => fetch(`http://127.0.0.1:${PG_PORT}/_test/fail`, { method: 'POST', body: JSON.stringify({ on }) });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const results = [];
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    results.push(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    results.push(`  ✗ ${name}\n      ${String(err.message).split('\n').slice(0, 8).join('\n      ')}`);
  }
}

/** 실제 입력 경로(키보드 이벤트)로 채보를 따라 치는 봇: CLEAR 판을 만들기 위함 (자동 플레이 모드 아님) */
async function playByKeyboard(page, diff) {
  await page.goto(`${BASE}/game?song=demo-beat&diff=${diff}&debug=1`);
  await page.locator('#startBtn:not([disabled])').click();
  await page.evaluate(async d => {
    const chart = await (await fetch(`/songs/charts/demo-beat-${d}.json`)).json();
    const keys = ['ArrowLeft', 'ArrowDown', 'ArrowUp', 'ArrowRight'];
    let i = 0;
    (function tick() {
      const t = window.__wonyRhythm.snapshot().time;
      while (i < chart.notes.length && chart.notes[i].time <= t + 8) {
        const code = keys[chart.notes[i].lane];
        dispatchEvent(new KeyboardEvent('keydown', { code, key: code }));
        dispatchEvent(new KeyboardEvent('keyup', { code, key: code }));
        i++;
      }
      if (i < chart.notes.length) requestAnimationFrame(tick);
    })();
  }, diff);
}

async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  const apiCalls = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  page.on('request', r => { if (r.url().includes('/api/rhythm/')) apiCalls.push({ url: r.url().replace(BASE, ''), at: Date.now(), method: r.method() }); });
  return { context, page, errors, apiCalls };
}

const { context, page, errors, apiCalls } = await newPage();

await check('WONY PHONE 입장권으로 로그인 → 홈에 회원 표시', async () => {
  await page.goto(`${BASE}/rhythm-login?ticket=${encodeURIComponent(ticket(A))}&next=/`);
  assert.equal(new URL(page.url()).pathname, '/');
  await page.locator('#onlineText').waitFor();
  assert.match(await page.locator('#onlineText').textContent(), /워니팬A님/);
  assert.ok(await page.locator('#logoutBtn').isVisible());
});

await check('정상 CLEAR (실제 키 입력): 게임 중 API 호출 없음, 결과 1회 저장 → 최고 기록 · 랭킹 · 순위 변화 · 츄르', async () => {
  await playByKeyboard(page, 'easy');
  const startedAt = Date.now();
  await page.locator('#resultOverlay').waitFor({ state: 'visible', timeout: 90000 });
  const endedAt = Date.now();
  const s = await page.evaluate(() => window.__wonyRhythm.snapshot());
  assert.equal(s.resultStatus, 'CLEAR', JSON.stringify(s.counts));
  assert.equal(await page.locator('#resultTitle').textContent(), 'CLEAR!');
  await page.waitForFunction(() => /온라인 기록 저장 완료/.test(document.getElementById('resOnlineStatus').textContent), null, { timeout: 15000 });
  assert.match(await page.locator('#resOnlineStatus').textContent(), /랭킹 반영/);
  const during = apiCalls.filter(c => c.at > startedAt + 500 && c.at < endedAt - 500);
  assert.deepEqual(during, [], '플레이 중 서버 요청 없음');
  assert.equal(apiCalls.filter(c => c.url === '/api/rhythm/results').length, 1, '결과 저장은 1번');
  // 순위 변화 (DB 가 저장 전/후 순위를 같은 트랜잭션에서 계산) → 츄르 (DB 가 지급량 계산)
  await page.locator('#resRanking .ranking-row').first().waitFor();
  assert.equal(await page.locator('#resRankTransition').textContent(), '1위 / 1명');
  assert.deepEqual(await page.locator('#resRankBadges li').allTextContents(), ['첫 랭킹 진입!', '🎉 TOP 10 진입!', '👑 1위 달성!']);
  assert.equal(await page.locator('#resRankMedal').textContent(), '🥇');
  assert.equal(await page.locator('#resChuruTitle').textContent(), '🐟 EASY 클리어 보상');
  assert.equal(await page.locator('#resChuruAmount').textContent(), '+1 츄르');
  assert.equal(`${await page.locator('#resChuruFrom').textContent()} → ${await page.locator('#resChuruTo').textContent()}`, '0 → 1');
  assert.match(await page.locator('#resRanking .ranking-row.is-me').textContent(), /1위.*워니팬A/);
  assert.ok(apiCalls.some(c => c.url.startsWith('/api/rhythm/ranking') && c.url.includes('around=2')), '랭킹 미리보기 = 상위 + 내 주변');
  const db = await dbState();
  assert.equal(db.records.length, 1);
  assert.equal(db.records[0].user_id, A.id);
  assert.equal(db.records[0].ranked, true);
  assert.equal(db.records[0].play_id, s.playId, 'DB play_id = 게임 판 playId');
  assert.equal(db.scores.length, 1);
  assert.equal(db.scores[0].best_score, db.records[0].score);
  assert.deepEqual(db.wallets, [{ user_id: A.id, churu_balance: 1 }]);
  assert.deepEqual(db.ledger.map(l => [l.play_id, l.amount, l.balance_after]), [[s.playId, 1, 1]]);
});

await check('같은 판 재전송 (새로고침 · 재시도 흉내): 기록 · 츄르 중복 없음, 처음 결과 그대로', async () => {
  const replies = await page.evaluate(async () => {
    const { toRankingRow } = await import('/js/ranking.js');
    const local = JSON.parse(localStorage.getItem('wony_rhythm_results'))[0];
    const body = JSON.stringify(toRankingRow(local));
    const out = [];
    for (let i = 0; i < 3; i++) out.push(await (await fetch('/api/rhythm/results', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).json());
    return out;
  });
  for (const r of replies) {
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.duplicate, true);
    assert.deepEqual(r.churu, { granted: true, amount: 1, balanceBefore: 0, balanceAfter: 1 });
  }
  const db = await dbState();
  assert.equal(db.records.length, 1);
  assert.equal(db.ledger.length, 1);
  assert.equal(db.wallets[0].churu_balance, 1);
  // 클라이언트가 지급량 · 잔액을 보내면 서버가 거절
  const forged = await page.evaluate(async () => {
    const { toRankingRow } = await import('/js/ranking.js');
    const local = JSON.parse(localStorage.getItem('wony_rhythm_results'))[0];
    return (await fetch('/api/rhythm/results', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...toRankingRow(local), play_id: crypto.randomUUID(), churu: 999, churu_balance: 999 }) })).status;
  });
  assert.equal(forged, 422);
  assert.equal((await dbState()).wallets[0].churu_balance, 1);
  // 메인 화면 지갑: 서버 잔액
  await page.goto(`${BASE}/`);
  await page.locator('#walletBadge:not([hidden])').waitFor();
  assert.equal(await page.locator('#walletBadge').textContent(), '🐟 츄르 1');
});

await check('GAME_OVER: 온라인 플레이 기록만 (최고 기록 · 랭킹 · 츄르 제외)', async () => {
  await page.goto(`${BASE}/game?song=demo-beat&diff=hell&debug=1`);
  await page.locator('#startBtn:not([disabled])').click();
  await page.locator('#resultOverlay').waitFor({ state: 'visible', timeout: 40000 });
  await page.waitForFunction(() => /플레이 기록은 저장됨/.test(document.getElementById('resOnlineStatus').textContent), null, { timeout: 15000 });
  assert.equal(await page.locator('#resOnlineStatus').textContent(), 'GAME OVER 플레이는 온라인 랭킹에 반영되지 않습니다. (플레이 기록은 저장됨)');
  assert.ok(await page.locator('#resChuru').isHidden());
  const db = await dbState();
  assert.equal(db.records.length, 2);
  assert.equal(db.records[1].status, 'GAME_OVER');
  assert.equal(db.scores.length, 1, '최고 기록 늘지 않음');
  assert.equal(db.wallets[0].churu_balance, 1, '츄르 그대로');
});

await check('AUTO: 결과 화면이 떠도 서버로 보내지 않음', async () => {
  const before = apiCalls.filter(c => c.url === '/api/rhythm/results').length;
  await page.goto(`${BASE}/game?song=demo-beat&diff=easy&autoplay=1`);
  await page.locator('#startBtn:not([disabled])').click();
  await page.locator('#resultOverlay').waitFor({ state: 'visible', timeout: 90000 });
  await page.waitForTimeout(1000);
  assert.equal(apiCalls.filter(c => c.url === '/api/rhythm/results').length, before);
  assert.equal((await dbState()).records.length, 2);
  assert.equal(await page.locator('#resOnlineStatus').textContent(), '자동 플레이는 온라인 랭킹에 반영되지 않습니다.');
  assert.ok(await page.locator('#resChuru').isHidden());
  assert.equal((await dbState()).wallets[0].churu_balance, 1);
});

await check('곡 선택 화면: 온라인 랭킹 (펼칠 때만 요청), 비공개 회원은 닉네임 숨김', async () => {
  // B 회원(비공개)이 더 높은 점수로 클리어한 기록을 서버를 통해 추가
  const ctxB = await browser.newContext();
  const pB = await ctxB.newPage();
  await pB.goto(`${BASE}/rhythm-login?ticket=${encodeURIComponent(ticket(B))}`);
  const chartCount = (await (await fetch(`${BASE}/songs/charts/demo-beat-easy.json`)).json()).notes.length;
  const res = await pB.evaluate(async total => (await fetch('/api/rhythm/results', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    play_id: crypto.randomUUID(), song_id: 'demo-beat', difficulty: 'easy', lane_count: 4, note_speed: 1, status: 'CLEAR', no_fail: false, score: total * 1100, grade: 'S+', accuracy: 100,
    max_combo: total, perfect_count: total, great_count: 0, good_count: 0, miss_count: 0, total_notes: total, final_life: 100, result_version: 3,
  }) })).status, chartCount);
  assert.equal(res, 200);
  await ctxB.close();
  await page.goto(`${BASE}/songs`);
  await page.locator('#diffGroup label[data-diff="easy"]').click();
  const before = apiCalls.filter(c => c.url.startsWith('/api/rhythm/ranking')).length;
  await page.locator('#rankingPanel summary').click();
  await page.locator('#rankingBody .ranking-row').nth(1).waitFor();
  const rows = await page.locator('#rankingBody .ranking-row').allTextContents();
  assert.match(rows[0], /1위비공개 회원/);
  assert.match(rows[1], /2위워니팬A/);
  assert.equal(apiCalls.filter(c => c.url.startsWith('/api/rhythm/ranking')).length, before + 1);
  // 전체 랭킹 화면
  await page.goto(`${BASE}/ranking?song=demo-beat&diff=easy`);
  await page.locator('#rankingBody .ranking-row').nth(1).waitFor();
  assert.match((await page.locator('#rankingBody .ranking-row').allTextContents())[1], /2위워니팬A/);
  assert.equal((await dbState()).wallets.find(w => w.user_id === B.id).churu_balance, 1, 'B 도 서버를 통해 EASY 보상 1');
});

await check('Supabase 장애: 결과 화면 정상 + "로컬 기록은 정상" 안내, 로컬 최근 기록 저장', async () => {
  await setDbFailing(true);
  await page.goto(`${BASE}/game?song=demo-beat&diff=hell&debug=1`);
  await page.locator('#startBtn:not([disabled])').click();
  await page.locator('#resultOverlay').waitFor({ state: 'visible', timeout: 40000 });
  assert.equal(await page.locator('#resultTitle').textContent(), 'GAME OVER');
  // GAME OVER 판은 랭킹 제외 안내가 먼저, 저장 실패여도 결과 화면은 그대로
  await page.waitForTimeout(2500);
  assert.equal(await page.locator('#resOnlineStatus').textContent(), 'GAME OVER 플레이는 온라인 랭킹에 반영되지 않습니다.');
  const local = await page.evaluate(() => JSON.parse(localStorage.getItem('wony_rhythm_results')));
  assert.equal(local[0].status, 'GAME_OVER');
  await setDbFailing(false);
});

await check('로그아웃 후(비로그인): 저장 안 내고 안내만, 랭킹은 로그인 필요', async () => {
  await page.goto(`${BASE}/`);
  await page.locator('#logoutBtn').click();
  await page.locator('#loginLink').waitFor();
  assert.equal(await page.locator('#loginLink').getAttribute('href'), 'https://phone.example/phone');
  const before = (await dbState()).records.length;
  await page.goto(`${BASE}/game?song=demo-beat&diff=hell&debug=1`);
  await page.locator('#startBtn:not([disabled])').click();
  await page.locator('#resultOverlay').waitFor({ state: 'visible', timeout: 40000 });
  await page.waitForTimeout(1000);
  assert.equal(await page.locator('#resOnlineStatus').textContent(), 'GAME OVER 플레이는 온라인 랭킹에 반영되지 않습니다.');
  assert.equal((await dbState()).records.length, before);
  const r = await page.evaluate(async () => (await fetch('/api/rhythm/ranking?song=demo-beat&difficulty=easy')).status);
  assert.equal(r, 401);
});

await check('만료/재사용 입장권: 로그인 안 됨', async () => {
  const t = ticket(A);
  await page.goto(`${BASE}/rhythm-login?ticket=${encodeURIComponent(t)}`);
  await page.goto(`${BASE}/`);
  await page.locator('#logoutBtn').click();
  await page.locator('#loginLink').waitFor(); // 로그아웃 후 새로고침이 끝날 때까지 (그 전에 이동하면 새로고침이 이동을 끊음)
  await page.goto(`${BASE}/rhythm-login?ticket=${encodeURIComponent(t)}`);
  await page.locator('#onlineText').waitFor();
  assert.match(await page.locator('#onlineText').textContent(), /만료되었거나 이미 사용/);
});

await check('JS console error 없음', async () => {
  assert.deepEqual(errors.filter(e => !/status of (401|422|502)/.test(e)), []);
});

await context.close();
await browser.close();
app.kill();
pg.kill();
console.log(results.join('\n'));
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
