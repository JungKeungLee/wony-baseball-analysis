// 화면 확인용 스크린샷 (테스트 아님): node tests/screens.mjs <출력 폴더>
// 테스트 서버(tests/servers.mjs)를 띄우고 로그인한 뒤 주요 화면을 저장한다 (휴대폰은 Playwright 기기 프로필).
import { chromium, devices } from 'playwright';
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
const phone = devices['Pixel 7'];
const SHOTS = [
  { name: 'pc-4key', ctx: { viewport: { width: 1440, height: 900 } }, query: 'keys=4&video=1' },
  { name: 'portrait-4key-video-on', ctx: phone, query: 'keys=4&video=1' },
  { name: 'portrait-4key-video-off', ctx: phone, query: 'keys=4&video=0' },
  { name: 'landscape-8key', ctx: { ...phone, viewport: { width: phone.viewport.height, height: phone.viewport.width } }, query: 'keys=8&video=1' },
  { name: 'landscape-6key-video-off', ctx: { ...phone, viewport: { width: phone.viewport.height, height: phone.viewport.width } }, query: 'keys=6&video=0' },
];
try {
  for (const shot of SHOTS) {
    const context = await browser.newContext({ ...shot.ctx, defaultBrowserType: undefined });
    const page = await context.newPage();
    await page.goto(`${BASE}/rhythm-login?ticket=${encodeURIComponent(servers.ticket(MEMBER))}&next=/`);
    await page.goto(`${BASE}/game?song=demo-beat&diff=hard&autoplay=1&${shot.query}`);
    await page.locator('#startBtn:not([disabled])').click();
    await page.waitForFunction(() => window.__wonyRhythm.snapshot().combo >= 14, null, { timeout: 30000 });
    await page.screenshot({ path: path.join(OUT, `${shot.name}.png`) });
    const s = await page.evaluate(() => { const x = window.__wonyRhythm.snapshot(); return { judgeY: x.layout.judgeScreenY, vh: innerHeight, lanes: x.laneCount, rate: x.playbackRate }; });
    console.log(shot.name, JSON.stringify(s));
    await context.close();
  }
} finally {
  await browser.close();
  servers.stop();
}
