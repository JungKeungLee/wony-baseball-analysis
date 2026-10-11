import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const base=process.env.WONY_BASE_URL||'http://127.0.0.1:8000';
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/demo/');assert.equal(await page.locator('.main-nav a').count(),3);assert.equal(await page.locator('#motion-tab').count(),0);assert.equal(await page.locator('#scouting-tab').count(),0);
 await page.locator('#quick-player').fill('UNIFIED-DEMO');await page.locator('#quick-date').fill('2026-10-12');await page.locator('#quick-context').fill('same-camera');await page.locator('#quick-demo').click();await page.waitForURL('**/demo/analysis/*');await page.waitForFunction(()=>document.querySelector('#report-meta').textContent.includes('2026-10-12'));
 assert.equal(await page.locator('[data-report-role]').count(),6);assert.equal(await page.locator('[data-report-role="defense"]').isDisabled(),true);assert.match(await page.locator('#source-badge').textContent(),/DEMO/);
 await page.locator('[data-report-role="batter"]').click();assert.equal(await page.locator('#role-detail').isVisible(),true);assert.ok(await page.locator('#role-metrics .angle-item').count()>0);
 await page.locator('#play-list button').first().click();await page.waitForFunction(()=>document.querySelector('#frame-counter').textContent.includes('FRAME'));
 assert.equal(await page.locator('[data-mode="original"]').isDisabled(),true);assert.equal(await page.locator('#skeleton-view').isVisible(),true);
 await page.locator('[data-mode="pose"]').click();assert.equal(await page.locator('#pose-view').isVisible(),true);assert.equal(await page.locator('#skeleton-view').isVisible(),false);assert.equal(await page.locator('#three-stage canvas').count(),1);
 await page.locator('[data-view="side"]').click();await page.locator('#timeline').fill('12');await page.locator('#timeline').dispatchEvent('input');await page.locator('#play').click();await page.waitForTimeout(400);await page.locator('#play').click();
 assert.ok(await page.locator('#keyframe-list .keyframe').count()>0);await page.locator('#keyframe-list .keyframe:not(:disabled)').first().click();
 await page.screenshot({path:'../docs/screenshots/unified-report.png',fullPage:true});
 await page.locator('[data-report-role="all"]').click();assert.equal(await page.locator('#overview').isVisible(),true);
 const history=await (await page.request.get(base+'/api/players/UNIFIED-DEMO/history?source=demo')).json();assert.ok(history.count>=1);
 for(const role of ['defense','catcher','pitcher','baserunning']){const response=await page.request.post(base+'/api/demo/'+role);assert.equal(response.status(),200);const r=await response.json();await page.goto(base+'/demo/analysis/'+r.id);await page.waitForFunction(()=>document.querySelector('#report-meta').textContent.length>0);assert.equal(await page.locator(`[data-report-role="${role}"]`).isDisabled(),false);await page.locator(`[data-report-role="${role}"]`).click();await page.locator('#play-list button').first().click();assert.equal(await page.locator('#play-detail').isVisible(),true);}
 await page.goto(base+'/demo/analyses/');await page.locator('#records-source').selectOption('demo');await page.waitForFunction(()=>document.querySelector('#records-status').textContent.includes('DEMO'));assert.ok(await page.locator('#records-list a').count()>0);await page.locator('#records-list a').first().click();await page.waitForURL('**/demo/analysis/*');
 await page.goto(base+'/demo/broadcast/');await page.locator('#broadcast-live-tab').click();assert.equal(await page.locator('#broadcast-live-panel').isVisible(),true);assert.equal(await page.locator('#broadcast-vod-panel').isVisible(),false);await page.locator('#broadcast-vod-tab').click();assert.equal(await page.locator('#broadcast-vod-panel').isVisible(),true);
 await page.goto(base+'/demo/live/');await page.waitForURL('**/demo/broadcast/?tab=live');assert.equal(await page.locator('#broadcast-live-panel').isVisible(),true);
 await page.setViewportSize({width:390,height:844});for(const path of ['/demo/','/demo/broadcast/','/demo/analyses/']){await page.goto(base+path);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),path);}
 assert.deepEqual(errors,[]);console.log('PASS: three-item navigation, canonical unified report, 5 roles/disabled missing roles, play-linked 2D/3D/cameras/playback/keyframes, original-unavailable handling, source-separated records, growth, LIVE/VOD tabs, legacy redirects and mobile layout.');
}finally{await browser.close();}
