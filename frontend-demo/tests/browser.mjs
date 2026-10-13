// 브라우저 테스트 (Playwright). 서버를 먼저 띄운 뒤 실행:
//   cd backend && python -m uvicorn app.main:app --port 8765
//   cd frontend-demo && WONY_BASE_URL=http://127.0.0.1:8765 CHROMIUM_PATH="<Chrome 또는 Edge 경로>" node tests/browser.mjs
// MP4(H.264/AAC)를 재생해야 하므로 Playwright 기본 Chromium(코덱 없음) 대신 Chrome/Edge 실행 파일을 지정한다.
// FULL_SONG=1 이면 데모곡 EASY 를 끝까지 자동 플레이해 결과 화면까지 확인한다 (약 45초).
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const BASE = process.env.WONY_BASE_URL || 'http://127.0.0.1:8765';
const SONG = process.env.WONY_SONG || 'demo-beat';
const VIEWPORTS = [
  { name: '390 portrait', width: 390, height: 844, mobile: true },
  { name: '844x390 landscape', width: 844, height: 390, mobile: true },
  { name: '768 tablet', width: 768, height: 1024, mobile: true },
  { name: '1440 desktop', width: 1440, height: 900, mobile: false },
];

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
let failures = 0;
const results = [];

async function check(name, fn) {
  try {
    await fn();
    results.push(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    results.push(`  ✗ ${name}\n      ${String(err.message).split('\n').slice(0, 14).join('\n      ')}`);
  }
}

async function newPage(vp) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height }, isMobile: vp.mobile, hasTouch: vp.mobile, deviceScaleFactor: vp.mobile ? 3 : 1,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  return { context, page, errors };
}

const noHorizontalScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
const snap = page => page.evaluate(() => window.__wonyRhythm.snapshot());
const box = (page, sel) => page.locator(sel).first().boundingBox();
const overlaps = (a, b) => a && b && a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;

async function smallTargets(page) {
  return page.evaluate(() => [...document.querySelectorAll('a, button, select, input')]
    .filter(el => el.offsetParent !== null && !el.closest('[hidden]'))
    .map(el => {
      const target = el.tagName === 'INPUT' && el.closest('label') ? el.closest('label') : el; // 체크박스/라디오는 label 전체가 터치 영역
      const r = target.getBoundingClientRect();
      return { el: el.id || el.className || el.tagName, h: r.height, w: r.width };
    })
    .filter(r => r.h < 44 || r.w < 44));
}

/**
 * 결과 화면 온라인 영역을 실제 모듈(result-online.js)로 실행 (서버 응답만 가짜). 게임 화면의 결과 오버레이에 그린다.
 * mode: 'member' (로그인 회원, 서버가 순위 · 츄르 결과를 돌려줌) | 'guest' (비로그인 → 이 기기 지갑) | 'fail' (서버 장애)
 */
