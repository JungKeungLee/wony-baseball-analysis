import {chromium} from 'playwright';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const base=process.env.WONY_BASE_URL||'http://127.0.0.1:8000';
const dir=mkdtempSync(join(tmpdir(),'wony-modes-'));const file=join(dir,'black.mp4');
execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=c=black:s=160x120:r=10','-t','8','-c:v','mpeg4',file]);
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1100}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/demo/broadcast/');await page.locator('#broadcast-file').setInputFiles(file);await page.locator('#vod-mode').selectOption('exact');await page.locator('#vod-start').fill('00:00:01');await page.locator('#vod-end').fill('00:00:03');await page.locator('#vod-role').selectOption('batter');await page.locator('#broadcast-scan').click();
 await page.waitForFunction(()=>document.querySelector('#broadcast-segments').textContent.includes('분석 결과'),null,{timeout:30000});
 await page.evaluate(()=>{const p=document.createElement('p');p.textContent='TEST · 생성 검은 영상, 실제 방송/야구 정확도 검증 아님';document.querySelector('main').prepend(p);});
 await page.screenshot({path:'../docs/screenshots/vod.png',fullPage:true});
 await page.getByRole('button',{name:/분석 결과 00:00:01/}).click();await page.waitForURL('**/demo/analysis/*');await page.waitForFunction(()=>document.querySelector('#report-meta').textContent.length>0);await page.locator('[data-report-role="batter"]').click();await page.locator('#play-list button').first().click();assert.equal(await page.locator('[data-mode="original"]').isDisabled(),false);
 const r=await page.request.post(base+'/api/vod',{multipart:{mode:'approximate',center_time:'00:00:04',search_window_minutes:'1',video:{name:'black.mp4',mimeType:'video/mp4',buffer:readFileSync(file)}}});assert.equal(r.status(),202);const created=await r.json();
 let job;for(let n=0;n<30;n++){job=await (await page.request.get(base+'/api/broadcasts/'+created.id)).json();if(job.status==='completed')break;await page.waitForTimeout(300);}assert.equal(job.status,'completed');assert.equal(job.analyses.length,0);assert.equal(job.discovery.search_start,0);assert.ok(job.discovery.search_end<=8.1);
 await page.goto(base+'/demo/live/');await page.locator('#live-file').setInputFiles(file);await page.locator('#live-interval').fill('5');await page.locator('#live-start').click();await page.waitForFunction(()=>document.querySelector('#live-state').textContent==='WATCHING');
 assert.match(await page.locator('#live-confidence').textContent(),/0%/);assert.equal(await page.locator('#live-results a').count(),0);
 await page.evaluate(()=>{const p=document.createElement('p');p.textContent='TEST · 생성 검은 영상 리플레이, 실제 라이브 방송 아님';document.querySelector('main').prepend(p);});
 await page.screenshot({path:'../docs/screenshots/live.png',fullPage:true});
 await page.locator('#live-role').selectOption('defense');await page.locator('#live-role-save').click();await page.locator('#live-stop').click();await page.waitForFunction(()=>document.querySelector('#live-status').textContent.includes('stopped'),null,{timeout:15000});
 await page.locator('#live-corrections').fill('[{"start":1,"end":2,"role":"catcher"}]');await page.locator('#live-correct').click();await page.waitForURL(/\/demo\/broadcast\/\?.*job_id=/);await page.waitForFunction(()=>document.querySelector('#broadcast-segments').textContent.includes('분석 결과'),null,{timeout:30000});
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.goto(base+'/demo/broadcast/');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
 console.log('PASS: VOD EXACT selected clip and Motion Lab result, APPROXIMATE center range scan/no baseball/no analysis, LIVE file watch without pose, role hint, stop, replay correction through VOD, mobile layouts and no JS errors.');
}finally{await browser.close();rmSync(dir,{recursive:true,force:true});}
