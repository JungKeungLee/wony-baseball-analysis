import {addCaptureForm,appendCapture} from '/demo/capture.js';
import {recentWony} from '/demo/wony-store.js';
import {requestJson} from '/demo/http.js';
const el=id=>document.getElementById(id);
const roleNames={batter:'타자',pitcher:'투수',catcher:'포수',defense:'수비',baserunning:'주루'};
const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e;};
const dotDate=d=>d?String(d).replace(/^(\d{4})-(\d{2})-(\d{2}).*$/,'$1.$2.$3'):'날짜 미상';
const duration=s=>{s=Math.round(s||0);if(s<60)return `${s}초`;const m=Math.floor(s/60);return m<60?`${m}분 ${s%60}초`:`${Math.floor(m/60)}시간 ${m%60}분`;};
const json=requestJson;


async function submit(demo){const role=el('quick-role').value;el('quick-analyze').disabled=true;el('quick-demo').disabled=true;try{if(demo&&role==='auto')throw new Error('예시를 만들려면 역할을 하나 고르세요.');const form=new FormData();for(const [id,key] of [['quick-player','player_id'],['quick-date','analysis_date'],['quick-context','comparison_context']])if(el(id).value.trim())form.append(key,el(id).value.trim());appendCapture(form,'quick-capture',{identity:false});if(!demo){const file=el('quick-video').files[0];if(!file)throw new Error('영상을 선택하세요.');form.append('video',file);form.append('role',role);form.append('throwing_hand',el('quick-hand').value);form.append('position_type',el('quick-position').value);}el('quick-status').textContent='분석 중입니다…';const data=await json(demo?`/api/demo/${role}`:'/api/analyze',{method:'POST',body:form});location.href=`/demo/analysis/${data.id}`;}catch(e){el('quick-status').textContent=e.message;}finally{el('quick-analyze').disabled=false;el('quick-demo').disabled=false;}}
el('quick-analyze').onclick=()=>submit(false);el('quick-demo').onclick=()=>submit(true);

// 지난 분석: 서버의 WONY 기록(/api/validation/reports) 최근 3개. 서버가 안 될 때만 이 브라우저에 저장된 요약을 쓴다.
function fromServer(i){return {url:i.report_url,date:i.analysis_date,role:i.role,duration:i.duration_sec,status:i.analysis_status,lost_at:i.tracking_lost_at};}
async function loadRecords(){
 try{const data=await json('/api/validation/reports?limit=3');el('records-notice').hidden=true;return data.items.map(fromServer);}
 catch{el('records-notice').hidden=false;el('records-notice').textContent='서버 기록을 불러오지 못해, 이 브라우저에 임시 저장된 기록을 표시합니다.';
  return recentWony().sort((a,b)=>String(b.saved_at||'').localeCompare(String(a.saved_at||''))).slice(0,3).map(r=>({url:r.url,date:r.date,role:r.role,duration:r.duration,status:r.status,lost_at:r.lost_at}));}
}
// 내부 상태값을 쉬운 문장으로 바꾼다. 값 자체는 바꾸지 않는다.
function plainStatus(r){if(r.lost_at!=null)return 'WONY를 잠시 찾지 못했습니다';if(r.status==='insufficient_pose')return '분석할 장면이 부족합니다';return '분석 완료';}
function renderRecent(records){
 if(!records.length){el('recent-analyses').replaceChildren(node('p','아직 분석한 영상이 없어요. 위의 버튼으로 첫 분석을 시작해보세요.','empty'));return;}
 el('recent-analyses').replaceChildren(...records.map(r=>{
  const a=node('a',null,'history-item');a.href=r.url;
  a.append(node('b',dotDate(r.date)),node('span',r.role&&r.role!=='unknown'?roleNames[r.role]||r.role:'역할 미확인'),node('span',r.duration==null?'—':duration(r.duration)),node('span',plainStatus(r),'history-status'+(r.lost_at!=null||r.status==='insufficient_pose'?' warn':'')),node('span','결과 보기 →','history-go'));
  return a;}));
}
loadRecords().then(renderRecent).catch(()=>el('recent-analyses').replaceChildren(node('p','기록을 불러오지 못했습니다.','empty')));
const oldId=new URLSearchParams(location.search).get('analysis_id');if(oldId&&/^[0-9a-f-]{36}$/i.test(oldId))location.replace(`/demo/analysis/${oldId}`);

addCaptureForm(document.getElementById('quick-advanced').querySelector('.advanced-body')||document.getElementById('quick-advanced'),'quick-capture',{identity:false});
