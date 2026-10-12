const el=id=>document.getElementById(id);
const roles={batter:'타자',defense:'수비',catcher:'포수',pitcher:'투수',baserunning:'주루',unknown:'역할 확인 불가'};
const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e;};
const duration=s=>{if(s==null)return '—';s=Math.round(s);if(s<60)return `${s}초`;const m=Math.floor(s/60);return m<60?`${m}분 ${s%60}초`:`${Math.floor(m/60)}시간 ${m%60}분`;};
const PAGE=30;
// 출처별로 따로 페이지를 넘긴다. WONY 기록(/api/validation/reports)과 방송·클립 기록(/api/reports)은 서로 다른 저장소다.
const sources={
 wony:{url:o=>`/api/validation/reports?offset=${o}&limit=${PAGE}`,map:wonyRecord},
 real:{url:o=>`/api/reports?source=real&offset=${o}&limit=${PAGE}`,map:reportRecord},
 demo:{url:o=>`/api/reports?source=demo&offset=${o}&limit=${PAGE}`,map:reportRecord}};
const views={all:['wony','real'],wony:['wony'],real:['real'],demo:['demo']};
let state={},generation=0;

function wonyRecord(i){
 // 기본 카드에는 날짜·역할·영상 길이·상태만. 추적·역할 출처 같은 기술 정보는 결과 화면의 '상세 분석 보기'에 있다.
 const role=i.role&&i.role!=='unknown'?roles[i.role]||i.role:'역할을 확인하지 못했습니다';
 const status=i.tracking_lost_at!=null?'WONY를 잠시 찾지 못했습니다':i.analysis_status==='insufficient_pose'?'분석할 장면이 부족합니다':'분석 완료';
 return {badge:'WONY 영상 분석',cls:'wony',date:i.analysis_date,sort:`${i.analysis_date||''}|1|${i.created_at||''}`,url:i.report_url,warn:status!=='분석 완료',
  rows:[['역할',role],['영상 길이',duration(i.duration_sec)],['상태',status]]};
}
function reportRecord(i){
 return {badge:i.synthetic_demo?'DEMO 예시':i.kind==='analysis'?'클립 분석':'방송 분석',cls:i.synthetic_demo?'demo':'broadcast',date:i.analysis_date,sort:`${i.analysis_date||''}|0|${i.id}`,url:i.report_url,
  rows:[['역할',i.roles.filter(r=>r!=='unknown').map(r=>roles[r]||r).join(' · ')||'역할을 확인하지 못했습니다'],['영상 길이',duration(i.analyzed_seconds)],['상태','분석 완료']]};
}
function card(r){
 const c=node('article',null,'recent-card');c.append(node('span',r.badge,'recent-kind kind-'+r.cls),node('h2',r.date||'날짜 미상','record-date'));
 const dl=node('dl');for(const [k,v] of r.rows)dl.append(node('dt',k),node('dd',v,k==='상태'&&r.warn?'warn-text':null));
 const a=node('a','결과 보기 →','result-link');a.href=r.url;c.append(dl,a);return c;
}
async function load(reset=false){
 const view=el('records-source').value;
 // 보기를 바꾸면 이전 요청의 결과는 버린다 (늦게 도착한 다른 출처 카드가 섞이지 않도록).
 if(reset)generation++;
 const mine=generation,current=reset?null:state;
 if(reset){state=Object.fromEntries(views[view].map(k=>[k,{offset:0,total:null}]));el('records-list').replaceChildren();el('records-status').textContent='불러오는 중…';}
 const active=current||state;
 try{
  const batch=[];
  for(const [key,s] of Object.entries(active)){
   if(s.total!=null&&s.offset>=s.total)continue;
   const response=await fetch(sources[key].url(s.offset));if(!response.ok)throw new Error('기록 조회 실패');
   const data=await response.json();if(mine!==generation)return;s.total=data.total;s.offset+=data.items.length;s.skipped=data.skipped||0;batch.push(...data.items.map(sources[key].map));
  }
  if(mine!==generation)return;
  batch.sort((a,b)=>b.sort.localeCompare(a.sort));el('records-list').append(...batch.map(card));
  const parts=Object.entries(state).map(([k,s])=>`${k==='wony'?'WONY 영상 분석':k==='demo'?'DEMO 합성 데이터':'방송·클립 분석'} ${s.total}개`);
  const skipped=Object.values(state).reduce((n,s)=>n+(s.skipped||0),0);
  el('records-status').textContent=parts.join(' · ')+(skipped?` · 열 수 없는 기록 ${skipped}개는 빼고 보여드려요`:'');
  el('records-more').hidden=Object.values(state).every(s=>s.offset>=s.total);
  if(!el('records-list').children.length)el('records-list').replaceChildren(node('p','아직 분석 기록이 없어요.','empty'));
 }catch(e){if(mine===generation)el('records-status').textContent=e.message;}
}
el('records-source').onchange=()=>load(true);el('records-more').onclick=()=>load();load(true);
