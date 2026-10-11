const el=id=>document.getElementById(id);
let job=null,pollTimer=null,sourceURL=null;
const clock=n=>{n=Math.floor(n);return `${String(Math.floor(n/3600)).padStart(2,'0')}:${String(Math.floor(n/60)%60).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;};
const request=async(url,options)=>{const r=await fetch(url,options);const data=await r.json();if(!r.ok)throw new Error(typeof data.detail==='string'?data.detail:JSON.stringify(data.detail));return data;};
function render(data){
 job=data;el('broadcast-status').textContent=`${data.synthetic_demo?'DEMO · 임의 예시 — 실제 탐지 아님 · ':''}${data.stage} · ${data.status}${data.progress?.total?` · ${data.progress.current}/${data.progress.total}`:''}${data.error?' · '+data.error:''}`;
 el('broadcast-track').replaceChildren();el('broadcast-segments').replaceChildren();
 el('broadcast-duration').textContent=`전체 영상 ${clock(data.video_duration)} · 표시 밖 구간은 미분석 (콘텐츠 종류를 판정하지 않음)`;
 for(const s of data.baseball_segments){
  const bar=document.createElement('button');bar.className='segment-bar';bar.style.left=`${100*s.start/data.video_duration}%`;bar.style.width=`${100*s.duration/data.video_duration}%`;bar.textContent='야구 후보';bar.title=`${clock(s.start)} ~ ${clock(s.end)}`;bar.onclick=()=>view(s);el('broadcast-track').append(bar);
  const card=document.createElement('article');card.className='report-section';
  const title=document.createElement('h3');title.textContent=`${s.id} · ${clock(s.start)} ~ ${clock(s.end)} · ${Math.floor(s.duration/60)}분 ${Math.round(s.duration%60)}초`;card.append(title);
  const info=document.createElement('p');info.textContent=`${s.confidence===null?'사용자 지정 · 모델 confidence 없음':`추정 confidence ${Math.round(s.confidence*100)}%`} · ${s.review_required?'검토 필요':'사용자 확인 또는 다중 근거 후보'} · 역할 ${s.role} · ${s.coverage||s.analysis_status||'미분석'}`;card.append(info);
  const viewButton=document.createElement('button');viewButton.textContent='구간 보기';viewButton.disabled=!sourceURL&&!data.source_url;viewButton.onclick=()=>view(s);card.append(viewButton);
  for(const a of data.analyses.filter(a=>a.segment_id===s.id)){const b=document.createElement('button');b.textContent=`분석 결과 ${clock(a.start)} · ${a.status}`;b.onclick=async()=>{try{window.location.href=`/demo/analysis/${encodeURIComponent(job.id||a.analysis_id)}`;}catch(e){el('broadcast-status').textContent=e.message;}};card.append(b);}
  const edit=document.createElement('button');edit.textContent='수정';edit.onclick=()=>{el('broadcast-corrections').value=JSON.stringify(data.baseball_segments.map(x=>({start:clock(x.core_start??x.start),end:clock(x.core_end??x.end),role:x.role})),null,2);el('broadcast-corrections').focus();};card.append(edit);el('broadcast-segments').append(card);
 }
 el('broadcast-save').disabled=!data.id||['queued','running'].includes(data.status);
}
function view(segment){const v=el('broadcast-video');v.src=sourceURL||job.source_url;v.hidden=false;v.currentTime=segment.start;v.onloadedmetadata=()=>{v.currentTime=segment.start;};v.ontimeupdate=()=>{if(v.currentTime>=segment.end)v.pause();};}
async function poll(id){clearTimeout(pollTimer);try{const data=await request(`/api/broadcasts/${id}`);render(data);if(['queued','running'].includes(data.status))pollTimer=setTimeout(()=>poll(id),1500);}catch(e){el('broadcast-status').textContent=e.message;}}
el('broadcast-scan').onclick=async()=>{const file=el('broadcast-file').files[0];if(!file)return;el('broadcast-scan').disabled=true;try{if(sourceURL)URL.revokeObjectURL(sourceURL);sourceURL=URL.createObjectURL(file);const form=new FormData();form.append('video',file);form.append('sample_interval',el('broadcast-interval').value);form.append('buffer',el('broadcast-buffer').value);const manual=el('broadcast-corrections').value.trim();if(manual)form.append('segments',manual);let endpoint='/api/broadcasts';if(el('vod-mode')){endpoint='/api/vod';const mode=el('vod-mode').value;form.append('mode',mode);form.append('role',el('vod-role').value);if(mode!=='auto'){for(const [id,key] of [['vod-start','start'],['vod-end','end'],['vod-center','center_time']]){if(el(id).value.trim())form.append(key,el(id).value.trim());}form.append('buffer_minutes',el('vod-margin').value);form.append('search_window_minutes',el('vod-window').value);}}const data=await request(endpoint,{method:'POST',body:form});render(data);poll(data.id);}catch(e){el('broadcast-status').textContent=e.message;}finally{el('broadcast-scan').disabled=false;}};
el('broadcast-save').onclick=async()=>{try{const data=await request(`/api/broadcasts/${job.id}/segments`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({segments:JSON.parse(el('broadcast-corrections').value)})});render(data);poll(data.id);}catch(e){el('broadcast-status').textContent=e.message;}};
el('broadcast-example').onclick=async()=>{clearTimeout(pollTimer);sourceURL=null;render(await request('/api/broadcast-demo'));};

const requestedJob=new URLSearchParams(location.search).get('job_id');if(requestedJob&&/^[0-9a-f-]{36}$/i.test(requestedJob))poll(requestedJob);