async function runResultDemo(page, mode, { reducedMotion = false, playId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' } = {}) {
  return page.evaluate(async ({ mode, reducedMotion, playId }) => {
    const { runResultOnline } = await import('/js/result-online.js');
    const { grantLocalReward } = await import('/js/wallet.js');
    const $ = id => document.getElementById(id);
    for (const id of ['readyOverlay', 'pauseOverlay', 'errorOverlay']) $(id).hidden = true;
    $('resultOverlay').hidden = false;
    const record = {
      playId, schema: 3, status: 'CLEAR', songId: 'demo-beat', difficulty: 'hard', laneCount: 4, noteSpeed: 1, score: 2000,
      maxCombo: 2, perfect: 2, great: 0, good: 0, miss: 0, totalNotes: 2, accuracy: 100, life: 100, grade: 'S+', noFail: false,
    };
    const calls = [];
    const deps = {
      grantLocalReward,
      submitRanking: async () => {
        calls.push('submit');
        if (mode === 'fail') return { submitted: false, reason: 'failed' };
        return {
          submitted: true, ranked: true, duplicate: false, rankBefore: 12, rankAfter: 7, totalRanked: 40, bestBefore: 1000,
          improved: { score: true }, churu: { granted: true, amount: 4, balanceBefore: 26, balanceAfter: 30 },
        };
      },
      loadRanking: async (song, diff, opts) => {
        calls.push(`ranking:${opts.limit}:${opts.around}`);
        return { ok: true, rows: [
          { rank: 1, nickname: '사용자A', bestGrade: 'S+', bestScore: 9000, isMe: false },
          { rank: 2, nickname: '사용자B', bestGrade: 'S+', bestScore: 8000, isMe: false },
          { rank: 3, nickname: null, bestGrade: 'S', bestScore: 7000, isMe: false },
          { rank: 6, nickname: '사용자F', bestGrade: 'A', bestScore: 2100, isMe: false },
          { rank: 7, nickname: '워니팬', bestGrade: 'S+', bestScore: 2000, isMe: true },
          { rank: 8, nickname: '사용자H', bestGrade: 'B', bestScore: 1900, isMe: false },
        ] };
      },
    };
    const online = Promise.resolve(mode === 'guest' ? { onlineEnabled: true, loggedIn: false } : { onlineEnabled: true, loggedIn: true, churuBalance: 26 });
    const els = {
      box: $('resOnline'), status: $('resOnlineStatus'), change: $('resRankChange'), medal: $('resRankMedal'),
      transition: $('resRankTransition'), delta: $('resRankDelta'), badges: $('resRankBadges'), ranking: $('resRanking'),
      fullRanking: $('resFullRanking'), churu: $('resChuru'), churuTitle: $('resChuruTitle'), churuAmount: $('resChuruAmount'),
      churuFrom: $('resChuruFrom'), churuTo: $('resChuruTo'), churuNote: $('resChuruNote'),
    };
    // 연출 중간값 확인용: 순위 숫자가 처음 바뀐 시점 기록
    const seen = new Set();
    const mo = new MutationObserver(() => seen.add($('resRankTransition').textContent));
    mo.observe($('resRankTransition'), { childList: true, subtree: true, characterData: true });
    const t0 = performance.now();
    const out = await runResultOnline({ record, context: {}, els, online, deps, reducedMotion, rankingHref: '/ranking?song=demo-beat&diff=hard' });
    mo.disconnect();
    return { stage: out.stage, ms: performance.now() - t0, calls, seen: [...seen] };
  }, { mode, reducedMotion, playId });
}

async function startGame(page, query) {
  await page.goto(`${BASE}/game?song=${SONG}&${query}`);
  await page.locator('#startBtn:not([disabled])').waitFor({ timeout: 10000 });
  await page.locator('#startBtn').click();
}

for (const vp of VIEWPORTS) {
  results.push(`\n[${vp.name}]`);
  const { context, page, errors } = await newPage(vp);

  for (const path of ['/', '/songs', '/settings', '/scores', '/ranking', '/shop']) {
    await check(`${path}: 가로 스크롤 없음, 버튼 44px 이상`, async () => {
      await page.goto(BASE + path);
      await page.waitForLoadState('networkidle');
      assert.ok(await noHorizontalScroll(page), 'horizontal scroll');
      assert.deepEqual(await smallTargets(page), []);
    });
  }

  await check('메인: 🐟 츄르 + 메뉴 순서 (게임 시작 · 곡 선택 · 랭킹 · 스킨 상점 · 최고 기록 · 설정)', async () => {
    await page.goto(`${BASE}/`);
    await page.locator('#walletBadge:not([hidden])').waitFor();
    assert.equal(await page.locator('#walletBadge').textContent(), '🐟 츄르 0');
    const menu = await page.locator('.menu .menu-item > span:not(.menu-icon)').evaluateAll(els => els.map(e => e.firstChild.textContent.trim()));
    assert.deepEqual(menu, ['게임 시작', '곡 선택', '랭킹', '스킨 상점', '최고 기록', '설정']);
    const badge = await box(page, '#walletBadge');
    const menuBox = await box(page, '.menu');
    assert.ok(badge.y < menuBox.y, '츄르는 메뉴 위');
  });

  await check('스킨 상점: 준비 중 화면만 (상품 · 구매 버튼 없음), 보유 츄르 · 뒤로가기', async () => {
    await page.goto(`${BASE}/shop`);
    await page.locator('#walletBadge:not([hidden])').waitFor();
    assert.equal(await page.locator('#walletBadge').textContent(), '🐟 츄르 0');
    const text = await page.locator('#shopSoon').textContent();
    for (const t of ['스킨 상점은 준비 중입니다.', '다양한 UI 스킨과 리듬 바 스킨이 추가될 예정입니다.', 'Coming Soon ✨']) assert.ok(text.includes(t), t);
    assert.equal(await page.locator('main button').count(), 0, '구매 버튼 없음');
    assert.equal(await page.locator('main a', { hasText: /구매/ }).count(), 0);
    assert.equal(await page.locator('#shopBack').textContent(), '뒤로가기');
    assert.ok(await noHorizontalScroll(page));
  });

  await check('설정: 스킨 기본값 (기본 UI · 기본 리듬 바만, 독립 선택)', async () => {
    await page.goto(`${BASE}/settings`);
    assert.deepEqual(await page.locator('#uiSkin option').allTextContents(), ['기본 UI']);
    assert.deepEqual(await page.locator('#rhythmSkin option').allTextContents(), ['기본 리듬 바']);
    assert.equal(await page.locator('#uiSkin').inputValue(), 'default-ui');
    assert.equal(await page.locator('#rhythmSkin').inputValue(), 'default-rhythm');
    assert.equal(await page.locator('h1').textContent(), '설정');
  });

  await check('결과 화면 (로그인 회원): 결과 → 순위 변화 연출 → 츄르, 랭킹 미리보기 · 버튼, 화면 안에 들어옴', async () => {
    await page.goto(`${BASE}/game?song=${SONG}&diff=hard&debug=1`);
    await page.locator('#startBtn').waitFor();
    const run = await runResultDemo(page, 'member');
    assert.equal(run.stage, 'done');
    assert.deepEqual(run.calls, ['submit', 'ranking:3:2'], '저장 1번 → 상위 3 + 내 앞뒤 2명');
    assert.ok(run.ms >= 800 && run.ms < 4000, `연출 시간 ${run.ms}`);
    assert.ok(run.seen.some(t => /^12위 → (1[01]|[89])위$/.test(t)), `중간 순위 표시 ${run.seen}`);
    assert.equal(await page.locator('#resRankTransition').textContent(), '12위 → 7위');
    assert.equal(await page.locator('#resRankDelta').textContent(), '▲ 5단계 상승!');
    assert.deepEqual(await page.locator('#resRankBadges li').allTextContents(), ['🎉 TOP 10 진입!']);
    assert.equal(await page.locator('#resChuruTitle').textContent(), '🐟 HARD 클리어 보상');
    assert.equal(await page.locator('#resChuruAmount').textContent(), '+4 츄르');
    assert.equal(await page.locator('#resChuruFrom').textContent(), '26');
    assert.equal(await page.locator('#resChuruTo').textContent(), '30');
    assert.match(await page.locator('#resOnlineTitle').textContent(), /🏆 ONLINE RANKING/);
    assert.equal(await page.locator('#resRanking .ranking-row').count(), 6);
    assert.match(await page.locator('#resRanking .ranking-row.is-me').textContent(), /7위.*워니팬/);
    assert.equal(await page.locator('#resFullRanking').getAttribute('href'), '/ranking?song=demo-beat&diff=hard');
    // 순서: 결과 → 랭킹 → 츄르 → 버튼
    const [stats, online, churu, actions] = [await box(page, '#resultOverlay .stat-grid'), await box(page, '#resOnline'), await box(page, '#resChuru'), await box(page, '#resultOverlay .actions')];
    assert.ok(stats.y < online.y && online.y < churu.y && churu.y < actions.y, '표시 순서');
    assert.deepEqual(await page.locator('#resultOverlay .actions .btn').allTextContents(), ['↺ 다시 하기', '🏆 전체 랭킹', '🎨 스킨 상점', '곡 선택']);
    assert.ok(await noHorizontalScroll(page));
    const panel = await box(page, '#resultOverlay .panel');
    assert.ok(panel.x >= 0 && panel.x + panel.width <= vp.width + 1, 'result panel inside viewport');
    const small = (await smallTargets(page)).filter(t => t.el !== 'startBtn');
    assert.deepEqual(small, []);
    const rowsFit = await page.locator('#resRanking .ranking-row').evaluateAll(els => els.every(e => e.scrollWidth <= e.clientWidth + 1));
    assert.ok(rowsFit, '랭킹 줄이 잘리지 않음');
  });

  await check('결과 화면: 동작 줄이기(reduced motion)면 순위 · 츄르 연출 없이 바로 최종값', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${BASE}/game?song=${SONG}&diff=hard&debug=1`);
    await page.locator('#startBtn').waitFor();
    const run = await runResultDemo(page, 'member', { reducedMotion: await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches) });
    assert.ok(run.ms < 500, `즉시 ${run.ms}`);
    assert.ok(!run.seen.some(t => /^12위 → (1[01]|[89])위$/.test(t)), `중간값 없음 ${run.seen}`);
    assert.equal(await page.locator('#resRankTransition').textContent(), '12위 → 7위');
    assert.equal(await page.locator('#resChuruTo').textContent(), '30');
    assert.equal(await page.locator('#resRankChange').evaluate(el => el.classList.contains('is-animated')), false);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  });

  await check('결과 화면 (비로그인): 이 기기 지갑에 1번만 지급, 같은 판 다시 처리해도 그대로', async () => {
    await page.goto(`${BASE}/game?song=${SONG}&diff=hard&debug=1`);
    await page.locator('#startBtn').waitFor();
    await page.evaluate(() => localStorage.clear());
    const first = await runResultDemo(page, 'guest', { reducedMotion: true });
    assert.equal(first.stage, 'guest');
    assert.deepEqual(first.calls, [], '비로그인은 서버 요청 없음');
    assert.match(await page.locator('#resOnlineStatus').textContent(), /로그인하지 않아/);
    assert.equal(await page.locator('#resChuruAmount').textContent(), '+4 츄르');
    assert.equal(`${await page.locator('#resChuruFrom').textContent()}→${await page.locator('#resChuruTo').textContent()}`, '0→4');
    await runResultDemo(page, 'guest', { reducedMotion: true });
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('wonyRhythm.wallet.v1')).balance), 4, '같은 playId 는 1번만');
    await page.goto(`${BASE}/`);
    await page.locator('#walletBadge:not([hidden])').waitFor();
    assert.equal(await page.locator('#walletBadge').textContent(), '🐟 츄르 4');
    await page.evaluate(() => localStorage.clear());
  });

  await check('결과 화면 (서버 장애): 결과 · 로컬 기록은 그대로, 온라인 · 츄르 실패 안내', async () => {
    await page.goto(`${BASE}/game?song=${SONG}&diff=hard&debug=1`);
    await page.locator('#startBtn').waitFor();
    const run = await runResultDemo(page, 'fail', { reducedMotion: true });
    assert.equal(run.stage, 'failed');
    assert.equal(await page.locator('#resOnlineStatus').textContent(), '온라인 기록을 불러오지 못했습니다. 로컬 기록은 정상적으로 저장되었습니다.');
    assert.equal(await page.locator('#resChuruNote').textContent(), '츄르 보상 처리에 실패했습니다.');
    assert.ok(await page.locator('#resRankChange').isHidden());
    assert.ok(await page.locator('#retryBtn').isEnabled());
  });

  await check('곡 선택: cover 만 로드 (MP4 요청 없음), 곡 → 난이도 → 배속 → 영상 → 시작', async () => {
    const mp4 = [];
    page.on('request', r => { if (r.url().endsWith('.mp4')) mp4.push(r.url()); });
    await page.goto(`${BASE}/songs`);
    await page.waitForLoadState('networkidle');
    assert.deepEqual(mp4, [], '곡 선택 화면에서 영상 preload 금지');
    await page.locator(`.song-card[data-song="${SONG}"]`).click();
    await page.locator('#diffGroup label[data-diff="hard"]').click();
    await page.locator('#speedGroup label', { hasText: '1.75x' }).click();
    await page.locator('#videoOn').uncheck();
    assert.ok(await noHorizontalScroll(page));
    await page.locator('#playBtn').click();
    await page.waitForURL(/\/game\?/);
    assert.match(page.url(), new RegExp(`song=${SONG}&diff=hard`));
    await page.locator('#readySpeed').waitFor();
    assert.equal(await page.locator('#readySpeed').textContent(), '1.75x');
    assert.equal(await page.locator('#readyVideo').textContent(), 'OFF');
    assert.equal(await page.locator('#readyDiff').textContent(), 'HARD');
    // 다음 테스트를 위해 기본값으로
    await page.evaluate(() => localStorage.clear());
  });

  await check('게임: 카운트다운 후 video.currentTime 과 게임 시간 동기화, playbackRate 1.0', async () => {
    await startGame(page, 'diff=normal&autoplay=1');
    const first = await snap(page);
    assert.equal(first.phase, 'playing');
    assert.ok(first.time < 0, `countdown ${first.time}`);
    await page.waitForFunction(() => window.__wonyRhythm.snapshot().combo >= 6, null, { timeout: 20000 });
    for (let i = 0; i < 5; i++) {
      const s = await snap(page);
      assert.ok(Math.abs(s.time - s.videoTime) <= 60, `game ${s.time} vs video ${s.videoTime}`);
      assert.equal(s.playbackRate, 1);
      assert.equal(s.videoPaused, false);
      await page.waitForTimeout(150);
    }
    const s = await snap(page);
    assert.deepEqual([s.counts.GREAT, s.counts.GOOD, s.counts.MISS], [0, 0, 0], JSON.stringify(s.counts));
  });

  await check('게임: 영상 / 4레인 / 터치 버튼이 겹치거나 잘리지 않음', async () => {
    assert.ok(await noHorizontalScroll(page));
    const [hud, video, stage] = [await box(page, '.hud'), await box(page, '#videoPanel'), await box(page, '#stage')];
    const touchVisible = await page.locator('#touch').isVisible();
    assert.equal(touchVisible, vp.mobile, 'touch controls only on touch devices');
    assert.ok(video && video.width > 50 && video.height > 50, 'video visible');
    assert.ok(!overlaps(video, stage), 'video/stage overlap');
    assert.ok(!overlaps(hud, video) && !overlaps(hud, stage), 'hud overlap');
    assert.ok(stage.height >= 150, `stage height ${stage.height}`);
    // 게임 영역이 화면 폭을 넘지 않음 (overflow:hidden 이라 스크롤 검사로는 안 잡힘: 영상 비율 때문에 넓어지던 버그)
    for (const sel of ['.arena', '#stage', '#videoPanel']) {
      const r = await box(page, sel);
      assert.ok(r.x >= -1 && r.x + r.width <= vp.width + 1, `${sel} 가 화면 밖으로 나감: ${JSON.stringify(r)}`);
    }
    const sideBySide = vp.width >= 900 || vp.height <= 500;
    if (sideBySide) {
      assert.ok(video.x + video.width <= stage.x + 1, '왼쪽 영상, 오른쪽 게임');
      const share = video.width / vp.width;
      assert.ok(share > 0.35 && share < 0.48, `video share ${share}`);
    } else {
      assert.ok(video.y + video.height <= stage.y + 1, '위 영상, 아래 게임');
      assert.ok(stage.height > video.height, '영상 때문에 게임 영역이 너무 작아지지 않음');
    }
    // 영상 비율 유지
    const ratio = await page.evaluate(() => {
      const v = document.getElementById('video');
      return { media: v.videoWidth / v.videoHeight, fit: getComputedStyle(v).objectFit };
    });
    assert.equal(ratio.fit, 'contain');
    if (touchVisible) {
      const touch = await box(page, '#touch');
      assert.ok(!overlaps(touch, stage) && !overlaps(touch, video), 'touch overlap');
      assert.ok(touch.y + touch.height <= vp.height + 1, 'touch inside viewport');
      const buttons = await page.locator('.lane-btn').evaluateAll(els => els.map(e => e.getBoundingClientRect().toJSON()));
      for (let i = 0; i < buttons.length; i++) {
        assert.ok(buttons[i].height >= 56, `lane button height ${buttons[i].height}`);
        assert.ok(buttons[i].right <= vp.width + 1, `lane button ${i} 오른쪽 잘림 ${buttons[i].right}`);
        if (i) assert.ok(buttons[i].left >= buttons[i - 1].right, 'lane buttons overlap');
      }
    }
  });

  if (vp.name.includes('portrait')) {
    await check('회전(세로→가로→세로) 후 점수/콤보/영상 위치 유지', async () => {
      const before = await snap(page);
      await page.setViewportSize({ width: 844, height: 390 });
      await page.waitForTimeout(400);
      const mid = await snap(page);
      assert.equal(mid.phase, 'playing');
      assert.ok(mid.layout.landscape, 'layout recomputed');
      assert.ok(mid.score >= before.score && mid.judged >= before.judged && mid.time > before.time, JSON.stringify({ before, mid }));
      assert.ok(Math.abs(mid.time - mid.videoTime) <= 60);
      const [video, stage] = [await box(page, '#videoPanel'), await box(page, '#stage')];
      assert.ok(video.x + video.width <= stage.x + 1, '가로: 왼쪽 영상');
      assert.ok(await noHorizontalScroll(page));
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(300);
      const after = await snap(page);
      assert.ok(!after.layout.landscape && after.score >= mid.score && after.time > mid.time);
    });

    await check('멀티터치: 1+4 레인 동시, 한 손가락을 떼도 다른 쪽 유지', async () => {
      const cdp = await context.newCDPSession(page);
      const centers = await page.locator('.lane-btn').evaluateAll(els => els.map(e => {
        const r = e.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }));
      const point = (i, id) => ({ x: centers[i].x, y: centers[i].y, id });
      const pressed = () => page.locator('.lane-btn').evaluateAll(els => els.map(e => e.classList.contains('is-pressed')));
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(0, 1), point(3, 2)] });
      assert.deepEqual(await pressed(), [true, false, false, true]);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(1, 3), point(2, 4)] });
      assert.deepEqual(await pressed(), [false, true, true, false]);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const fire = (lane, type, pointerId) => page.locator('.lane-btn').nth(lane).evaluate((el, a) => el.dispatchEvent(
        new PointerEvent(a.type, { pointerId: a.pointerId, pointerType: 'touch', isPrimary: false, bubbles: true, cancelable: true })), { type, pointerId });
      await fire(0, 'pointerdown', 71);
      await fire(3, 'pointerdown', 72);
      await fire(3, 'pointerup', 72);
      assert.deepEqual(await pressed(), [true, false, false, false]);
      await fire(0, 'pointercancel', 71);
      assert.deepEqual(await pressed(), [false, false, false, false]);
    });
  }

  await check('플레이 중 영상 위치 이동(seek) 금지', async () => {
    const s = await snap(page);
    await page.evaluate(() => { const v = document.getElementById('video'); v.currentTime = v.currentTime + 15; });
    await page.waitForTimeout(400);
    const after = await snap(page);
    assert.ok(after.videoTime < s.videoTime + 1500, `seek reverted: ${s.videoTime} → ${after.videoTime}`);
    assert.ok(Math.abs(after.time - after.videoTime) <= 60);
  });

  await check('일시정지: video.pause() + 노트 정지 → 같은 위치에서 재개', async () => {
    await page.locator('#pauseBtn').click();
    const a = await snap(page);
    await page.waitForTimeout(600);
    const b = await snap(page);
    assert.equal(a.phase, 'paused');
    assert.equal(b.videoPaused, true);
    assert.equal(b.time, a.time, 'time frozen');
    assert.ok(Math.abs(b.videoTime - a.videoTime) < 1, 'video frozen');
    assert.equal(b.judged, a.judged);
    await page.locator('#resumeBtn').click();
    await page.waitForTimeout(500);
    const c = await snap(page);
    assert.equal(c.phase, 'playing');
    assert.equal(c.videoPaused, false);
    assert.ok(c.time > a.time && c.time < a.time + 1500, `resumed near ${a.time}: ${c.time}`);
    assert.ok(Math.abs(c.time - c.videoTime) <= 60, 'resume 후 싱크');
  });

  await check('영상 OFF: 화면에서만 숨김, video 는 계속 재생 (음악/시계 진행)', async () => {
    await page.locator('#pauseBtn').click();
    await page.locator('#videoToggle').uncheck();
    await page.locator('#resumeBtn').click();
    const a = await snap(page);
    await page.waitForTimeout(700);
    const b = await snap(page);
    assert.equal(await page.locator('#videoPanel').isVisible(), false);
    assert.equal(b.videoPaused, false);
    assert.ok(b.videoTime > a.videoTime + 400, `video keeps playing ${a.videoTime} → ${b.videoTime}`);
    assert.ok(b.judged > a.judged || b.time > a.time);
    const stage = await box(page, '#stage');
    assert.ok(stage.width >= vp.width - 2 || !vp.mobile || vp.height > 500, '영상 OFF 면 게임이 넓어짐');
    assert.ok(await noHorizontalScroll(page));
    await page.locator('#pauseBtn').click();
    await page.locator('#videoToggle').check();
    await page.locator('#resumeBtn').click();
    assert.ok(await page.locator('#videoPanel').isVisible());
  });

  await check('앱 이탈(visibilitychange) 시 자동 일시정지, 돌아와도 자동 재생 안 함', async () => {
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    assert.equal((await snap(page)).phase, 'paused');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(300);
    const s = await snap(page);
    assert.equal(s.phase, 'paused');
    assert.equal(s.videoPaused, true);
    assert.ok(await page.locator('#resumeBtn').isVisible());
  });

  await check('HUD: LIFE 게이지 표시, 곡 제목/점수와 겹치지 않음', async () => {
    const [song, life, score] = [await box(page, '.hud-song'), await box(page, '#lifeMeter'), await box(page, '.hud-score')];
    assert.ok(life && life.width > 40, 'life meter visible');
    assert.ok(!overlaps(song, life) && !overlaps(life, score), 'hud overlap');
    assert.match(await page.locator('#lifeNum').textContent(), /^\d+$/);
  });

  await check('LIFE 0 → GAME OVER: 영상 정지, 결과 화면 (등급 F, LIFE 0)', async () => {
    await page.evaluate(() => localStorage.clear());
    await startGame(page, 'diff=hell&debug=1'); // 아무것도 안 누르면 MISS 10번에 GAME OVER
    await page.locator('#resultOverlay').waitFor({ state: 'visible', timeout: 30000 });
    const s = await snap(page);
    assert.equal(s.phase, 'result');
    assert.equal(s.gameOver, true);
    assert.equal(s.life, 0);
    assert.equal(s.counts.MISS, 10);
    assert.equal(s.videoPaused, true);
    assert.equal(await page.locator('#resultTitle').textContent(), 'GAME OVER');
    assert.equal(await page.locator('#resGrade').textContent(), 'F');
    assert.equal(await page.locator('#resLife').textContent(), '0');
    assert.match(await page.locator('#resMeta').textContent(), /HELL · 1.0x · GAME OVER/);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('wony_rhythm_results'))[0]);
    assert.equal(saved.status, 'GAME_OVER');
    assert.equal(saved.gameOver, true);
    assert.equal(await page.evaluate(() => localStorage.getItem('wony_rhythm_scores')), null, 'GAME OVER 는 최고 기록 갱신 안 함');
    assert.match(await page.locator('#resNoSave').textContent(), /GAME OVER 기록은 최고 기록에 반영되지 않아요/);
    assert.equal(await page.locator('#resNewBest').isVisible(), false);
    assert.equal(saved.grade, 'F');
    assert.equal(saved.ranking.eligible, false);
    assert.equal(await page.locator('#resOnlineStatus').textContent(), 'GAME OVER 플레이는 온라인 랭킹에 반영되지 않습니다.');
    assert.ok(await page.locator('#resChuru').isHidden(), 'GAME OVER 는 츄르 없음');
    assert.equal(await page.evaluate(() => localStorage.getItem('wonyRhythm.wallet.v1')), null);
    assert.ok(await noHorizontalScroll(page));
    const panel = await box(page, '#resultOverlay .panel');
    assert.ok(panel.x >= 0 && panel.x + panel.width <= vp.width + 1, 'result panel inside viewport');
    await page.evaluate(() => localStorage.clear());
  });

  if (!vp.mobile) {
    await check('Esc 로 일시정지/재개', async () => {
      await startGame(page, 'diff=normal&autoplay=1');
      await page.waitForFunction(() => window.__wonyRhythm.snapshot().time > 0, null, { timeout: 10000 });
      await page.keyboard.press('Escape');
      assert.equal((await snap(page)).phase, 'paused');
      await page.keyboard.press('Escape');
      assert.equal((await snap(page)).phase, 'playing');
      await page.keyboard.press('Escape');
      assert.equal((await snap(page)).phase, 'paused');
    });
  }

  await check('JS console error 없음', async () => assert.deepEqual(errors, []));
  await context.close();
}

results.push('\n[배속 / 설정 / 곡 데이터 (1440 desktop)]');
{
  const { context, page, errors } = await newPage(VIEWPORTS[3]);
  for (const speed of [0.75, 1.0, 1.25, 1.5, 1.75, 2.0]) {
    await check(`배속 ${speed}x: 접근 시간만 바뀌고 판정 시각/영상 속도는 동일`, async () => {
      await startGame(page, `diff=hard&autoplay=1&speed=${speed}`);
      await page.waitForFunction(() => window.__wonyRhythm.snapshot().judged >= 12, null, { timeout: 20000 });
      const s = await snap(page);
      assert.equal(Math.round(s.approach), Math.round(2000 / speed));
      assert.equal(s.playbackRate, 1);
      assert.ok(Math.abs(s.time - s.videoTime) <= 60);
      assert.equal(s.counts.PERFECT, s.judged, `모두 PERFECT 여야 함 ${JSON.stringify(s.counts)}`);
    });
  }

  await check('NO FAIL: LIFE 0 이 되어도 계속 플레이 (설정 화면에서 켜기)', async () => {
    await page.goto(`${BASE}/settings`);
    await page.locator('#noFail').check();
    await startGame(page, 'diff=hell&debug=1');
    assert.equal(await page.locator('#noFailTag').isVisible(), true);
    await page.waitForFunction(() => window.__wonyRhythm.snapshot().life === 0, null, { timeout: 30000 });
    await page.waitForTimeout(1500);
    const s = await snap(page);
    assert.equal(s.phase, 'playing');
    assert.equal(s.gameOver, false);
    assert.ok(s.counts.MISS > 10, 'LIFE 0 이후에도 판정 계속');
    assert.equal(s.videoPaused, false);
    await page.goto(`${BASE}/settings`);
    await page.locator('#noFail').uncheck();
  });

  await check('키 변경 / 중복 방지 / Esc 취소 / 초기화 → 게임 표시 반영', async () => {
    await page.goto(`${BASE}/settings`);
    const keyBtn = i => page.locator('.key-btn').nth(i);
    await keyBtn(0).click();
    await page.keyboard.press('d');
    assert.equal(await keyBtn(0).textContent(), 'D');
    await keyBtn(1).click();
    await page.keyboard.press('d');
    assert.match(await page.locator('#keyStatus').textContent(), /이미 1레인/);
    await page.keyboard.press('Escape');
    assert.equal(await keyBtn(1).textContent(), '↓');
    await page.goto(`${BASE}/game?song=${SONG}&diff=easy`);
    await page.locator('#keyHint').waitFor();
    assert.equal(await page.locator('#keyHint').textContent(), 'D ↓ ↑ →');
    await page.goto(`${BASE}/settings`);
    await page.locator('#resetBtn').click();
    assert.deepEqual(await page.locator('.key-btn').allTextContents(), ['←', '↓', '↑', '→']);
  });

  await check('없는 곡/채보/영상 처리', async () => {
    await page.route('**/songs/songs.json', route => route.fulfill({ json: { songs: [
      { id: 'no-video', title: '영상 없는 곡', artist: 'WONY', cover: null, video: null, difficulties: ['easy'] },
    ] } }));
    await page.goto(`${BASE}/songs`);
    await page.locator('.song-card').first().waitFor();
    assert.match(await page.locator('.song-card').first().textContent(), /영상 준비 중/);
    assert.equal(await page.locator('#diffGroup input[value="hell"]').isDisabled(), true, '채보 없는 난이도 선택 불가');
    assert.equal(await page.locator('#playBtn').getAttribute('aria-disabled'), 'true');
    await page.goto(`${BASE}/game?song=no-video&diff=easy`);
    await page.locator('#readyProblem').waitFor();
    assert.match(await page.locator('#readyProblem').textContent(), /영상 준비 중/);
    assert.equal(await page.locator('#startBtn').isDisabled(), true);
    await page.unroute('**/songs/songs.json');
  });

  await check('기존 localStorage 최고 점수(숫자) 호환, GAME OVER 판은 최근 기록에만', async () => {
    await page.goto(`${BASE}/scores`);
    await page.evaluate(song => {
      localStorage.clear();
      localStorage.setItem('wony_rhythm_scores', JSON.stringify({ [song]: { easy: 12345, hard: 'broken' } }));
      localStorage.setItem('wony_rhythm_results', JSON.stringify([{ songId: song, difficulty: 'easy', noteSpeed: 1, score: 12345, accuracy: 88, gameOver: false, cleared: true, noFail: false }]));
    }, SONG);
    await page.reload();
    await page.locator('.score-table').first().waitFor();
    const easyRow = await page.locator('.score-table tbody tr').first().allTextContents();
    assert.match(easyRow.join(''), /12,345/);
    assert.match(await page.locator('.recent-grade').first().textContent(), /CLEAR/);
    await page.goto(`${BASE}/songs`);
    assert.match(await page.locator('.song-card').first().textContent(), /EASY 12,345/);
    // GAME OVER 한 판 → 최고 기록(이전 형식 값 포함)은 그대로, 최근 플레이에는 남음
    const before = await page.evaluate(() => localStorage.getItem('wony_rhythm_scores'));
    await startGame(page, 'diff=easy&debug=1');
    await page.locator('#resultOverlay').waitFor({ state: 'visible', timeout: 60000 });
    assert.equal((await snap(page)).resultStatus, 'GAME_OVER');
    assert.equal(await page.evaluate(() => localStorage.getItem('wony_rhythm_scores')), before);
    await page.goto(`${BASE}/scores`);
    assert.match((await page.locator('.score-table tbody tr').first().allTextContents()).join(''), /—.*—.*—.*12,345/);
    assert.match(await page.locator('.recent-grade').first().textContent(), /F · GAME OVER/);
    // 자동 플레이는 최고 기록/최근 기록 모두 남기지 않는다 (아래 FULL_SONG 테스트에서 결과 화면까지 확인)
    await startGame(page, 'diff=normal&autoplay=1');
    await page.waitForFunction(() => window.__wonyRhythm.snapshot().judged >= 3, null, { timeout: 20000 });
    await page.evaluate(() => window.__wonyRhythm.pause());
    await page.evaluate(() => localStorage.clear());
  });

  await check('/demo/ 옛 주소는 홈으로 이동', async () => {
    await page.goto(`${BASE}/demo/`);
    assert.equal(new URL(page.url()).pathname, '/');
  });

  if (process.env.FULL_SONG === '1') {
    await check('EASY 끝까지 자동 플레이 → 결과 화면 (배속 기록)', async () => {
      await startGame(page, 'diff=easy&autoplay=1&speed=1.5');
      await page.locator('#resultOverlay').waitFor({ state: 'visible', timeout: 90000 });
      const s = await snap(page);
      assert.equal(s.judged, s.total);
      assert.equal(s.maxCombo, s.total);
      assert.equal(await page.locator('#resAccuracy').textContent(), '100.00%');
      assert.equal(await page.locator('#resGrade').textContent(), 'S+');
      assert.equal(await page.locator('#resLife').textContent(), '100');
      assert.equal(await page.locator('#resultTitle').textContent(), 'CLEAR!');
      assert.equal(await page.locator('#resOnlineStatus').textContent(), '자동 플레이는 온라인 랭킹에 반영되지 않습니다.');
      assert.ok(await page.locator('#resChuru').isHidden(), '자동 플레이는 츄르 없음');
      assert.match(await page.locator('#resMeta').textContent(), /EASY · 1\.5x · CLEAR/);
      assert.match(await page.locator('#resNoSave').textContent(), /자동 플레이/);
      const recent = await page.evaluate(() => JSON.parse(localStorage.getItem('wony_rhythm_results') || '[]'));
      assert.ok(recent.every(r => !r.autoplay), '자동 플레이는 최근 기록에도 남기지 않음');
      const scores = await page.evaluate(() => JSON.parse(localStorage.getItem('wony_rhythm_scores') || '{}'));
      assert.equal(scores[SONG]?.easy, undefined, '자동 플레이는 최고 기록 갱신 안 함');
      await page.locator('#retryBtn').click();
      assert.equal((await snap(page)).phase, 'playing');
    });
  }

  // 의도한 404 (가짜 곡의 채보 요청 등) 외 오류가 없어야 한다
  await check('JS console error 없음', async () => assert.deepEqual(errors.filter(e => !e.includes('404')), []));
  await context.close();
}

// 6키 / 8키: UI 에는 아직 노출하지 않지만 채보의 laneCount 만으로 동작해야 한다 (자동 생성기로 만든 실제 채보 사용)
results.push('\n[6키 / 8키 구조 (채보 laneCount)]');
for (const lanes of [6, 8]) {
  const fixture = readFileSync(new URL(`./fixtures/demo-beat-hard-${lanes}k.json`, import.meta.url), 'utf-8');
  const labels = { 6: 'S D F J K L', 8: 'A S D F J K L ;' }[lanes];
  for (const vp of [VIEWPORTS[0], VIEWPORTS[1], VIEWPORTS[3]]) {
    const { context, page, errors } = await newPage(vp);
    await page.route('**/songs/charts/demo-beat-hard.json', route => route.fulfill({ body: fixture, contentType: 'application/json' }));
    await check(`${lanes}키 @ ${vp.name}: 레인/키/터치 버튼 ${lanes}개, 자동 플레이, 겹침·잘림 없음`, async () => {
      await startGame(page, 'diff=hard&autoplay=1');
      assert.equal(await page.locator('#keyHint').textContent(), labels);
      assert.equal(await page.locator('.lane-btn').count(), lanes);
      if (vp.mobile) assert.equal(await page.locator('#touch').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), lanes);
      await page.waitForFunction(() => window.__wonyRhythm.snapshot().judged >= 15, null, { timeout: 30000 });
      const s = await snap(page);
      assert.equal(s.counts.PERFECT, s.judged, JSON.stringify(s.counts));
      assert.ok(await noHorizontalScroll(page));
      if (vp.mobile) {
        const buttons = await page.locator('.lane-btn').evaluateAll(els => els.map(e => e.getBoundingClientRect().toJSON()));
        for (let i = 0; i < buttons.length; i++) {
          assert.ok(buttons[i].right <= vp.width + 1 && buttons[i].height >= 56, `button ${i} ${JSON.stringify(buttons[i])}`);
          if (i) assert.ok(buttons[i].left >= buttons[i - 1].right, 'lane buttons overlap');
        }
        const btn = page.locator('.lane-btn').nth(lanes - 1);
        await btn.evaluate(el => el.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 91, pointerType: 'touch', bubbles: true, cancelable: true })));
        assert.ok(await btn.evaluate(el => el.classList.contains('is-pressed')), `마지막 레인(${lanes - 1}) 터치`);
        await btn.evaluate(el => el.dispatchEvent(new PointerEvent('pointerup', { pointerId: 91, pointerType: 'touch', bubbles: true })));
      } else {
        const lastKey = lanes === 8 ? 'Semicolon' : 'KeyL';
        await page.keyboard.down(lastKey);
        assert.ok(await page.locator('.lane-btn').nth(lanes - 1).evaluate(el => el.classList.contains('is-pressed')), `마지막 레인 키 ${lastKey}`);
        await page.keyboard.up(lastKey);
      }
      assert.deepEqual(errors, []);
    });
    await context.close();
  }
}

await browser.close();
console.log(results.join('\n'));
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
