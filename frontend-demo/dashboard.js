import {addCaptureForm,appendCapture} from '/demo/capture.js';
const el=id=>document.getElementById(id);
const roleNames={batter:'타격',defense:'수비',catcher:'포수',pitcher:'투수',baserunning:'주루',unknown:'역할 확인 필요'};
const metricNames={head_stability_score:'머리 안정성',weight_transfer_score:'체중 이동',stance_width:'스탠스 폭',knee_flexion:'무릎 굽힘',trunk_lean:'상체 기울기',torso_lean:'상체 기울기',hip_rotation:'골반 회전',shoulder_rotation:'어깨 회전',elbow_angle:'팔꿈치 각도',release_time:'릴리스 시점',first_step_time:'첫 걸음',reaction_time:'반응 시간',transition_time:'송구 전환'};
const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e;};
const duration=s=>{s=Math.round(s||0);if(s<60)return `${s}초`;const m=Math.floor(s/60);return m<60?`${m}분 ${s%60}초`:`${Math.floor(m/60)}시간 ${m%60}분`;};
async function json(url,options){const r=await fetch(url,options);const data=await r.json();if(!r.ok)throw new Error(typeof data.detail==='string'?data.detail:data.detail?.message||'요청 실패');return data;}

async function submit(demo){const role=el('quick-role').value;el('quick-analyze').disabled=true;el('quick-demo').disabled=true;try{if(demo&&role==='auto')throw new Error('예시를 만들려면 역할을 하나 고르세요.');const form=new FormData();for(const [id,key] of [['quick-player','player_id'],['quick-date','analysis_date'],['quick-context','comparison_context']])if(el(id).value.trim())form.append(key,el(id).value.trim());appendCapture(form,'quick-capture',{identity:false});if(!demo){const file=el('quick-video').files[0];if(!file)throw new Error('영상을 선택하세요.');form.append('video',file);form.append('role',role);form.append('throwing_hand',el('quick-hand').value);form.append('position_type',el('quick-position').value);}el('quick-status').textContent='분석 중입니다…';const data=await json(demo?`/api/demo/${role}`:'/api/analyze',{method:'POST',body:form});location.href=`/demo/analysis/${data.id}`;}catch(e){el('quick-status').textContent=e.message;}finally{el('quick-analyze').disabled=false;el('quick-demo').disabled=false;}}
el('quick-analyze').onclick=()=>submit(false);el('quick-demo').onclick=()=>submit(true);

document.querySelectorAll('[data-demo-role]').forEach(button=>button.onclick=async()=>{document.querySelectorAll('[data-demo-role]').forEach(b=>b.disabled=true);el('example-status').textContent='예시 리포트를 준비하는 중…';try{const data=await json(`/api/demo/${button.dataset.demoRole}`,{method:'POST'});location.href=`/demo/analysis/${data.id}`;}catch(e){el('example-status').textContent=e.message;document.querySelectorAll('[data-demo-role]').forEach(b=>b.disabled=false);}});

function empty(id,text){el(id).replaceChildren(node('p',text,'empty'));}
async function loadRecent(){
 let source='real',data=await json('/api/reports?limit=5');
 if(!data.items.length){source='demo';data=await json('/api/reports?source=demo&limit=5');}
 const items=data.items,tag=source==='demo'?' · 예시':'';
 if(!items.length){empty('recent-records','아직 분석 기록이 없습니다. 위에서 방송 분석을 시작해 보세요.');empty('recent-reports','완료된 리포트가 여기에 표시됩니다.');empty('recent-growth','같은 선수를 두 번 이상 분석하면 변화가 표시됩니다.');return;}
 el('recent-records').replaceChildren(...items.slice(0,3).map(item=>{const a=node('a',`${item.analysis_date||'날짜 미상'}${tag}`,'mini-item');a.href=item.report_url;a.append(node('small',`${item.roles.map(r=>roleNames[r]||r).join(' · ')} · 분석 ${duration(item.analyzed_seconds)}`));return a;}));
 el('recent-reports').replaceChildren(...items.map(item=>{const a=node('a',`${item.kind==='analysis'?'클립':'방송'} 리포트 · ${item.analysis_date||'날짜 미상'}${tag}`,'mini-item');a.href=item.report_url;a.append(node('small','리포트 열기 →'));return a;}));
 await loadGrowth(items,source);
}
async function loadGrowth(items,source){
 const players=new Set();
 for(const item of items){try{const bundle=await json(`/api/reports/${item.id}`);for(const e of bundle.entries)if(e.analysis.player_id)players.add(e.analysis.player_id);}catch{}}
 const rows=[];
 for(const player of [...players].slice(0,3)){try{const h=await json(`/api/players/${encodeURIComponent(player)}/history?source=${source}`);for(const point of [...h.points].reverse()){const changes=Object.entries(point.observations||{}).filter(([,m])=>typeof m.delta==='number');if(!changes.length)continue;const [key,m]=changes[0];rows.push({player,date:point.analysis_date,label:metricNames[key]||key.replaceAll('_',' '),delta:m.delta,count:changes.length});break;}}catch{}}
 if(!rows.length){empty('recent-growth','같은 선수를 같은 조건으로 두 번 이상 분석하면 변화가 표시됩니다.');return;}
 el('recent-growth').replaceChildren(...rows.map(r=>{const p=node('p',`${r.player}${source==='demo'?' · 예시':''}`,'mini-item');p.append(node('small',`${r.date||''} · ${r.label} ${r.delta>=0?'+':''}${r.delta.toFixed(2)} 외 변화 ${r.count}개`));return p;}));
}
loadRecent().catch(()=>{empty('recent-records','기록을 불러오지 못했습니다.');empty('recent-reports','기록을 불러오지 못했습니다.');empty('recent-growth','기록을 불러오지 못했습니다.');});
const oldId=new URLSearchParams(location.search).get('analysis_id');if(oldId&&/^[0-9a-f-]{36}$/i.test(oldId))location.replace(`/demo/analysis/${oldId}`);

addCaptureForm(document.getElementById('quick-advanced').querySelector('.advanced-body')||document.getElementById('quick-advanced'),'quick-capture',{identity:false});
