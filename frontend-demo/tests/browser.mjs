import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const base=process.env.WONY_BASE_URL||'http://127.0.0.1:8000';
const screenshotDir=path.join(root,'docs/screenshots');fs.mkdirSync(screenshotDir,{recursive:true});
const errors=[];
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader']});
const page=await browser.newPage({baseURL:base,viewport:{width:1440,height:1200},deviceScaleFactor:1});
page.on('pageerror',error=>errors.push(error.message));
page.on('response',response=>{if(response.status()>=400)errors.push(`HTTP ${response.status()} ${response.url()}`);});
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'wony-browser-'));
try{
  await page.goto(base+'/demo/');
  await page.locator('#demo').click();
  await page.waitForFunction(()=>document.getElementById('source-badge').textContent.includes('실제 영상 분석 결과 아님'));
  await page.waitForFunction(()=>document.getElementById('overlay').readyState>=2);
  assert.equal(await page.locator('#three-stage canvas').count(),1);
  assert.equal(await page.locator('.keyframe').count(),6);
  for(const img of await page.locator('.keyframe img').all())assert.equal((await page.request.get(await img.getAttribute('src'))).status(),200);
  await page.locator('.keyframe[data-stage="swing_start"]').click();
  await page.waitForFunction(()=>!document.getElementById('overlay').seeking);
  assert.equal(await page.locator('.angle-item').count(),5);
  assert.match(await page.locator('#phase-status').textContent(),/추정 후보/);
  await page.locator('[data-view="front"]').click();
  const front=await page.locator('#three-stage canvas').screenshot();
  await page.screenshot({path:path.join(screenshotDir,'batter-front.png'),fullPage:true});
  await page.locator('[data-view="side"]').click();
  const side=await page.locator('#three-stage canvas').screenshot();assert.notDeepEqual(front,side);
  await page.screenshot({path:path.join(screenshotDir,'batter-side.png'),fullPage:true});
  await page.locator('[data-view="rear"]').click();assert.equal(await page.locator('[data-view="rear"]').getAttribute('class'),'selected');
  const bounds=await page.locator('#three-stage canvas').boundingBox();
  await page.mouse.move(bounds.x+bounds.width/2,bounds.y+bounds.height/2);await page.mouse.down();await page.mouse.move(bounds.x+bounds.width*.7,bounds.y+bounds.height*.6,{steps:8});await page.mouse.up();
  await page.locator('#timeline').evaluate(el=>{el.value=5;el.dispatchEvent(new Event('input',{bubbles:true}));});
  assert.match(await page.locator('#frame-counter').textContent(),/006/);
  await page.locator('#play').click();await page.waitForFunction(()=>document.getElementById('overlay').currentTime>.7);
  await page.locator('#play').click();assert(await page.locator('#overlay').evaluate(el=>el.paused));
  await page.locator('.keyframe[data-stage="estimated_impact"]').click();assert.match(await page.locator('#phase-status').textContent(),/미확인 참고/);
  for(const role of ['pitcher','defense','catcher']){
    await page.locator(`[data-role="${role}"]`).click();
    await page.locator('#demo').click();
    await page.waitForFunction(role=>document.getElementById('overlay').src.includes('/assets/')&&document.getElementById('source-badge').textContent.startsWith(({pitcher:'투수',defense:'수비',catcher:'포수'})[role]),role);
    await page.waitForFunction(()=>document.getElementById('overlay').readyState>=2);
    if(role==='pitcher'){
      assert.equal(await page.locator('.keyframe').count(),6);
      await page.locator('.keyframe[data-stage="release"]').click();await page.waitForFunction(()=>!document.getElementById('overlay').seeking);
    }else{
      await page.locator('.keyframe[data-stage="action"]').click();await page.waitForFunction(()=>!document.getElementById('overlay').seeking);
    }
    await page.screenshot({path:path.join(screenshotDir,`${role}.png`),fullPage:true});
  }
  const blank=path.join(temporary,'blank.mp4');
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=black:s=320x240:r=10:d=0.5','-c:v','mpeg4',blank]);
  await page.locator('[data-role="auto"]').click();await page.locator('#upload').setInputFiles(blank);await page.locator('#analyze').click();
  await page.waitForFunction(()=>document.getElementById('status').textContent.includes('insufficient_pose'));
  assert.match(await page.locator('#source-badge').textContent(),/업로드 영상/);
  assert.equal(await page.locator('.keyframe img').count(),0);
  assert.equal(await page.locator('#three-empty').isVisible(),true);
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  assert.deepEqual(errors,[]);
  console.log('PASS: 4 role demos, Three.js rendering, camera views, mouse rotation, play/pause, slider, keyframe jump, reference labels, upload/insufficient pose, responsive layout.');
  console.log('Screenshots: docs/screenshots/{batter-front,batter-side,pitcher,defense,catcher}.png (synthetic demos)');
}finally{await browser.close();fs.rmSync(temporary,{recursive:true,force:true});}
