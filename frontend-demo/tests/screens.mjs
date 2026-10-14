// 화면 확인용 스크린샷 (테스트 아님): node tests/screens.mjs <출력 폴더>
// 테스트 서버(tests/servers.mjs)를 띄우고 로그인한 뒤 주요 화면을 3가지 크기로 저장한다.
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { startServers } from './servers.mjs';

const OUT = process.argv[2] || 'screens';
mkdirSync(OUT, { recursive: true });
const MEMBER = { id: randomUUID(), nickname: '워니팬' };
const servers = await startServers({ appPort: 8769, pgPort: 54397, members: [MEMBER] });
const { BASE } = servers;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const VPS = [
  { name: 'pc', width: 1440, height: 900, mobile: false },
  { name: 'portrait', width: 390, height: 844, mobile: true },
  { name: 'landscape', width: 844, height: 390, mobile: true },
];
try {
  for (const vp of VPS) {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.mobile, hasTouch: vp.mobile, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.goto(`${BASE}/rhythm-login?ticket=${encodeURIComponent(servers.ticket(MEMBER))}&next=/`);
    await page.locator('#walletBadge:not([hidden])').waitFor();
    await page.screenshot({ path: path.join(OUT, `${vp.name}-home.png`), fullPage: true });
    await page.goto(`${BASE}/settings`);
    await page.locator('#uiSkin').scrollIntoViewIfNeeded();
    await page.locator('#uiSkin').focus();
    await page.screenshot({ path: path.join(OUT, `${vp.name}-settings.png`) });
    for (const video of ['1', '0']) {
      await page.goto(`${BASE}/game?song=demo-beat&diff=hard&autoplay=1&video=${video}`);
      await page.locator('#startBtn:not([disabled])').click();
      await page.waitForFunction(() => window.__wonyRhythm.snapshot().combo >= 12, null, { timeout: 30000 });
      await page.keyboard.down('ArrowLeft');
      await page.screenshot({ path: path.join(OUT, `${vp.name}-game-video${video}.png`) });
      await page.keyboard.up('ArrowLeft');
      await page.evaluate(() => window.__wonyRhythm.pause());
    }
    await page.goto(`${BASE}/game?song=demo-beat&diff=hell&debug=1`);   // 아무것도 안 누르면 GAME OVER
    await page.locator('#startBtn:not([disabled])').click();
    await page.locator('#resultOverlay').waitFor({ state: 'visible', timeout: 30000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(OUT, `${vp.name}-result.png`) });
    await context.close();
  }
} finally {
  await browser.close();
  servers.stop();
}
