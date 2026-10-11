import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const base=process.env.WONY_BASE_URL||'http://127.0.0.1:8000';
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/demo/');await page.locator('#quick-advanced > summary').click();
 await page.locator('#quick-role').selectOption('batter');const player='TOOLS-'+Date.now();await page.locator('#quick-player').fill(player);await page.locator('#quick-context').fill('fixed-demo');
 await page.locator('#quick-capture-angle').fill('side');await page.locator('#quick-capture-environment').selectOption('vr');await page.locator('#quick-capture-vr').fill('synthetic-fixture');await page.locator('#quick-capture-quality').selectOption('good');await page.locator('#quick-capture-motion').selectOption('fixed');
 await page.locator('#quick-demo').click();await page.waitForURL('**/demo/analysis/*');await page.waitForFunction(()=>document.querySelector('#player-tools').children.length===5);
 const id=page.url().split('/').at(-1);const result=await (await page.request.get(base+'/api/analysis/'+id)).json();
 assert.equal(result.capture_context.camera_angle,'side');assert.equal(result.synthetic_demo,true);assert.equal(result.scouting_report.player_tools.contact.score,null);
 assert.match(await page.locator('#source-badge').textContent(),/DEMO/);
 assert.match(await page.locator('#overview h2').first().textContent(),/BASEBALL SCOUT REPORT/);
 assert.match(await page.locator('#player-tools [data-tool="speed"] .tool-state').textContent(),/데이터 부족/);
 assert.equal(await page.locator('#player-tools [data-tool="power"] details').evaluate(e=>e.open),false);
 await page.locator('#player-tools [data-tool="power"] details > summary').click();
 assert.match(await page.locator('#player-tools [data-tool="power"] details').textContent(),/confidence/);
 assert.match(await page.locator('#player-tools [data-tool="power"] details').textContent(),/torso_lengths_per_second/);
 await page.locator('#player-tools [data-tool="power"] .evidence-link').first().click();assert.equal(await page.locator('#play-detail').isVisible(),true);assert.equal(await page.locator('#skeleton-view').isVisible(),true);
 await page.locator('[data-mode="pose"]').click();assert.equal(await page.locator('#pose-view').isVisible(),true);assert.equal(await page.locator('#three-stage canvas').count(),1);
 await page.locator('[data-report-role="batter"]').click();assert.match(await page.locator('#role-scout-summary').textContent(),/컨택/);assert.ok(await page.locator('#role-assessments .tool-card').count()>=7);
 await page.locator('[data-report-role="all"]').click();await page.locator('#player-tools [data-tool="power"] details > summary').click();
 await page.screenshot({path:'../docs/screenshots/player-tools.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:'../docs/screenshots/player-tools-mobile.png',fullPage:true});
 const history=await (await page.request.get(base+'/api/players/'+player+'/history?source=demo')).json();assert.ok(history.points.some(p=>p.analysis_id===id&&p.capture_context.environment==='vr'));

 const cohort=[result];for(let i=0;i<2;i++){const response=await page.request.post(base+'/api/demo/batter',{multipart:{player_id:player,comparison_context:'fixed-demo',capture_context:JSON.stringify(result.capture_context)}});assert.equal(response.status(),200);cohort.push(await response.json());}
 const aggregate=await (await page.request.get(base+'/api/players/'+player+'/scouting-report?source=demo')).json();assert.equal(aggregate.repeated_movement.sample_count,3);
 const single=await (await page.request.get(base+'/api/reports/'+id)).json();
 // UI grouping fixture uses actual computed DEMO reports and signatures; never a player grade.
 const group={...single,...aggregate,entries:cohort.map((analysis,i)=>({analysis,start:i*4,end:i*4+4,source_url:null,timestamp_origin:'clip_relative'}))};
 const last=group.entries.at(-1),legacy={...last.analysis.scouting_report};last.scouting_extension={role_summary:legacy.role_summary};delete legacy.role_summary;delete legacy.player_tools;last.analysis={...last.analysis,scouting_report:legacy};
 await page.route('**/api/reports/'+id,route=>route.fulfill({json:group}));await page.goto(base+'/demo/analysis/'+id);await page.waitForFunction(()=>document.querySelector('#player-tools').children.length===5);
 await page.locator('[data-report-role="batter"]').click();assert.equal(await page.locator('#role-assessments .tool-card').count(),7);
 assert.match(await page.locator('#role-assessments [data-tool="swing_consistency"]').textContent(),/3개의 손 경로/);
 await page.locator('#role-assessments [data-tool="swing_consistency"] details > summary').click();assert.equal(await page.locator('#role-assessments [data-tool="swing_consistency"] .evidence-link').count(),3);
 await page.locator('#role-assessments [data-tool="swing_consistency"] .evidence-link').first().click();assert.equal(await page.locator('#skeleton-view').isVisible(),true);
 await page.unroute('**/api/reports/'+id);
 await page.goto(base+'/demo/broadcast/');await page.locator('#vod-advanced > summary').click();assert.equal(await page.locator('#vod-capture-angle').count(),1);await page.locator('#broadcast-live-tab').click();await page.locator('#live-advanced > summary').click();assert.equal(await page.locator('#live-capture-angle').count(),1);
 assert.deepEqual(errors,[]);
 console.log('PASS: PLAYER TOOLS order and 5 cards, DEMO labeling, missing SPEED, collapsed confidence/raw proxies, evidence opens existing 2D/3D play, role scouting summaries, declared capture conditions/history, compatible three-candidate consistency and one role assessment set and old-record extension fallback, LIVE/VOD capture forms, mobile layout.');
}finally{await browser.close();}
