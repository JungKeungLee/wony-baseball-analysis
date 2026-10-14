// 브라우저 테스트 (Playwright). 테스트용 서버(WONY RHYTHM + 가짜 Supabase)를 직접 띄운다 (tests/servers.mjs):
//   cd frontend-demo && CHROMIUM_PATH="<Chrome 또는 Edge 경로>" node tests/browser.mjs   (supabase/tests 에서 npm install 필요)
// 로그인 필수 정책: 각 브라우저는 WONY PHONE 과 같은 방식의 1회용 입장권으로 로그인한 뒤 테스트한다 (비로그인 화면도 따로 확인).
// MP4(H.264/AAC)를 재생해야 하므로 Playwright 기본 Chromium(코덱 없음) 대신 Chrome/Edge 실행 파일을 지정한다.
// FULL_SONG=1 이면 데모곡 EASY 를 끝까지 자동 플레이해 결과 화면까지 확인한다 (약 45초).
import { chromium, devices } from 'playwright';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startServers } from './servers.mjs';

const MEMBER = { id: randomUUID(), nickname: '워니팬' };
const servers = await startServers({ appPort: 8768, pgPort: 54398, members: [MEMBER] });
const { BASE, PHONE_URL } = servers;
// localStorage 에 남아도 되는 것 = 게임 설정만 (js/storage.js MEMBER_FREE_KEYS)
const ALLOWED_STORAGE = ['wony_rhythm_settings', 'wony_rhythm_last', 'wonyRhythm.skins.v1', 'wony_rhythm_favorites'];
const overlap = (a, b) => a && b && a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1;
const storageKeys = page => page.evaluate(() => Object.keys(localStorage).sort());
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

