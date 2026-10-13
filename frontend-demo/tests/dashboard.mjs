// Simplified home: one big start button, recent analyses from the server list, small broadcast link.
// localStorage is only a labeled fallback. Records page shows date / role · length / status / result only.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const base=process.env.WONY_BASE_URL||'http://127.0.0.1:8000';
const item=(id,extra)=>({id,created_at:'2026-10-13T01:00:00+00:00',analysis_date:'2026-10-13',role:'pitcher',role_source:'automatic',role_hint:'auto',automatic_role:'pitcher',duration_sec:20.0,tracking_status:'tracking',tracking_lost_at:null,reidentification_required:false,viewpoint:'third_person',report_status:'completed',analysis_status:'input_validation_only',player_tools_status:'insufficient_data',player_tools_scored:0,player_tools_total:5,sampled_frames:201,usable_full_body_frames:6,estimated_3d_frames:6,source_name:'wony-pitcher-001.mp4',synthetic_demo:false,validation_only:true,growth_history_included:false,report_url:'/demo/validation/report/'+id,...extra});
const lost=item('00000000-0000-4000-8000-000000000002',{created_at:'2026-10-13T02:00:00+00:00',role:'batter',role_source:'user_provided',automatic_role:'unknown',duration_sec:32,tracking_status:'reidentification_required',tracking_lost_at:1.1,analysis_status:'insufficient_pose',source_name:null});
const pitch=item('00000000-0000-4000-8000-000000000001');
const listing={items:[lost,pitch],total:2,offset:0,limit:3,skipped:1,growth_history_included:false};
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
try{
 const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/validation/reports?*',route=>route.fulfill({json:listing}));
 await page.goto(base+'/demo/');await page.waitForFunction(()=>document.querySelectorAll('#recent-analyses .history-item').length===2);
 assert.equal(await page.locator('#start-analysis').textContent(),'새 영상 분석');assert.equal(await page.locator('#start-analysis').getAttribute('href'),'/demo/validation/');
 assert.equal(await page.locator('.main-nav a').count(),3);assert.equal(await page.locator('[data-demo-role]').count(),0);
 const visible=await page.locator('main').evaluate(m=>[...m.children].filter(c=>c.id!=='quick-advanced').map(c=>c.innerText).join(' '));
 for(const jargon of ['PLAYER TOOLS','confidence','tracking','insufficient','추적 상태'])assert.ok(!visible.includes(jargon),jargon);
 const rows=await page.locator('#recent-analyses .history-item').allInnerTexts();
 assert.match(rows[0],/타자/);assert.match(rows[0],/32초/);assert.match(rows[0],/WONY를 잠시 찾지 못했습니다/);assert.match(rows[1],/투수/);assert.match(rows[1],/분석 완료/);
 assert.equal(await page.locator('#recent-analyses .history-item').first().getAttribute('href'),lost.report_url);
 assert.equal(await page.locator('.home-broadcast').getAttribute('href'),'/demo/broadcast/');assert.match(await page.locator('.home-extra').innerText(),/고급 기능[\s\S]*긴 방송·VOD에서 야구 구간 찾기/);assert.equal(await page.locator('.main-nav a[href="/demo/broadcast/"]').count(),0);assert.equal(await page.locator('#records-notice').isVisible(),false);

 // Server failure → only then the browser-local fallback, clearly labeled.
 await page.evaluate(()=>localStorage.setItem('wony.recentValidations',JSON.stringify([{id:'local-1',url:'/demo/validation/report/00000000-0000-4000-8000-000000000009',date:'2026-10-01',saved_at:'2026-10-01T00:00:00Z',role:'catcher',duration:12,status:'insufficient_pose',lost_at:null}])));
 await page.unroute('**/api/validation/reports?*');await page.route('**/api/validation/reports?*',route=>route.fulfill({status:500,json:{detail:'down'}}));
 await page.reload();await page.waitForFunction(()=>!document.querySelector('#records-notice').hidden);
 assert.match(await page.locator('#records-notice').textContent(),/임시 저장/);assert.match(await page.locator('#recent-analyses').innerText(),/포수[\s\S]*분석할 장면이 부족합니다/);

 // Records page: only date / role / length / status / result by default.
 await page.unroute('**/api/validation/reports?*');await page.route('**/api/validation/reports?*',route=>route.fulfill({json:{...listing,limit:30}}));
 await page.goto(base+'/demo/analyses/');await page.waitForFunction(()=>document.querySelector('#records-status').textContent.includes('WONY 영상 분석 2개'));
 const card=page.locator('#records-list .kind-wony').first().locator('xpath=..');
 assert.equal(await card.locator('.record-date').textContent(),'2026.10.13');assert.equal(await card.locator('.record-line').textContent(),'타자 · 32초');assert.equal(await card.locator('.result-link').textContent(),'결과 보기');assert.equal(await card.locator('dt').count(),0);assert.match(await card.innerText(),/WONY를 잠시 찾지 못했습니다/);
 assert.ok(!(await page.locator('#records-list').innerText()).includes('추적 상태'));
 await page.locator('#records-source').selectOption('wony');await page.waitForFunction(()=>document.querySelectorAll('#records-list .recent-card').length===2);
 assert.ok((await page.locator('#records-list .recent-kind').allTextContents()).every(b=>b==='WONY 영상 분석'));
 await page.setViewportSize({width:390,height:844});for(const path of ['/demo/','/demo/analyses/','/demo/validation/']){await page.goto(base+path);await page.waitForTimeout(400);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),path);}
 assert.deepEqual(errors,[]);
 console.log('PASS: simplified home (single start CTA, no technical terms, server recent analyses with plain statuses, small broadcast link), labeled local fallback only on server failure, simple records cards and filter, mobile layout.');
}finally{await browser.close();}
