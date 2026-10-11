import {chromium} from 'playwright';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const base=process.env.WONY_BASE_URL||'http://127.0.0.1:8000';
const dir=mkdtempSync(join(tmpdir(),'wony-broadcast-'));const file=join(dir,'empty.mp4');
execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','color=c=black:s=160x120:r=10','-t','2','-c:v','mpeg4',file]);
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1100}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/demo/broadcast/');await page.locator('#broadcast-example').click();await page.waitForFunction(()=>document.querySelector('#broadcast-segments').textContent.includes('DEMO-1'));
 assert.match(await page.locator('#broadcast-status').textContent(),/DEMO/);assert.equal(await page.locator('#broadcast-track .segment-bar').count(),1);
 await page.locator('#broadcast-panel').screenshot({path:'../docs/screenshots/broadcast.png'});
 const response=await page.request.post(base+'/api/analyze',{multipart:{mode:'auto_segments',video:{name:'empty.mp4',mimeType:'video/mp4',buffer:readFileSync(file)}}});assert.equal(response.status(),202);const created=await response.json();
 async function finish(id){for(let n=0;n<60;n++){const job=await (await page.request.get(base+'/api/broadcasts/'+id)).json();if(!['queued','running'].includes(job.status))return job;await page.waitForTimeout(500);}throw new Error('Job timeout');}
 let job=await finish(created.id);assert.equal(job.status,'completed');assert.equal(job.baseball_segments.length,0);assert.equal(job.analyses.length,0);
 await page.locator('#broadcast-file').setInputFiles(file);await page.locator('#broadcast-corrections').fill('[{"start":0,"end":2,"role":"batter"}]');const submitted=page.waitForResponse(r=>r.url().endsWith('/api/vod')&&r.request().method()==='POST');await page.locator('#broadcast-scan').click();const manual=await (await submitted).json();
 await page.waitForFunction(()=>document.querySelector('#broadcast-segments').textContent.includes('분석 결과'),{timeout:30000});
 await page.getByRole('button',{name:/분석 결과 00:00:00/}).click();await page.waitForURL('**/demo/analysis/*');await page.waitForFunction(()=>document.querySelector('#report-meta').textContent.length>0);await page.locator('[data-report-role="batter"]').click();await page.locator('#play-list button').first().click();assert.equal(await page.locator('[data-mode="original"]').isDisabled(),false);await page.locator('[data-mode="original"]').click();assert.equal(await page.locator('#original-view').isVisible(),true);await page.goto(base+'/demo/broadcast/?job_id='+manual.id);await page.waitForFunction(()=>document.querySelector('#broadcast-segments').textContent.includes('manual-1'));
 await page.locator('#broadcast-segments').getByRole('button',{name:'수정',exact:true}).click();assert.match(await page.locator('#broadcast-corrections').inputValue(),/batter/);
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));assert.deepEqual(errors,[]);
 console.log('PASS: DEMO timeline, actual sparse ffmpeg scan with no baseball/no analysis, manual segment-only pose pipeline, result visualization navigation, correction and mobile layout.');
}finally{await browser.close();rmSync(dir,{recursive:true,force:true});}