async function newPage(vp, { login = true } = {}) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height }, isMobile: vp.mobile, hasTouch: vp.mobile, deviceScaleFactor: vp.mobile ? 3 : 1,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url().replace(BASE, '')}`); });
  // WONY PHONE → 리듬게임 앱 → 60초 1회용 입장권 → WONY RHYTHM 세션 쿠키
  if (login) await page.goto(`${BASE}/rhythm-login?ticket=${encodeURIComponent(servers.ticket(MEMBER))}&next=/`);
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
 * mode: 'member' (서버가 순위 · 츄르 결과를 돌려줌) | 'expired' (저장 때 세션 만료 401) | 'fail' (서버 장애)
 */
async function runResultDemo(page, mode, { reducedMotion = false, playId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' } = {}) {
  return page.evaluate(async ({ mode, reducedMotion, playId }) => {
    const { runResultOnline } = await import('/js/result-online.js');
    const $ = id => document.getElementById(id);
    for (const id of ['readyOverlay', 'pauseOverlay', 'errorOverlay']) $(id).hidden = true;
    $('resultOverlay').hidden = false;
    const record = {
      playId, schema: 3, status: 'CLEAR', songId: 'demo-beat', difficulty: 'hard', laneCount: 4, noteSpeed: 1, score: 2000,
      maxCombo: 2, perfect: 2, great: 0, good: 0, miss: 0, totalNotes: 2, accuracy: 100, life: 100, grade: 'S+', noFail: false,
    };
    const calls = [];
    const deps = {
      submitRanking: async () => {
        calls.push('submit');
        if (mode === 'fail') return { submitted: false, reason: 'failed' };
        if (mode === 'expired') return { submitted: false, reason: 'login-required' };
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
    const online = Promise.resolve({ onlineEnabled: true, loggedIn: true, churuBalance: 26, loginUrl: 'https://phone.example/phone' });
    const els = {
      box: $('resOnline'), status: $('resOnlineStatus'), change: $('resRankChange'), medal: $('resRankMedal'),
      transition: $('resRankTransition'), delta: $('resRankDelta'), badges: $('resRankBadges'), ranking: $('resRanking'),
      fullRanking: $('resFullRanking'), churu: $('resChuru'), churuTitle: $('resChuruTitle'), churuAmount: $('resChuruAmount'),
      churuFrom: $('resChuruFrom'), churuTo: $('resChuruTo'), churuNote: $('resChuruNote'), login: $('resLogin'),
      best: $('resBest'), newBest: $('resNewBest'),
    };
    // 연출 중간값 확인용: 순위 숫자가 처음 바뀐 시점 기록
    const seen = new Set();
    const mo = new MutationObserver(() => seen.add($('resRankTransition').textContent));
    mo.observe($('resRankTransition'), { childList: true, subtree: true, characterData: true });
    const t0 = performance.now();
    const ready = new Promise(r => setTimeout(r, reducedMotion ? 0 : 900));   // game.js 와 같은 결과 · 등급 연출 시간
    const out = await runResultOnline({ record, context: {}, els, online, deps, reducedMotion, ready, rankingHref: '/ranking?song=demo-beat&diff=hard' });
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

  await check('워니 안내 (메인): 이미지 + 말풍선, 메뉴 · 로고 · 츄르를 가리지 않음', async () => {
    await page.goto(`${BASE}/`);
    await page.locator('#homeWony:not([hidden]) .wony-bubble').waitFor();
    assert.ok((await page.locator('#homeWony .wony-bubble').textContent()).length > 3);
    assert.equal(await page.locator('#homeWony .wony-img').getAttribute('src'), '/assets/wony/wony.png');
    assert.ok(await page.locator('#homeWony .wony-img').evaluate(img => img.complete && img.naturalWidth > 0), '임시 이미지 로드');
    const wony = await box(page, '#homeWony');
    for (const sel of ['.menu', '.logo', '#walletBadge', '#onlineCard']) {
      const other = await box(page, sel);
      assert.ok(!overlap(wony, other), `워니가 ${sel} 와 겹침`);
    }
    assert.ok(wony.x >= 0 && wony.x + wony.width <= vp.width + 1);
    assert.ok(await noHorizontalScroll(page));
  });

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
    assert.ok(run.seen.some(t => /^12위↓(1[01]|[89])위$/.test(t)), `중간 순위 표시 ${run.seen}`);
    assert.equal(await page.locator('#resRankTransition').textContent(), '12위↓7위');   // 12위 / ↓ / 7위
    assert.equal(await page.locator('#resRankTransition').getAttribute('aria-label'), '12위 → 7위');
    assert.ok(run.ms >= 900, '결과 · 등급 연출 다음에 순위 (ready)');
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
    assert.ok(!run.seen.some(t => /^12위↓(1[01]|[89])위$/.test(t)), `중간값 없음 ${run.seen}`);
    assert.equal(await page.locator('#resRankTransition').textContent(), '12위↓7위');
    assert.equal(await page.locator('#resChuruTo').textContent(), '30');
    assert.equal(await page.locator('#resRankChange').evaluate(el => el.classList.contains('is-animated')), false);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  });

  await check('결과 화면 (세션 만료): 저장 실패 안내 + WONY PHONE 로그인 버튼, 다시 보내지 않음 · 츄르 없음', async () => {
    await page.goto(`${BASE}/game?song=${SONG}&diff=hard&debug=1`);
    await page.locator('#startBtn').waitFor();
    const run = await runResultDemo(page, 'expired', { reducedMotion: true });
    assert.equal(run.stage, 'expired');
    assert.deepEqual(run.calls, ['submit'], '같은 판을 다시 보내지 않음');
    assert.equal(await page.locator('#resOnlineStatus').textContent(), '로그인 세션이 만료되었습니다.\n다시 로그인해주세요.');
    assert.equal(await page.locator('#resOnlineStatus').innerText(), '로그인 세션이 만료되었습니다.\n다시 로그인해주세요.');
    assert.ok(await page.locator('#resLogin').isVisible());
    assert.equal(await page.locator('#resLogin').getAttribute('href'), 'https://phone.example/phone');
    assert.equal(await page.locator('#resChuruNote').textContent(), '츄르 보상 처리에 실패했습니다.');
    assert.ok(await page.locator('#resRankChange').isHidden());
    assert.ok(await noHorizontalScroll(page));
  });

  await check('결과 화면 (서버 장애): 결과는 그대로, 온라인 · 츄르 실패 안내', async () => {
    await page.goto(`${BASE}/game?song=${SONG}&diff=hard&debug=1`);
    await page.locator('#startBtn').waitFor();
    const run = await runResultDemo(page, 'fail', { reducedMotion: true });
    assert.equal(run.stage, 'failed');
    assert.equal(await page.locator('#resOnlineStatus').textContent(), '온라인 기록을 불러오지 못했습니다.');
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
    assert.deepEqual(await page.locator('#speedGroup label').allTextContents(), ['1x', '1.5x', '2x', '3x', '4x', '6x'], '배속 목록');
    await page.locator('#speedGroup label', { hasText: /^3x$/ }).click();
    await page.locator('#videoOn').uncheck();
    assert.ok(await noHorizontalScroll(page));
    await page.locator('#playBtn').click();
    await page.waitForURL(/\/game\?/);
    assert.match(page.url(), new RegExp(`song=${SONG}&diff=hard`));
    await page.locator('#readySpeed').waitFor();
    assert.equal(await page.locator('#readySpeed').textContent(), '3x');
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

  await check('판정선 · 입력 버튼: 영상 ON/OFF 와 관계없이 화면 아래 기준 같은 위치', async () => {
    const measure = async () => {
      const s = await snap(page);
      const touch = await page.locator('#touch').boundingBox();
      const stage = await box(page, '#stage');
      return { judge: s.layout.judgeScreenY, stageBottom: Math.round(stage.y + stage.height), touch: touch && Math.round(touch.y) };
    };
    await page.locator('#pauseBtn').click();
    const on = await measure();
    await page.locator('#videoToggle').uncheck();
    await page.waitForTimeout(150);
    const off = await measure();
    assert.ok(Math.abs(on.judge - off.judge) <= 1, `판정선 ON ${on.judge} / OFF ${off.judge}`);
    assert.equal(on.stageBottom, off.stageBottom, '게임 영역 아래 끝 같음');
    assert.equal(on.touch, off.touch, '터치 버튼 위치 같음');
    const stageOff = await box(page, '#stage');
    assert.ok(stageOff.y < on.judge - 100, '영상이 빠진 공간은 레인이 차지');
    assert.ok(on.judge < vp.height && on.judge > vp.height * 0.5, `판정선은 화면 아래쪽 ${on.judge}`);
    await page.locator('#videoToggle').check();
    await page.locator('#resumeBtn').click();
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

  await check('COMBO 표시: 노트 판독을 가리지 않음 (모바일 가로는 작게 · 반투명 · 맨 위)', async () => {
    await startGame(page, 'diff=hard&autoplay=1');
    await page.waitForFunction(() => window.__wonyRhythm.snapshot().combo >= 5, null, { timeout: 20000 });
    const stage = await box(page, '#stage');
    const combo = await box(page, '#combo');
    const style = await page.locator('#comboNum').evaluate(el => { const c = getComputedStyle(el); return { size: parseFloat(c.fontSize), color: c.color }; });
    const mobileLandscape = vp.mobile && vp.width > vp.height && vp.height <= 500;
    if (mobileLandscape) {
      assert.ok(style.size <= 0.8 * 2.8 * 16 + 0.5, `가로: 기존 최대 2.8rem 대비 20% 축소 ${style.size}px`);
      assert.match(style.color, /rgba\(255, 255, 255, 0\.6\)/, `반투명 ${style.color}`);
      assert.ok(combo.y + combo.height <= stage.y + stage.height * 0.3, `맨 위 영역 ${combo.y + combo.height} / ${stage.y + stage.height * 0.3}`);
    } else {
      assert.ok(style.size >= 2.6 * 16 - 1, `PC · 세로는 기존 크기 유지 ${style.size}px`);
    }
    const s = await snap(page);
    assert.equal(s.counts.PERFECT, s.judged, '표시 변경은 판정과 무관');
    await page.evaluate(() => window.__wonyRhythm.pause());
  });

  await check('LIFE: 난이도별 최대 LIFE 하트 (EASY 10 · NORMAL 8 · HARD 5 · HELL 3)', async () => {
    for (const [d, n] of [['easy', 10], ['normal', 8], ['hard', 5], ['hell', 3]]) {
      await page.goto(`${BASE}/game?song=${SONG}&diff=${d}&debug=1`);
      await page.locator('#startBtn:not([disabled])').waitFor();
      assert.equal(await page.locator('#lifeHearts .heart').count(), n, d);
      assert.equal(await page.locator('#lifeHearts .heart[data-fill="full"]').count(), n, d);
      assert.equal(await page.locator('#lifeMeter .life-num').textContent(), `${n}/${n}`);
      assert.equal(await page.locator('#lifeMeter').getAttribute('aria-valuetext'), `LIFE ${n} / ${n}`);
      assert.ok(await noHorizontalScroll(page));
    }
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
    assert.equal(s.counts.MISS, 3, 'HELL 최대 LIFE 3');
    assert.equal(s.lifeMax, 3);
    assert.equal(s.videoPaused, true);
    assert.equal(await page.locator('#resultTitle').textContent(), 'GAME OVER');
    assert.equal(await page.locator('#resGrade').textContent(), 'F');
    assert.equal(await page.locator('#resLife').textContent(), '0 / 3');
    assert.match(await page.locator('#resMeta').textContent(), /HELL · 4 KEY · 1x · GAME OVER/);
    assert.match(await page.locator('#resNoSave').textContent(), /GAME OVER 기록은 최고 기록에 반영되지 않아요/);
    assert.equal(await page.locator('#resNewBest').isVisible(), false);
    assert.match(await page.locator('#resOnlineStatus').textContent(), /^GAME OVER 플레이는 온라인 랭킹에 반영되지 않습니다\./);
    assert.ok(await page.locator('#resChuru').isHidden(), 'GAME OVER 는 츄르 없음');
    const keys = await storageKeys(page);
    assert.ok(keys.every(k => ALLOWED_STORAGE.includes(k)), `localStorage 에는 설정만: ${keys}`);
    assert.ok(await noHorizontalScroll(page));
    const panel = await box(page, '#resultOverlay .panel');
    assert.ok(panel.x >= 0 && panel.x + panel.width <= vp.width + 1, 'result panel inside viewport');
    // 워니 안내 (결과): 흐름 안에서 결과 · 버튼을 가리지 않음
    assert.ok(await page.locator('#resWony').isVisible());
    assert.match(await page.locator('#resWony .wony-bubble').textContent(), /아쉬워요|EASY/);
    const wony = await box(page, '#resWony');
    for (const sel of ['#resultOverlay .stat-grid', '#resultOverlay .actions', '#resultTitle']) assert.ok(!overlap(wony, await box(page, sel)), `결과 워니가 ${sel} 와 겹침`);
    if (vp.mobile && vp.height <= 500) assert.ok(await page.locator('#resWony .wony-img').isHidden(), '낮은 가로 화면은 말풍선만');
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

  await check('select: 높이 48px 이상 · 큰 화살표 영역 · focus 표시', async () => {
    for (const path of ['/settings', '/ranking']) {
      await page.goto(BASE + path);
      const sel = page.locator('select').first();
      await sel.waitFor();
      const b = await sel.boundingBox();
      assert.ok(b.height >= 48, `${path} 높이 ${b.height}`);
      const style = await sel.evaluate(el => { const c = getComputedStyle(el); return { pr: parseFloat(c.paddingRight), font: parseFloat(c.fontSize), img: c.backgroundImage, app: c.appearance }; });
      assert.ok(style.pr >= 44 && style.font >= 16 && style.img.includes('svg') && style.app === 'none', JSON.stringify(style));
      await sel.focus();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      assert.notEqual(await sel.evaluate(el => getComputedStyle(el).outlineStyle), 'none', 'focus 링');
    }
  });

  await check('JS console error 없음', async () => assert.deepEqual(errors, []));
  await context.close();
}

results.push('\n[콤보 LIFE 회복 · 효과 · 동작 줄이기 (1440 desktop)]');
for (const reduce of [false, true]) {
  const { context, page, errors } = await newPage(VIEWPORTS[3]);
  if (reduce) await page.emulateMedia({ reducedMotion: 'reduce' });
  await check(`실제 키 입력: MISS 1 → 10콤보 +0.5 · 20콤보 +1 LIFE, 판정 timing 그대로 (동작 줄이기 ${reduce ? 'ON' : 'OFF'})`, async () => {
    await page.goto(`${BASE}/game?song=${SONG}&diff=hard&debug=1`);
    await page.locator('#startBtn:not([disabled])').click();
    // 첫 노트는 놓치고, 이후 노트는 키보드 이벤트로 정확히 침 (자동 플레이가 아닌 실제 입력 경로)
    await page.evaluate(async () => {
      const chart = await (await fetch('/songs/charts/demo-beat-hard.json')).json();
      const keys = ['ArrowLeft', 'ArrowDown', 'ArrowUp', 'ArrowRight'];
      let i = 1;
      (function tick() {
        const t = window.__wonyRhythm.snapshot().time;
        while (i < chart.notes.length && chart.notes[i].time <= t + 8) {
          const code = keys[chart.notes[i].lane];
          dispatchEvent(new KeyboardEvent('keydown', { code, key: code }));
          dispatchEvent(new KeyboardEvent('keyup', { code, key: code }));
          i++;
        }
        if (i < 23) requestAnimationFrame(tick);
      })();
    });
    await page.waitForFunction(() => window.__wonyRhythm.snapshot().combo >= 10, null, { timeout: 30000 });
    const ten = await snap(page);
    assert.equal(ten.counts.MISS, 1);
    assert.equal(ten.life, 4.5, `10콤보 후 ${ten.life}`);
    await page.locator('#lifeHearts .heart[data-fill="half"]').waitFor({ timeout: 2000 });   // HUD 는 다음 프레임에 갱신
    assert.equal(await page.locator('#lifeHearts .heart[data-fill="half"]').count(), 1, '반 칸 하트');
    assert.ok(await page.locator('#lifeHeal').isVisible(), '+0.5 LIFE 표시');
    assert.equal(await page.locator('#lifeHeal').textContent(), '+0.5 LIFE');
    await page.waitForFunction(() => window.__wonyRhythm.snapshot().combo >= 20, null, { timeout: 30000 });
    const twenty = await snap(page);
    assert.equal(twenty.life, 5, '20콤보 총 +1 (최대 5)');
    assert.equal(twenty.healed, 1);
    assert.equal(twenty.counts.PERFECT, twenty.judged - 1, `효과가 판정에 영향 없음 ${JSON.stringify(twenty.counts)}`);
    assert.ok(Math.abs(twenty.time - twenty.videoTime) <= 60, `시계 ${twenty.time} / video ${twenty.videoTime}`);
    if (reduce) {
      const running = await page.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').length);
      assert.equal(running, 0, '동작 줄이기: 콤보 · 판정 · LIFE 애니메이션 없음');
    }
    await page.evaluate(() => window.__wonyRhythm.pause());
  });
  if (reduce) {
    await check('동작 줄이기: 메인 배경 · 로고 애니메이션 정지', async () => {
      await page.goto(`${BASE}/`);
      const names = await page.evaluate(() => [getComputedStyle(document.body, '::before').animationName, getComputedStyle(document.querySelector('.logo-notes i')).animationName]);
      assert.deepEqual(names, ['none', 'none']);
    });
  } else {
    await check('메인: 배경 빛 · 로고 노트 애니메이션 (transform)', async () => {
      await page.goto(`${BASE}/`);
      const names = await page.evaluate(() => [getComputedStyle(document.body, '::before').animationName, getComputedStyle(document.querySelector('.logo-notes i')).animationName]);
      assert.deepEqual(names, ['home-light', 'note-bounce']);
    });
  }
  await check(`JS console error 없음 (동작 줄이기 ${reduce ? 'ON' : 'OFF'})`, async () => assert.deepEqual(errors, []));
  await context.close();
}

results.push('\n[소리 · 키 입력 테스트 · 미리듣기 · 즐겨찾기 · BEST (1440 desktop)]');
{
  const { context, page, errors } = await newPage(VIEWPORTS[3]);
  const mp4 = [];
  page.on('request', r => { if (r.url().endsWith('.mp4')) mp4.push(r.url().replace(BASE, '')); });
  await check('설정 소리: 마스터 · 음악 · 효과음(기본 60) 슬라이더 + 음소거, 저장 후 새로고침해도 유지', async () => {
    await page.goto(`${BASE}/settings`);
    assert.deepEqual(await page.locator('#masterVolume, #musicVolume, #sfxVolume').evaluateAll(els => els.map(e => e.value)), ['80', '100', '60']);
    for (const id of ['masterVolume', 'musicVolume', 'sfxVolume']) {
      const b = await box(page, `#${id}`);
      assert.ok(b.height >= 44 && b.width >= 150, `${id} 슬라이더 크기 ${JSON.stringify(b)}`);
    }
    await page.locator('#masterVolume').fill('50');
    await page.locator('#musicVolume').fill('50');
    await page.locator('#sfxVolume').fill('30');
    assert.equal(await page.locator('#masterVolumeOut').textContent(), '50');
    await page.reload();
    assert.deepEqual(await page.locator('#masterVolume, #musicVolume, #sfxVolume').evaluateAll(els => els.map(e => e.value)), ['50', '50', '30']);
    const raw = await page.evaluate(() => JSON.parse(localStorage.getItem('wony_rhythm_settings')));
    assert.deepEqual([raw.masterVolume, raw.musicVolume, raw.sfxVolume, raw.muted], [50, 50, 30, false]);
    assert.ok(await page.locator('#musicVolumeField').isVisible());
    assert.ok(await page.locator('#musicVolumeLocked').isHidden());
  });
  await check('게임: 음악 볼륨 = 마스터 × 음악 → video.volume 0.25, 판정 효과음 재생, 판정 그대로', async () => {
    await startGame(page, 'diff=normal&autoplay=1');
    await page.waitForFunction(() => window.__wonyRhythm.snapshot().judged >= 8, null, { timeout: 20000 });
    const s = await snap(page);
    assert.equal(s.videoVolume, 0.25);
    assert.equal(s.videoMuted, false);
    assert.ok(s.sfxPlayed >= 4, `효과음 ${s.sfxPlayed}`);
    assert.equal(s.counts.PERFECT, s.judged);
    assert.equal(s.playbackRate, 1);
    await page.evaluate(() => window.__wonyRhythm.pause());
  });
  await check('음소거: 게임 음악 muted · 효과음 없음 (재생 · 시계는 그대로 진행)', async () => {
    await page.goto(`${BASE}/settings`);
    await page.locator('#muted').check();
    await startGame(page, 'diff=normal&autoplay=1');
    await page.waitForFunction(() => window.__wonyRhythm.snapshot().judged >= 1, null, { timeout: 20000 });
    const a = await snap(page);
    await page.waitForFunction(n => window.__wonyRhythm.snapshot().judged >= n + 6, a.judged, { timeout: 20000 });
    const b = await snap(page);
    assert.equal(b.videoMuted, true, '카운트다운 뒤 재생 시작 때도 음소거 유지 (clock.js)');
    assert.equal(b.sfxPlayed, a.sfxPlayed, '음소거면 판정음 없음');
    assert.equal(b.videoPaused, false);
    assert.ok(Math.abs(b.time - b.videoTime) <= 60);
    assert.equal(b.counts.PERFECT, b.judged);
    await page.evaluate(() => window.__wonyRhythm.pause());
  });
  await check('곡 미리듣기: 음소거면 재생 · 다운로드 없이 안내', async () => {
    await page.goto(`${BASE}/songs`);
    await page.waitForLoadState('networkidle');
    mp4.length = 0;
    await page.locator('[data-preview="demo-beat"]').click();
    assert.match(await page.locator('#previewNote').textContent(), /음소거 상태예요/);
    assert.ok(await page.locator('#previewNote').isVisible(), '안내 문구가 있으면 표시');
    await page.waitForTimeout(500);
    assert.deepEqual(mp4, [], '음소거면 영상을 받지 않음');
    await page.goto(`${BASE}/settings`);
    await page.locator('#muted').uncheck();
  });
  await check('곡 미리듣기: 누를 때만 받음, 한 번에 한 곡만, 소리 설정 적용, 다시 누르면 정지', async () => {
    await page.goto(`${BASE}/songs`);
    await page.waitForLoadState('networkidle');
    mp4.length = 0;
    await page.waitForTimeout(300);
    assert.deepEqual(mp4, [], '곡 선택 화면만으로는 영상 요청 없음');
    await page.locator('[data-preview="demo-beat"]').click();
    await page.waitForFunction(() => { const a = document.getElementById('previewAudio'); return a && !a.paused && a.currentTime > 0.2; }, null, { timeout: 15000 });
    const a1 = await page.evaluate(() => { const a = document.getElementById('previewAudio'); return { src: a.src, volume: a.volume, muted: a.muted, t: a.currentTime }; });
    assert.match(a1.src, /demo-beat\.mp4$/);
    assert.equal(a1.volume, 0.25, '마스터 50 × 음악 50');
    assert.ok(a1.t >= 12, `미리듣기 시작 위치(곡 30%) ${a1.t}`);
    assert.equal(await page.locator('[data-preview="demo-beat"]').textContent(), '■');
    await page.locator('[data-preview="wony-cover-01"]').click();
    await page.waitForFunction(() => /wony-cover-01\.mp4$/.test(document.getElementById('previewAudio').src));
    const playing = await page.evaluate(() => [...document.querySelectorAll('audio, video')].filter(m => !m.paused).length);
    assert.equal(playing, 1, '동시에 한 곡만');
    assert.equal(await page.locator('[data-preview="demo-beat"]').textContent(), '▶');
    await page.locator('[data-preview="wony-cover-01"]').click();
    assert.equal(await page.evaluate(() => document.getElementById('previewAudio').paused), true, '다시 누르면 정지');
  });
  await check('곡 선택: 상태 · 미리듣기 안내가 비어 있으면 빈 공간 없음', async () => {
    await page.goto(`${BASE}/songs`);
    await page.locator('.song-item').first().waitFor();
    assert.ok(await page.locator('#status').isHidden() && await page.locator('#previewNote').isHidden());
    const topbar = await box(page, '.topbar');
    const tools = await box(page, '.song-tools');
    // 제목 줄 아래 여백(18px) + 토글 줄 여백만 남음 (빈 상태 줄 24px 이상이 사라짐)
    assert.ok(tools.y - (topbar.y + topbar.height) <= 32, `제목 아래 바로 즐겨찾기 ${tools.y - (topbar.y + topbar.height)}px`);
  });
  await check('즐겨찾기: ☆ → ★, 즐겨찾기 곡이 위로, "즐겨찾기만", 새로고침 후 유지 (wony_rhythm_favorites)', async () => {
    await page.goto(`${BASE}/songs`);
    const order = () => page.locator('.song-item').evaluateAll(els => els.map(e => e.dataset.item));
    assert.deepEqual(await order(), ['demo-beat', 'wony-cover-01']);
    await page.locator('[data-fav="wony-cover-01"]').click();
    assert.deepEqual(await order(), ['wony-cover-01', 'demo-beat']);
    assert.equal(await page.locator('[data-fav="wony-cover-01"]').textContent(), '★');
    await page.locator('#favOnly').check();
    assert.deepEqual(await order(), ['wony-cover-01']);
    await page.reload();
    assert.deepEqual(await order(), ['wony-cover-01', 'demo-beat']);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('wony_rhythm_favorites'))), ['wony-cover-01']);
    const btn = await box(page, '[data-fav="wony-cover-01"]');
    assert.ok(btn.width >= 44 && btn.height >= 44);
    const keys = await storageKeys(page);
    assert.ok(keys.every(k => ALLOWED_STORAGE.includes(k)), `${keys}`);
  });
  await check('설정 키 입력 테스트: 레인 키를 누르면 그 줄이 바로 빛나고, 떼면 꺼짐', async () => {
    await page.goto(`${BASE}/settings`);
    await page.locator('#keyModeGroup label', { hasText: '6 KEY' }).click();
    await page.locator('#keyModeGroup label', { hasText: '4 KEY' }).click();   // 마우스로 고른 직후 방향키 → 모드가 바뀌지 않고 테스트
    await page.keyboard.down('ArrowUp');
    assert.equal(await page.locator('#keyModeGroup input:checked').getAttribute('value'), '4');
    assert.deepEqual(await page.locator('#keyRows .key-row').evaluateAll(rows => rows.map(r => r.classList.contains('is-hit'))), [false, false, true, false]);
    await page.keyboard.up('ArrowUp');
    assert.equal(await page.locator('#keyRows .key-row.is-hit').count(), 0);
    await page.locator('#keyModeGroup label', { hasText: '6 KEY' }).click();
    await page.keyboard.down('KeyL');
    assert.equal(await page.locator('#keyRows .key-row').nth(5).evaluate(r => r.classList.contains('is-hit')), true);
    await page.keyboard.up('KeyL');
    await page.locator('#keyModeGroup label', { hasText: '4 KEY' }).click();
  });
  await check('JS console error 없음 (소리 · 미리듣기 · 즐겨찾기)', async () => assert.deepEqual(errors, []));
  await context.close();
}
{
  // iPhone Safari 처럼 미디어 볼륨을 바꿀 수 없는 브라우저
  const { context, page, errors } = await newPage(VIEWPORTS[0]);
  await page.addInitScript(() => {
    Object.defineProperty(HTMLMediaElement.prototype, 'volume', { get() { return 1; }, set() {}, configurable: true });
  });
  await check('볼륨 고정 기기(iPhone): 음악 볼륨 슬라이더 대신 "기기 볼륨 버튼" 안내, 음소거는 동작', async () => {
    await page.goto(`${BASE}/settings`);
    assert.ok(await page.locator('#musicVolumeField').isHidden());
    assert.equal(await page.locator('#musicVolumeLocked').textContent(), '🔊 음악 볼륨은 기기 볼륨 버튼으로 조절해주세요.');
    assert.ok(await page.locator('#masterVolume').isVisible() && await page.locator('#sfxVolume').isVisible());
    await page.locator('#muted').check();
    await startGame(page, 'diff=normal&autoplay=1');
    await page.waitForFunction(() => window.__wonyRhythm.snapshot().judged >= 3, null, { timeout: 20000 });
    assert.equal((await snap(page)).videoMuted, true);
    await page.evaluate(() => window.__wonyRhythm.pause());
    assert.deepEqual(errors, []);
  });
  await context.close();
}

