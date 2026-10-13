import {addCaptureForm,appendCapture} from '/demo/capture.js';
import {requestJson} from '/demo/http.js';
const el=id=>document.getElementById(id);
let job=null,pollTimer=null,sourceURL=null;
const roleNames={batter:'타격',defense:'수비',catcher:'포수',pitcher:'투수',baserunning:'주루',unknown:'역할 미확인'};
const clock=n=>{n=Math.floor(n);return `${String(Math.floor(n/3600)).padStart(2,'0')}:${String(Math.floor(n/60)%60).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;};
const length=s=>s<60?`${Math.round(s)}초`:`${Math.floor(s/60)}분${Math.round(s%60)?` ${Math.round(s%60)}초`:''}`;
const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e;};
const request=requestJson;
const running=data=>['queued','running'].includes(data.status);

// 기본 화면의 선택지(영상/시간)를 고급 설정의 실제 API 값과 동기화한다.
const radio=name=>document.querySelector(`input[name="${name}"]:checked`).value;
function syncSource(){const url=radio('vod-source')==='url';el('vod-url-box').hidden=!url;el('vod-file-box').hidden=url;el('broadcast-scan').disabled=false;}
function syncTime(){const approx=radio('vod-time')==='approx';el('vod-time-box').hidden=!approx;if(approx&&el('vod-mode').value==='auto')el('vod-mode').value='approximate';if(!approx)el('vod-mode').value='auto';}
document.querySelectorAll('input[name="vod-source"]').forEach(r=>r.onchange=syncSource);
document.querySelectorAll('input[name="vod-time"]').forEach(r=>r.onchange=syncTime);
// ---- VOD 시간 입력: 시작~종료 또는 중심 시간 중 하나만 보낸다. 서버는 초("20") 또는 HH:MM:SS를 받는다. ----
let fileDuration=null;
function syncHint(){const center=radio('vod-hint')==='center';el('vod-start-label').hidden=center;el('vod-end-label').hidden=center;el('vod-center-label').hidden=!center;}
document.querySelectorAll('input[name="vod-hint"]').forEach(r=>r.onchange=syncHint);
const parseTime=text=>{text=String(text||'').trim();if(/^\d+(\.\d+)?$/.test(text))return Number(text);const m=/^(\d+):([0-5]?\d):([0-5]?\d(?:\.\d+)?)$/.exec(text);return m?Number(m[1])*3600+Number(m[2])*60+Number(m[3]):NaN;};
const hms=t=>`${String(Math.floor(t/3600)).padStart(2,'0')}:${String(Math.floor(t/60)%60).padStart(2,'0')}:${(t%60).toFixed(t%1?1:0).padStart(2,'0')}`;
// 선택한 파일의 실제 길이를 읽어 두고 입력 범위를 먼저 확인한다.
el('broadcast-file').addEventListener('change',()=>{fileDuration=null;el('vod-length').textContent='';const file=el('broadcast-file').files[0];if(!file)return;const probe=document.createElement('video');probe.preload='metadata';probe.onloadedmetadata=()=>{if(Number.isFinite(probe.duration)&&probe.duration>0){fileDuration=probe.duration;el('vod-length').textContent=`이 영상의 길이: ${hms(fileDuration)} (${fileDuration.toFixed(1)}초)`;}URL.revokeObjectURL(probe.src);};probe.src=URL.createObjectURL(file);});
function timeHints(mode){
 // 반환: {fields} 또는 {error}. 선택하지 않은 방식의 값은 보내지 않는다.
 const center=mode==='approximate'&&radio('vod-hint')==='center';
 if(center){const c=parseTime(el('vod-center').value);if(!el('vod-center').value.trim())return {error:'중심 시간을 입력해주세요.'};if(!Number.isFinite(c))return {error:'중심 시간은 시:분:초(예: 00:00:10) 또는 초로 입력해주세요.'};if(fileDuration!=null&&c>=fileDuration)return {error:`중심 시간이 영상 범위를 벗어났습니다. (영상 길이 ${hms(fileDuration)})`};return {fields:{center_time:String(c)}};}
 const a=parseTime(el('vod-start').value),b=parseTime(el('vod-end').value);
 if(!el('vod-start').value.trim()||!el('vod-end').value.trim())return {error:'시작과 종료 시간을 모두 입력해주세요.'};
 if(!Number.isFinite(a)||!Number.isFinite(b))return {error:'시간은 시:분:초(예: 00:00:20) 또는 초로 입력해주세요.'};
 if(a<0)return {error:'시작 시간은 0초 이상이어야 합니다.'};
 if(b<=a)return {error:'시작 시간은 종료 시간보다 작아야 합니다.'};
 if(fileDuration!=null&&b>fileDuration)return {error:`종료 시간이 영상 길이를 초과했습니다. (영상 길이 ${hms(fileDuration)} · ${fileDuration.toFixed(1)}초)`};
 return {fields:{start:String(a),end:String(b)}};
}
const vodErrors={vod_end_after_duration:'종료 시간이 영상 길이를 초과했습니다.',vod_start_not_before_end:'시작 시간은 종료 시간보다 작아야 합니다.',vod_center_outside:'중심 시간이 영상 범위를 벗어났습니다.',vod_hint_conflict:'시작~종료와 중심 시간 중 한 가지만 입력해주세요.',vod_range_missing:'시작과 종료 시간을 모두 입력해주세요.',vod_time_format:'시간은 시:분:초(예: 00:00:20) 또는 초로 입력해주세요.',vod_start_negative:'시작 시간은 0초 이상이어야 합니다.'};
const vodError=message=>{const code=(/^\[(\w+)\]/.exec(message)||[])[1];return vodErrors[code]?`${vodErrors[code]} (${message.replace(/^\[\w+\]\s*/,'')})`:message;};
el('vod-mode').onchange=()=>{const approx=el('vod-mode').value!=='auto';document.querySelector(`input[name="vod-time"][value="${approx?'approx':'unknown'}"]`).checked=true;el('vod-time-box').hidden=!approx;};

function friendlyStatus(data){
 const demo=data.synthetic_demo?'예시(DEMO) 결과 — 실제 탐지가 아닙니다. ':'';
 if(data.status==='failed')return `${demo}분석하지 못했습니다. ${data.error||''}`;
 if(data.status==='queued')return `${demo}분석을 준비하고 있습니다…`;
 if(data.status==='running'){const p=data.progress?.total?` (${Math.round(100*data.progress.current/data.progress.total)}%)`:'';return data.stage==='SCAN'?`${demo}영상에서 야구 장면을 찾는 중입니다${p}…`:`${demo}찾은 야구 구간을 분석하는 중입니다${p}…`;}
 const n=data.baseball_segments.length;
 if(!n)return `${demo}야구 구간을 찾지 못했습니다. 대략적인 시간대를 알려주시거나 고급 설정에서 구간을 직접 지정해 보세요.`;
 const unknown=data.baseball_segments.filter(s=>s.role_selection_required===true).length;
 return `${demo}야구 구간 ${n}개를 찾았습니다.${unknown&&!data.synthetic_demo?' 아래에서 역할을 알려주시면 분석을 시작합니다.':''}`;
}
function roleCounts(data){
 const counts={};for(const a of data.analyses)if(a.role!=='unknown')counts[a.role]=(counts[a.role]||0)+1;
 el('vod-role-counts').replaceChildren(...Object.entries(counts).map(([role,n])=>{const c=node('span',roleNames[role]||role,'role-count');c.append(node('b',`${n}회`));return c;}));
}
function segmentsPayload(data,changes={}){return data.baseball_segments.map(x=>({start:clock(x.core_start??x.start),end:clock(x.core_end??x.end),role:changes[x.id]||x.role}));}
async function resubmit(segments){try{const data=await request(`/api/broadcasts/${job.id}/segments`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({segments})});render(data);poll(data.id);}catch(e){el('broadcast-status').textContent=e.message;}}

function render(data){
 job=data;el('broadcast-status').textContent=friendlyStatus(data);
 el('broadcast-raw').textContent=`${data.synthetic_demo?'DEMO · ':''}${data.stage} · ${data.status}${data.progress?.total?` · ${data.progress.current}/${data.progress.total}`:''}${data.error?' · '+data.error:''} · 전체 ${clock(data.video_duration)}`;
 el('broadcast-track').replaceChildren();el('broadcast-segments').replaceChildren();roleCounts(data);
 el('broadcast-track').hidden=!data.baseball_segments.length;
 el('broadcast-duration').textContent=data.baseball_segments.length?`전체 영상 ${clock(data.video_duration)} 중 초록색이 야구 구간입니다.`:'';
 data.baseball_segments.forEach((s,i)=>{
  const bar=document.createElement('button');bar.className='segment-bar';bar.style.left=`${100*s.start/data.video_duration}%`;bar.style.width=`${100*s.duration/data.video_duration}%`;bar.textContent='야구';bar.title=`${clock(s.start)} ~ ${clock(s.end)}`;bar.onclick=()=>view(s);el('broadcast-track').append(bar);
  const card=node('article',null,'segment-card');
  card.append(node('h3',`야구 구간 ${i+1} · ${clock(s.start)} ~ ${clock(s.end)} (${length(s.duration)})`));
  const done=data.analyses.filter(a=>a.segment_id===s.id);
  const state=done.length?`분석 완료 · ${[...new Set(done.map(a=>roleNames[a.role]||a.role))].join(' · ')} ${done.length}회`:s.role==='unknown'?(running(data)?'역할 자동 판별 중':s.review_required?'야구 구간인지 확인이 필요합니다':s.display_role?roleNames[s.display_role]:'역할 확인이 필요합니다'):running(data)?'분석 대기 중':`${roleNames[s.role]||s.role} · 분석 결과 없음`;
  card.append(node('p',state));
  if(s.role_selection_required===true&&!data.synthetic_demo&&data.id&&!running(data)){
   const ask=node('div',null,'ask');ask.append(node('p','자동 역할 판별의 근거가 부족합니다. 이 구간의 역할을 선택하면 다시 분석합니다.'));const chips=node('div',null,'chips');
   for(const role of ['batter','defense','catcher','pitcher','baserunning']){const b=node('button',roleNames[role],'chip');b.onclick=()=>resubmit(segmentsPayload(data,{[s.id]:role}));chips.append(b);}
   ask.append(chips);card.append(ask);
  }
  const viewButton=node('button','구간 보기');viewButton.disabled=!sourceURL&&!data.source_url;viewButton.onclick=()=>view(s);card.append(viewButton);
  for(const a of done){const b=node('button',`분석 결과 ${clock(a.start)} · ${roleNames[a.role]||a.role}`,'primary');b.onclick=()=>{window.location.href=`/demo/analysis/${encodeURIComponent(job.id||a.analysis_id)}`;};card.append(b);}
  const edit=node('button','수정');edit.onclick=()=>{el('broadcast-corrections').value=JSON.stringify(segmentsPayload(data),null,2);el('vod-advanced').open=true;el('broadcast-corrections').focus();};card.append(edit);
  const tech=node('details',null,'tech');tech.append(node('summary','상세 정보'),node('p',`ID ${s.id} · ${s.confidence===null?'사용자 지정 · 모델 confidence 없음':`추정 confidence ${Math.round(s.confidence*100)}%`} · ${s.review_required?'검토 필요 후보':'사용자 확인 또는 다중 근거 후보'} · 역할 ${s.role} · ${s.coverage||s.analysis_status||'미분석'}${s.signals?.length?' · 근거 '+s.signals.join(', '):''}`));card.append(tech);
  el('broadcast-segments').append(card);
 });
 el('broadcast-save').disabled=!data.id||running(data);
}
function view(segment){const v=el('broadcast-video');v.src=sourceURL||job.source_url;v.hidden=false;v.currentTime=segment.start;v.onloadedmetadata=()=>{v.currentTime=segment.start;};v.ontimeupdate=()=>{if(v.currentTime>=segment.end)v.pause();};}
async function poll(id){clearTimeout(pollTimer);try{const data=await request(`/api/broadcasts/${id}`);render(data);if(running(data))pollTimer=setTimeout(()=>poll(id),1500);}catch(e){el('broadcast-status').textContent=e.message;}}
el('broadcast-scan').onclick=async()=>{const file=el('broadcast-file').files[0];const url=radio('vod-source')==='url'?el('vod-url').value.trim():null;if(!file&&!url){el('broadcast-status').textContent='분석할 영상 파일을 선택하세요.';return;}el('broadcast-scan').disabled=true;el('broadcast-status').textContent='영상을 올리는 중입니다…';try{if(sourceURL)URL.revokeObjectURL(sourceURL);sourceURL=url||URL.createObjectURL(file);const form=new FormData();appendCapture(form,'vod-capture');if(url)form.append('source_url',url);else form.append('video',file);form.append('sample_interval',el('broadcast-interval').value);form.append('buffer',el('broadcast-buffer').value);const manual=el('broadcast-corrections').value.trim();if(manual)form.append('segments',manual);const mode=el('vod-mode').value;form.append('mode',mode);form.append('role',el('vod-role').value);if(mode!=='auto'&&!manual){const hints=timeHints(mode);if(hints.error){el('broadcast-status').textContent=hints.error;return;}for(const [key,value] of Object.entries(hints.fields))form.append(key,value);form.append('buffer_minutes',el('vod-margin').value);form.append('search_window_minutes',el('vod-window').value);}
 // 실제 전송값 기록 (영상은 파일명·크기만)
 const sent=Object.fromEntries([...form.entries()].map(([k,v])=>[k,v instanceof File?{file:v.name,size:v.size,type:v.type}:v]));console.info('[VOD] payload',JSON.stringify({...sent,duration:fileDuration}));
 const data=await request('/api/vod',{method:'POST',body:form});render(data);poll(data.id);}catch(e){el('broadcast-status').textContent=vodError(e.message);}finally{syncSource();}};
el('broadcast-save').onclick=async()=>{try{await resubmit(JSON.parse(el('broadcast-corrections').value));}catch(e){el('broadcast-status').textContent=e.message;}};
el('broadcast-example').onclick=async()=>{clearTimeout(pollTimer);sourceURL=null;render(await request('/api/broadcast-demo'));};

const requestedJob=new URLSearchParams(location.search).get('job_id');if(requestedJob&&/^[0-9a-f-]{36}$/i.test(requestedJob))poll(requestedJob);

addCaptureForm(document.getElementById('vod-advanced').querySelector('.advanced-body')||document.getElementById('vod-advanced'),'vod-capture');
