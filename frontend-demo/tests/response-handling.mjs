// 분석 시작 응답이 비었거나 JSON이 아니어도 'Unexpected end of JSON input' 대신 실제 원인을 보여주는지 확인한다.
import {chromium} from 'playwright';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const base=process.env.WONY_BASE_URL||'http://127.0.0.1:8000';
const dir=mkdtempSync(join(tmpdir(),'wony-response-'));const file=join(dir,'clip.mp4');
execFileSync('ffmpeg',['-v','error','-y','-f','lavfi','-i','testsrc=s=320x240:r=10','-t','2','-pix_fmt','yuv420p','-c:v','libx264',file]);
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
const cases=[
 ['502 empty body',{status:502,body:''},/HTTP 502/],
 ['500 html',{status:500,contentType:'text/html',body:'<html><body><h1>Internal Server Error</h1></body></html>'},/HTTP 500\): Internal Server Error/],
 ['503 plain text',{status:503,contentType:'text/plain',body:'Service Unavailable: instance restarting'},/instance restarting/],
 ['200 empty body',{status:200,contentType:'application/json',body:''},/서버 응답이 비어 있습니다/],
 ['204 no content',{status:204,body:''},/서버 응답이 비어 있습니다/],
 ['200 html',{status:200,contentType:'text/html',body:'<html><body>Render login</body></html>'},/JSON이 아닌 응답[\s\S]*Render login/],
 ['401 json',{status:401,contentType:'application/json',body:JSON.stringify({detail:'[auth_required] Open from WONY PHONE with an admin account'})},/세션이 만료/],
 ['503 coded json',{status:503,contentType:'application/json',body:JSON.stringify({detail:'[server_out_of_memory] The server ran out of memory during analysis'})},/서버 메모리가 부족/],
 ['network abort',null,/서버와 연결이 끊겼습니다/]];
try{
 const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/demo/validation/');
 await page.locator('#validation-file').setInputFiles(file);await page.waitForFunction(()=>document.querySelector('#selection-video').readyState>=2);
 await page.locator('#capture-selection').click();const canvas=page.locator('#selection-canvas');await canvas.scrollIntoViewIfNeeded();const r=await canvas.boundingBox();
 await page.mouse.move(r.x+r.width*.3,r.y+r.height*.2);await page.mouse.down();await page.mouse.move(r.x+r.width*.6,r.y+r.height*.8,{steps:5});await page.mouse.up();await page.locator('#confirm-target').check();
 const seen=[];
 for(const [name,reply,expected] of cases){
  await page.unroute('**/api/validation');
  await page.route('**/api/validation',route=>reply?route.fulfill(reply):route.abort('connectionreset'));
  await page.locator('#validate-target').click();
  await page.waitForFunction(()=>!document.querySelector('#validate-target').disabled);
  const text=await page.locator('#validation-status').textContent();seen.push([name,text]);
  assert.match(text,expected,name);assert.doesNotMatch(text,/Unexpected end of JSON|Failed to execute 'json'/,name);
 }
 assert.ok(page.url().includes('/demo/validation/'));assert.deepEqual(errors,[]);
 console.log('PASS: analysis start shows the real cause for empty/HTML/text/204/401/coded JSON/network failures',JSON.stringify(seen));
}finally{await browser.close();rmSync(dir,{recursive:true,force:true});}