results.push('\n[곡 끝까지: 정상 CLEAR 는 영상(음악)이 끝난 뒤 결과 (1440 desktop)]');
{
  const { context, page, errors } = await newPage(VIEWPORTS[3]);
  // 실제 문제 재현: 채보 endMs 가 영상 끝보다 훨씬 이름 (wony-cover-01 은 endMs 214,142 / 영상 228,531)
  const full = await (await fetch(`${BASE}/songs/charts/demo-beat-hard.json`)).json();
  const short = { ...full, notes: full.notes.filter(n => n.time <= 12000), endMs: 14000 };
  await page.route('**/songs/charts/demo-beat-hard.json', route => route.fulfill({ json: short }));
  await check('마지막 노트 · 채보 endMs 가 지나도 영상이 남아 있으면 결과로 넘어가지 않음 → 영상 끝에서 CLEAR', async () => {
    await startGame(page, 'diff=hard&autoplay=1');
    await page.waitForFunction(() => { const s = window.__wonyRhythm.snapshot(); return s.judged === s.total && s.time > 16000; }, null, { timeout: 40000 });
    const mid = await snap(page);
    assert.equal(mid.phase, 'playing', `모든 노트 판정 + endMs(14000) 이후에도 계속 (${mid.time}ms / 영상 ${mid.videoDuration}ms)`);
    assert.ok(mid.endTime > 41000 && mid.endTime <= mid.videoDuration, `종료 기준 = 영상 길이 ${mid.endTime}`);
    await page.locator('#resultOverlay').waitFor({ state: 'visible', timeout: 60000 });
    const end = await snap(page);
    assert.equal(end.resultStatus, 'CLEAR');
    assert.ok(end.videoEnded || end.videoTime >= end.videoDuration - 150, `결과는 영상 끝에서 ${end.videoTime} / ${end.videoDuration}`);
    assert.equal(end.counts.PERFECT, end.total);
  });
  await check('JS console error 없음 (곡 끝)', async () => assert.deepEqual(errors, []));
  await context.close();
}

