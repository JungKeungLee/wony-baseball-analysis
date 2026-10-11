const el=id=>document.getElementById(id);let id=null,timer=null;
const clock=t=>{t=Math.floor(t);return [Math.floor(t/3600),Math.floor(t/60)%60,t%60].map(n=>String(n).padStart(2,'0')).join(':');};
async function request(url,options){const r=await fetch(url,options);const data=await r.json();if(!r.ok)throw new Error(typeof data.detail==='string'?data.detail:JSON.stringify(data.detail));return data;}
function render(data){
 el('live-state').textContent=data.state;el('live-status').textContent=`${data.source_type} · ${data.status} · 감시 시간 ${clock(data.elapsed_seconds)} · ${data.progress.sampled_frames} 샘플 · ${data.progress.analysis_clips} 분석 클립`;
 el('live-confidence').textContent=`최근 야구 confidence: ${Math.round(data.confidence*100)}% · 추정 · 역할 ${data.role} (수동 힌트 또는 unknown)`;
 el('live-current').textContent=data.current_segment?`야구 시작: ${data.current_segment.start_datetime} · 경과 ${clock(data.elapsed_seconds-data.current_segment.start)}`:'현재 야구 구간 없음';
 el('live-results').replaceChildren();for(const a of data.analyses){const link=document.createElement('a');link.href=`/demo/analysis/${encodeURIComponent(data.id)}`;link.textContent=`실시간 분석 보기 · ${a.role} · ${clock(a.start)} ~ ${clock(a.end)} · ${a.status}`;const p=document.createElement('p');p.append(link);el('live-results').append(p);}
 el('live-segments').replaceChildren();for(const s of data.baseball_segments){const p=document.createElement('p');p.textContent=`${s.start_datetime} ~ ${s.end_datetime} · ${s.roles.join(', ')||'unknown'} · ${s.review_required?'검토 필요':'분석 결과 참조'} · 추정`;el('live-segments').append(p);}
 el('live-stop').disabled=data.status!=='running';el('live-role-save').disabled=data.status!=='running';el('live-start').disabled=data.status==='running';
 el('live-correct').disabled=data.status==='running'||data.source_type!=='file_replay';
 if(data.error)el('live-error').textContent=data.error;
}
async function poll(){try{const data=await request(`/api/live/${id}`);render(data);if(data.status==='running')timer=setTimeout(poll,1500);}catch(e){el('live-error').textContent=e.message;}}
el('live-start').onclick=async()=>{el('live-start').disabled=true;el('live-error').textContent='';try{const form=new FormData();const url=el('live-url').value.trim(),file=el('live-file').files[0];if(url)form.append('source_url',url);if(file)form.append('video',file);form.append('config',JSON.stringify({role:el('live-role').value,sample_interval:Number(el('live-interval').value),confirmation_seconds:Number(el('live-confirm').value),ending_seconds:Number(el('live-ending').value)}));const data=await request('/api/live',{method:'POST',body:form});id=data.id;render(data);clearTimeout(timer);poll();}catch(e){el('live-error').textContent=e.message;el('live-start').disabled=false;}};
el('live-stop').onclick=async()=>{try{await request(`/api/live/${id}/stop`,{method:'POST'});el('live-status').textContent='종료 요청됨 · 현재 제한시간 있는 입력/분석 작업 완료 후 종료';}catch(e){el('live-error').textContent=e.message;}};
el('live-role-save').onclick=async()=>{try{await request(`/api/live/${id}/role`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({role:el('live-role').value})});}catch(e){el('live-error').textContent=e.message;}};

el('live-correct').onclick=async()=>{try{const job=await request(`/api/live/${id}/segments`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({segments:JSON.parse(el('live-corrections').value)})});location.href=`/demo/broadcast/?job_id=${encodeURIComponent(job.id)}`;}catch(e){el('live-error').textContent=e.message;}};
