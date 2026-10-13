import {addCaptureForm,appendCapture} from '/demo/capture.js';
import {requestJson} from '/demo/http.js';
const el=id=>document.getElementById(id);let id=null,timer=null;
const roleNames={batter:'타격',defense:'수비',catcher:'포수',pitcher:'투수',baserunning:'주루',unknown:'역할 미확인'};
const stateNames={IDLE:'대기 중',WATCHING:'방송 감시 중',BASEBALL_CANDIDATE:'야구 장면 확인 중',BASEBALL_ANALYZING:'야구 분석 중',BASEBALL_ENDING:'야구 종료 확인 중',REPORT_GENERATING:'리포트 정리 중'};
const clock=t=>{t=Math.floor(t);return [Math.floor(t/3600),Math.floor(t/60)%60,t%60].map(n=>String(n).padStart(2,'0')).join(':');};
const localTime=iso=>{const d=new Date(iso);return isNaN(d)?iso:d.toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'});};
const request=requestJson;
function render(data){
 const live=data.status==='running';
 // 사용자용 요약
 const label=live?(stateNames[data.state]||'방송 감시 중'):data.status==='failed'?'오류로 중단됨':'감시 종료';
 el('live-state-label').textContent=label;el('live-state-label').classList.toggle('pulse',live);
 el('live-detect').textContent=data.current_segment?`야구 진행 중 · ${localTime(data.current_segment.start_datetime)}부터`:data.baseball_segments.length?`지난 야구 ${data.baseball_segments.length}회 감지`:'아직 없음';
 el('live-elapsed').textContent=clock(data.elapsed_seconds);
 el('live-guide').textContent=live?'야구가 감지되면 자동으로 분석을 시작합니다. 이 창을 열어 두세요.':data.analyses.length?'감시가 끝났습니다. 아래에서 분석 결과를 확인하세요.':'감시가 끝났습니다.';
 el('live-role-ask').hidden=!(live&&data.role_selection_required===true);
 // 상세 정보 (고급 설정 안)
 el('live-state').textContent=data.state;el('live-status').textContent=`${data.source_type} · ${data.status} · 감시 시간 ${clock(data.elapsed_seconds)} · ${data.progress.sampled_frames} 샘플 · ${data.progress.analysis_clips} 분석 클립`;
 el('live-confidence').textContent=`최근 야구 confidence: ${Math.round(data.confidence*100)}% · 추정 · 역할 ${data.role} (${data.role_source||'unknown'})`;
 el('live-current').textContent=data.current_segment?`야구 시작: ${data.current_segment.start_datetime} · 경과 ${clock(data.elapsed_seconds-data.current_segment.start)}`:'현재 야구 구간 없음';
 el('live-results').replaceChildren();for(const a of data.analyses){const link=document.createElement('a');link.href=`/demo/analysis/${encodeURIComponent(data.id)}`;link.textContent=`분석 결과 보기 · ${roleNames[a.role]||a.role} · ${clock(a.start)}`;link.className='chip';el('live-results').append(link);}
 el('live-segments').replaceChildren();for(const s of data.baseball_segments){const p=document.createElement('p');p.className='hint';p.textContent=`야구 ${localTime(s.start_datetime)} ~ ${localTime(s.end_datetime)} · ${s.roles.map(r=>roleNames[r]||r).join(', ')||'역할 미확인'}`;el('live-segments').append(p);}
 el('live-stop').disabled=!live;el('live-role-save').disabled=!live;el('live-start').disabled=live;
 el('live-correct').disabled=live||data.source_type!=='file_replay';
 if(data.error)el('live-error').textContent=data.error;
}
async function poll(){try{const data=await request(`/api/live/${id}`);render(data);if(data.status==='running')timer=setTimeout(poll,1500);}catch(e){el('live-error').textContent=e.message;}}
el('live-start').onclick=async()=>{el('live-error').textContent='';const url=el('live-url').value.trim(),file=el('live-file').files[0];if(!url&&!file){el('live-error').textContent='LIVE 방송 URL을 입력하세요.';return;}el('live-start').disabled=true;try{const form=new FormData();appendCapture(form,'live-capture');if(url)form.append('source_url',url);if(file)form.append('video',file);form.append('config',JSON.stringify({role:el('live-role').value,sample_interval:Number(el('live-interval').value),confirmation_seconds:Number(el('live-confirm').value),ending_seconds:Number(el('live-ending').value)}));const data=await request('/api/live',{method:'POST',body:form});id=data.id;render(data);clearTimeout(timer);poll();}catch(e){el('live-error').textContent=e.message;el('live-start').disabled=false;}};
el('live-stop').onclick=async()=>{try{await request(`/api/live/${id}/stop`,{method:'POST'});el('live-state-label').textContent='종료하는 중…';el('live-status').textContent='종료 요청됨 · 현재 제한시간 있는 입력/분석 작업 완료 후 종료';}catch(e){el('live-error').textContent=e.message;}};
async function setRole(role){try{await request(`/api/live/${id}/role`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({role})});el('live-role').value=role;el('live-role-ask').hidden=true;}catch(e){el('live-error').textContent=e.message;}}
el('live-role-save').onclick=()=>setRole(el('live-role').value);
document.querySelectorAll('[data-live-role]').forEach(b=>b.onclick=()=>setRole(b.dataset.liveRole));

el('live-correct').onclick=async()=>{try{const job=await request(`/api/live/${id}/segments`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({segments:JSON.parse(el('live-corrections').value)})});location.href=`/demo/broadcast/?job_id=${encodeURIComponent(job.id)}`;}catch(e){el('live-error').textContent=e.message;}};

addCaptureForm(document.getElementById('live-advanced').querySelector('.advanced-body')||document.getElementById('live-advanced'),'live-capture');