results.push('\n[배속 / 설정 / 곡 데이터 (1440 desktop)]');
{
  const { context, page, errors } = await newPage(VIEWPORTS[3]);
  for (const speed of [1, 1.5, 2, 3, 4, 6]) {
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
    assert.ok(s.counts.MISS > 3, `LIFE 0(HELL 3) 이후에도 판정 계속 ${s.counts.MISS}`);
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

  await check('이전 버전 로컬 기록 · 비로그인 츄르는 지우고 설정만 남김, 최고 기록 화면은 서버 기록', async () => {
    await page.goto(`${BASE}/settings`);
    await page.evaluate(song => {
      localStorage.setItem('wony_rhythm_scores', JSON.stringify({ [song]: { easy: 12345 } }));
      localStorage.setItem('wony_rhythm_results', JSON.stringify([{ songId: song, difficulty: 'easy', score: 12345 }]));
      localStorage.setItem('wonyRhythm.wallet.v1', JSON.stringify({ balance: 99, plays: [] }));
    }, SONG);
    await page.goto(`${BASE}/scores`);
    await page.locator('.score-table').first().waitFor();
    const keys = await storageKeys(page);
    assert.ok(keys.every(k => ALLOWED_STORAGE.includes(k)), `남은 키 ${keys}`);
    assert.ok(!(await page.locator('main').textContent()).includes('12,345'), '이전 로컬 기록은 보이지 않음');
    // 서버 기록: 위 GAME OVER 판들이 최근 플레이에 있고, 최고 기록(정상 CLEAR 만)은 없음
    await page.locator('.recent-grade').first().waitFor();
    assert.match(await page.locator('.recent-grade').first().textContent(), /F · GAME OVER/);
    assert.ok((await page.locator('.best-grade').allTextContents()).every(t => t === '—'), '정상 CLEAR 가 없으므로 최고 기록 없음');
    assert.equal(await page.locator('#clearBtn').count(), 0, '서버 기록은 이 화면에서 지우지 않음');
    await page.goto(`${BASE}/`);
    await page.locator('#walletBadge:not([hidden])').waitFor();
    assert.equal(await page.locator('#walletBadge').textContent(), '🐟 츄르 0', '비로그인 츄르 99 는 사용하지 않음');
  });

  await check('게임 시작 전 로그인 확인: 세션이 없다고 나오면 시작 버튼이 열리지 않고 로그인 안내로', async () => {
    await page.route('**/api/rhythm/me', route => route.fulfill({ json: { loggedIn: false, onlineEnabled: true } }), { times: 1 });
    await page.goto(`${BASE}/game?song=${SONG}&diff=easy&debug=1`);
    await page.waitForURL(u => new URL(u).pathname === '/', { timeout: 10000 });
    // 세션 쿠키가 아예 없으면 서버가 게임 화면 대신 로그인 안내를 보냄
    const cookies = await context.cookies();
    await context.clearCookies();
    await page.goto(`${BASE}/game?song=${SONG}&diff=easy&debug=1`);
    assert.equal(await page.locator('body').getAttribute('data-page'), 'login');
    assert.equal(await page.locator('#startBtn').count(), 0);
    await context.addCookies(cookies);
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
      assert.equal(await page.locator('#resLife').textContent(), '10 / 10');
      assert.equal(await page.locator('#resultTitle').textContent(), 'CLEAR!');
      assert.equal(await page.locator('#resOnlineStatus').textContent(), '자동 플레이는 온라인 랭킹에 반영되지 않습니다.');
      assert.ok(await page.locator('#resChuru').isHidden(), '자동 플레이는 츄르 없음');
      assert.match(await page.locator('#resMeta').textContent(), /EASY · 4 KEY · 1\.5x · CLEAR/);
      assert.match(await page.locator('#resNoSave').textContent(), /자동 플레이/);
      const keys = await storageKeys(page);
      assert.ok(keys.every(k => ALLOWED_STORAGE.includes(k)), `localStorage 에는 설정만: ${keys}`);
      await page.locator('#retryBtn').click();
      assert.equal((await snap(page)).phase, 'playing');
    });
  }

  // 의도한 404 (가짜 곡의 채보 요청 등) 외 오류가 없어야 한다
  await check('JS console error 없음', async () => assert.deepEqual(errors.filter(e => !e.includes('404')), []));
  await context.close();
}

// 4 / 6 / 8 KEY: 곡 선택 → KEY 모드 → 실제 6/8키 채보 (tools/add_lane_modes.py 로 만든 demo-beat 채보)
results.push('\n[4 / 6 / 8 KEY]');
{
  const { context, page, errors } = await newPage(VIEWPORTS[3]);
  await check('곡 선택: KEY 모드 [4 KEY][6 KEY][8 KEY], 채보 있는 모드만 선택, 4 KEY 전용 곡 안내', async () => {
    await page.goto(`${BASE}/songs`);
    await page.locator(`.song-card[data-song="demo-beat"]`).click();
    assert.deepEqual(await page.locator('#keyGroup label').allTextContents(), ['4 KEY', '6 KEY', '8 KEY']);
    assert.deepEqual(await page.locator('#keyGroup input').evaluateAll(els => els.map(e => e.disabled)), [false, false, false]);
    assert.ok(await page.locator('#keyNote').isHidden());
    await page.locator('#keyGroup label', { hasText: '6 KEY' }).click();
    assert.match(await page.locator('#playBtn').getAttribute('href'), /&keys=6$/);
    await page.locator('.song-card[data-song="wony-cover-01"]').click();
    assert.deepEqual(await page.locator('#keyGroup input').evaluateAll(els => els.map(e => e.disabled)), [false, true, true]);
    assert.equal(await page.locator('#keyNote').textContent(), '이 곡은 현재 4 KEY 채보만 지원합니다.');
    assert.match(await page.locator('#playBtn').getAttribute('href'), /&keys=4$/, '지원하지 않으면 4 KEY 로');
    // 주소로 직접 들어와도 4 KEY 전용 곡의 8 KEY 는 시작 불가 + 안내
    await page.goto(`${BASE}/game?song=wony-cover-01&diff=hard&keys=8&debug=1`);
    await page.locator('#readyProblem:not([hidden])').waitFor();
    assert.match(await page.locator('#readyProblem').textContent(), /이 곡은 현재 4 KEY 채보만 지원합니다\./);
    assert.equal(await page.locator('#startBtn').isDisabled(), true);
    await page.goto(`${BASE}/settings`);
    assert.deepEqual(await page.locator('#keyModeGroup label').allTextContents(), ['4 KEY', '6 KEY', '8 KEY']);
  });
  await check('설정: KEY 모드별 키 (4 ← ↓ ↑ → · 6 S D F J K L · 8 A S D F J K L ;)', async () => {
    await page.goto(`${BASE}/settings`);
    for (const [n, keys] of [[4, ['←', '↓', '↑', '→']], [6, ['S', 'D', 'F', 'J', 'K', 'L']], [8, ['A', 'S', 'D', 'F', 'J', 'K', 'L', ';']]]) {
      await page.locator('#keyModeGroup label', { hasText: `${n} KEY` }).click();
      assert.deepEqual(await page.locator('.key-btn').allTextContents(), keys, `${n} KEY`);
    }
    await page.locator('#keyModeGroup label', { hasText: '4 KEY' }).click();
  });
  await check('JS console error 없음 (KEY 모드)', async () => assert.deepEqual(errors, []));
  await context.close();
}
for (const lanes of [4, 6, 8]) {
  const labels = { 4: '← ↓ ↑ →', 6: 'S D F J K L', 8: 'A S D F J K L ;' }[lanes];
  for (const vp of [VIEWPORTS[0], VIEWPORTS[1], VIEWPORTS[3]]) {
    const { context, page, errors } = await newPage(vp);
    const portraitPhone = vp.mobile && vp.height > vp.width;
    if (lanes === 8 && portraitPhone) {
      await check(`8 KEY @ ${vp.name}: 버튼이 44px 보다 작아지는 세로 화면은 시작하지 않고 가로 화면 안내`, async () => {
        await page.goto(`${BASE}/game?song=${SONG}&diff=hard&keys=8&debug=1`);
        // 채보를 불러오는 동안은 "채보 준비 중" → 불러온 뒤 버튼 폭을 재고 가로 화면 안내
        await page.waitForFunction(() => /가로 화면으로 돌려주세요/.test(document.getElementById('readyProblem').textContent), null, { timeout: 10000 });
        assert.match(await page.locator('#readyProblem').textContent(), /8 KEY는 이 화면에서 버튼이 너무 작아요\. 가로 화면으로 돌려주세요\./);
        assert.equal(await page.locator('#startBtn').isDisabled(), true);
        await page.setViewportSize({ width: vp.height, height: vp.width });   // 가로로 돌림
        await page.locator('#startBtn:not([disabled])').waitFor({ timeout: 10000 });
        const widths = await page.locator('.lane-btn').evaluateAll(els => els.map(e => e.getBoundingClientRect().width));
        assert.ok(widths.every(w => w >= 44), `가로: 버튼 ${widths.map(Math.round)}`);
        assert.deepEqual(errors, []);
      });
      await context.close();
      continue;
    }
    await check(`${lanes} KEY @ ${vp.name}: 레인/키/터치 버튼 ${lanes}개, 자동 플레이 PERFECT, 겹침·잘림 없음`, async () => {
      await startGame(page, `diff=hard&autoplay=1&keys=${lanes}`);
      assert.equal(await page.locator('#keyHint').textContent(), labels);
      assert.equal(await page.locator('.lane-btn').count(), lanes);
      assert.equal(await page.locator('#readyKeys').textContent(), `${lanes} KEY`);
      if (vp.mobile) assert.equal(await page.locator('#touch').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), lanes);
      await page.waitForFunction(() => window.__wonyRhythm.snapshot().judged >= 15, null, { timeout: 30000 });
      const s = await snap(page);
      assert.equal(s.laneCount, lanes);
      assert.equal(s.counts.PERFECT, s.judged, JSON.stringify(s.counts));
      assert.equal(s.playbackRate, 1);
      assert.ok(await noHorizontalScroll(page));
      if (vp.mobile) {
        const buttons = await page.locator('.lane-btn').evaluateAll(els => els.map(e => e.getBoundingClientRect().toJSON()));
        for (let i = 0; i < buttons.length; i++) {
          assert.ok(buttons[i].right <= vp.width + 1 && buttons[i].height >= 56 && buttons[i].width >= 44, `button ${i} ${JSON.stringify(buttons[i])}`);
          if (i) assert.ok(buttons[i].left >= buttons[i - 1].right, 'lane buttons overlap');
        }
        const btn = page.locator('.lane-btn').nth(lanes - 1);
        await btn.evaluate(el => el.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 91, pointerType: 'touch', bubbles: true, cancelable: true })));
        assert.ok(await btn.evaluate(el => el.classList.contains('is-pressed')), `마지막 레인(${lanes - 1}) 터치`);
        await btn.evaluate(el => el.dispatchEvent(new PointerEvent('pointerup', { pointerId: 91, pointerType: 'touch', bubbles: true })));
      } else {
        const lastKey = { 4: 'ArrowRight', 6: 'KeyL', 8: 'Semicolon' }[lanes];
        await page.keyboard.down(lastKey);
        assert.ok(await page.locator('.lane-btn').nth(lanes - 1).evaluate(el => el.classList.contains('is-pressed')), `마지막 레인 키 ${lastKey}`);
        await page.keyboard.up(lastKey);
      }
      assert.deepEqual(errors, []);
    });
    await context.close();
  }
}

// 휴대폰 기기 프로필(UA · DPR · 터치 · 화면 크기)로: 영상 ON/OFF · 주소창 높이 변화에도 판정선 · 터치 버튼 · 하단 위치 동일
results.push('\n[휴대폰 기기 프로필: 영상 ON/OFF 판정선 위치]');
for (const name of ['Pixel 7', 'iPhone 13', 'Galaxy S9+']) {
  const d = devices[name];
  const context = await browser.newContext({ ...d, defaultBrowserType: undefined });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`${BASE}/rhythm-login?ticket=${encodeURIComponent(servers.ticket(MEMBER))}&next=/`);
  const measure = async (video, keys) => {
    await page.goto(`${BASE}/game?song=${SONG}&diff=hard&keys=${keys}&video=${video}&debug=1`);
    await page.locator('#startBtn').waitFor();
    await page.waitForFunction(() => window.__wonyRhythm.snapshot().layout);
    await page.waitForTimeout(100);
    const s = await snap(page);
    const touch = await page.locator('#touch').boundingBox();
    const stage = await page.locator('#stage').boundingBox();
    const vh = await page.evaluate(() => innerHeight);
    return { judgeFromBottom: vh - s.layout.judgeScreenY, touchFromBottom: touch && Math.round(vh - touch.y),
      stageBottomGap: Math.round(vh - (stage.y + stage.height)), stageTop: Math.round(stage.y), videoOff: await page.evaluate(() => document.body.classList.contains('video-off')) };
  };
  for (const orient of ['portrait', 'landscape']) {
    const base = orient === 'portrait' ? d.viewport : { width: d.viewport.height, height: d.viewport.width };
    for (const keys of orient === 'portrait' ? [4, 6] : [4, 6, 8]) {
      await check(`${name} ${orient} ${keys} KEY: 영상 ON / OFF · 주소창 높이 변화 → 판정선 · 터치 버튼 동일`, async () => {
        for (const bar of [0, 56]) {   // 주소창이 보일 때(높이 -56px) / 숨었을 때
          await page.setViewportSize({ width: base.width, height: base.height - bar });
          const on = await measure(1, keys);
          const off = await measure(0, keys);
          assert.equal(on.videoOff, false);
          assert.equal(off.videoOff, true);
          assert.ok(Math.abs(on.judgeFromBottom - off.judgeFromBottom) <= 1, `판정선 ON ${on.judgeFromBottom} / OFF ${off.judgeFromBottom} (bar ${bar})`);
          assert.equal(on.touchFromBottom, off.touchFromBottom, `터치 버튼 ON ${on.touchFromBottom} / OFF ${off.touchFromBottom}`);
          assert.equal(on.stageBottomGap, off.stageBottomGap, '게임 영역 아래 끝');
          assert.ok(off.stageTop < on.stageTop || orient === 'landscape', '영상 OFF 면 레인이 위로 길어짐');
          assert.ok(on.touchFromBottom > 0 && on.touchFromBottom < base.height * 0.25, `터치 영역은 화면 아래 ${on.touchFromBottom}`);
        }
      });
    }
  }
  await check(`${name}: JS console error 없음`, async () => assert.deepEqual(errors, []));
  await context.close();
}

// ── 비로그인: 모든 화면 대신 로그인 안내, 게임 · 영상은 열리지 않음 ──
results.push('\n[비로그인 (WONY PHONE 로그인 필요)]');
for (const vp of [VIEWPORTS[0], VIEWPORTS[1], VIEWPORTS[3]]) {
  const { context, page, errors } = await newPage(vp, { login: false });
  const requests = [];
  page.on('request', r => requests.push(r.url()));
  for (const path of ['/', '/game?song=demo-beat&diff=easy', '/songs', '/ranking', '/shop', '/scores', '/settings']) {
    await check(`${vp.name} ${path}: 로그인 안내 (게임 시작 · 곡 플레이 불가)`, async () => {
      await page.goto(BASE + path);
      await page.waitForLoadState('networkidle');
      assert.equal(await page.locator('body').getAttribute('data-page'), 'login');
      assert.equal(await page.locator('#loginTitle').textContent(), '로그인이 필요한 서비스입니다.');
      assert.match(await page.locator('.login-card').textContent(), /WONY PHONE에 로그인한 뒤\s*리듬게임을 이용해주세요\./);
      assert.equal(await page.locator('#phoneLink').textContent(), 'WONY PHONE으로 이동');
      assert.equal(await page.locator('#phoneLink').getAttribute('href'), PHONE_URL);
      assert.ok(await page.locator('#phoneLink').isVisible());
      assert.equal(await page.locator('#startBtn, #playBtn, .menu').count(), 0, '게임 · 메뉴 없음');
      assert.ok(await noHorizontalScroll(page));
      assert.deepEqual(await smallTargets(page), []);
    });
  }
  await check(`${vp.name}: 영상 · 기록 · 츄르 요청 없음, localStorage 회원 데이터 없음`, async () => {
    assert.ok(!requests.some(u => u.endsWith('.mp4') || u.includes('/js/game.js')), requests.filter(u => u.endsWith('.mp4')).join(','));
    assert.ok(!requests.some(u => /\/api\/rhythm\/(results|records|ranking)/.test(u)));
    const keys = await storageKeys(page);
    assert.ok(keys.every(k => ALLOWED_STORAGE.includes(k)), `${keys}`);
    const status = await page.evaluate(async () => (await fetch('/api/rhythm/results', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status);
    assert.equal(status, 401, '비로그인 저장 API 거절');
  });
  await check(`${vp.name}: 만료/재사용 입장권 → 로그인 안내 + 실패 문구, WONY PHONE 이동 버튼`, async () => {
    await page.goto(`${BASE}/rhythm-login?ticket=v1.bad.sig&next=/game`);
    assert.equal(await page.locator('body').getAttribute('data-page'), 'login');
    assert.match(await page.locator('#loginMessage').textContent(), /만료되었거나 이미 사용/);
    await page.locator('#phoneLink').click({ noWaitAfter: true, trial: true });
  });
  // 위에서 일부러 보낸 비로그인 저장 요청(401)만 예외
  await check(`${vp.name}: 비로그인 화면 JS console error 없음`, async () => assert.deepEqual(errors.filter(e => !/401/.test(e)), []));
  await context.close();
}

await browser.close();
servers.stop();
console.log(results.join('\n'));
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
