import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

const $ = id => document.getElementById(id);
const video = $('overlay');
const timeline = $('timeline');
const roleLabels = {batter:'타자',defense:'수비',catcher:'포수',pitcher:'투수',baserunning:'주루',unknown:'역할 미확인'};
const stageLabels = {stance:'스탠스',load:'로드',front_foot_landing:'앞발 착지 참고',swing_start:'스윙 시작 후보',estimated_impact:'임팩트 참고',follow_through:'팔로스루 후보',setup:'준비',leg_lift:'레그 리프트 후보',stride:'스트라이드 후보',arm_cocking:'암 코킹 후보',release:'릴리스 후보',ready:'준비',action:'동작 후보',finish:'마무리'};
const angleLabels = {shoulder_angle:'어깨 각도',elbow_angle:'팔꿈치 각도',hip_rotation:'골반선 변화',knee_flexion:'무릎 굽힘',trunk_lean:'상체 기울기'};
let selectedRole='batter', result=null, frameIndex=-1, preferredStage=null, busy=false;
let renderer, scene, camera, controls;
const jointMeshes=new Map(), boneMeshes=[];
const container=$('three-stage');

function initThree(){
  try{
    renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});
    renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
    renderer.setClearColor(0x0c171d,1);
    renderer.domElement.setAttribute('aria-label','추정 3D stick figure');
    container.appendChild(renderer.domElement);
    scene=new THREE.Scene();
    camera=new THREE.PerspectiveCamera(40,1,.05,60);
    camera.position.set(3.2,1.4,5.4);
    controls=new OrbitControls(camera,renderer.domElement);
    controls.target.set(0,.15,0);controls.enableDamping=true;
    controls.minDistance=2;controls.maxDistance=15;
    scene.add(new THREE.HemisphereLight(0xe1fff3,0x28363d,3));
    const light=new THREE.DirectionalLight(0xffffff,3);light.position.set(3,5,4);scene.add(light);
    const grid=new THREE.GridHelper(8,16,0x36534a,0x1b3434);grid.position.y=-1.5;scene.add(grid);
    const base=new THREE.Mesh(new THREE.CircleGeometry(1.1,64),new THREE.MeshBasicMaterial({color:0x1b3230,transparent:true,opacity:.6,side:THREE.DoubleSide}));
    base.rotation.x=-Math.PI/2;base.position.y=-1.495;scene.add(base);
    const resize=()=>{const w=container.clientWidth,h=container.clientHeight;if(!w||!h)return;renderer.setSize(w,h);camera.aspect=w/h;camera.updateProjectionMatrix();};
    new ResizeObserver(resize).observe(container);resize();
    const render=()=>{controls.update();renderer.render(scene,camera);requestAnimationFrame(render);};render();
  }catch(error){$('three-empty').textContent='WebGL을 사용할 수 없습니다. 2D 영상과 JSON을 확인하세요.';}
}
initThree();

function clearFigure(){
  for(const mesh of jointMeshes.values()) mesh.visible=false;
  for(const mesh of boneMeshes) if(mesh) mesh.visible=false;
}
function showFigure(frame){
  if(!renderer||!scene)return;
  clearFigure();
  const joints=frame?.joints||{};
  const names=Object.keys(joints);
  $('three-empty').hidden=names.length>0;
  if(!names.length){$('three-empty').textContent='이 프레임에는 표시할 관절이 없습니다.';return;}
  for(const [name,coords] of Object.entries(joints)){
    if(!jointMeshes.has(name)){
      const mesh=new THREE.Mesh(new THREE.SphereGeometry(name==='head'?.09:.04,20,16),new THREE.MeshStandardMaterial({color:name==='head'?0xe2f7e8:0x9ff2d0,roughness:.35}));
      scene.add(mesh);jointMeshes.set(name,mesh);
    }
    const mesh=jointMeshes.get(name);mesh.position.set(...coords);mesh.visible=true;
    // 3D confidence is capped at 0.35: never turn illustrative joints into warning colors.
    mesh.material.color.setHex(name==='head'?0xe2f7e8:0x9ff2d0);
  }
  (result.visualization.pose3d.edges||[]).forEach(([a,b],index)=>{
    if(!joints[a]||!joints[b])return;
    if(!boneMeshes[index]){
      const mesh=new THREE.Mesh(new THREE.CylinderGeometry(.022,.022,1,10),new THREE.MeshStandardMaterial({color:0x6ed8c2,roughness:.4}));
      scene.add(mesh);boneMeshes[index]=mesh;
    }
    const start=new THREE.Vector3(...joints[a]),end=new THREE.Vector3(...joints[b]);
    const direction=end.clone().sub(start),mesh=boneMeshes[index];
    if(direction.length()<1e-6)return;
    mesh.position.copy(start).add(end).multiplyScalar(.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),direction.clone().normalize());
    mesh.scale.set(1,direction.length(),1);mesh.visible=true;
  });
}
function renderAngles(key){
  $('angles').replaceChildren();
  for(const [name,label] of Object.entries(angleLabels)){
    const metric=key?.angles?.[name];
    const block=document.createElement('div');block.className='angle-item';
    for(const [cls,text] of [['label',label],['value',metric?.value==null?'—':`${metric.value.toFixed(1)}°`],['grade',metric?.value==null?'미지원 / 미검출':`추정 · ${metric.confidence_grade} ${metric.confidence.toFixed(2)}`]]){
      const span=document.createElement('span');span.className=cls;span.textContent=text;block.appendChild(span);
    }
    $('angles').appendChild(block);
  }
  $('phase-status').textContent=key?(stageLabels[key.stage]||key.stage)+' · '+(key.status==='reference_only'?'미확인 참고':'추정 후보'):'키프레임을 선택하면 각도가 표시됩니다.';
  $('phase-reason').textContent=key?.reason||'VR 아바타의 애니메이션은 실제 사람의 움직임과 다를 수 있습니다.';
}
renderAngles(null);
function updateFrame(index,force=false){
  if(!result)return;
  const count=result.visualization.frame_count;
  const next=Math.max(0,Math.min(index,count-1));
  if(!force&&next===frameIndex)return;
  frameIndex=next;timeline.value=String(next);
  const frame=result.visualization.pose3d.frames[next];
  const time=frame?.timestamp??next/result.sample_fps;
  $('clock').textContent=`${time.toFixed(1).padStart(4,'0')} / ${((count-1)/result.sample_fps).toFixed(1).padStart(4,'0')}`;
  $('frame-counter').textContent=`FRAME ${String(next+1).padStart(3,'0')} / ${count}`;
  $('frame-label').textContent=`${time.toFixed(2)}s · frame ${next}`;
  $('confidence-label').textContent=`추정 ${frame?.confidence?.toFixed(2)||'0.00'} · LOW`;
  showFigure(frame);
  const keys=result.visualization.keyframes.filter(k=>k.frame===next);
  const key=keys.find(k=>k.stage===preferredStage)||keys[0];
  preferredStage=key?.stage??null;
  document.querySelectorAll('.keyframe').forEach(button=>button.classList.toggle('selected',button.dataset.stage===preferredStage));
  renderAngles(key);
}
function jump(key){
  if(key.frame==null)return;
  video.pause();preferredStage=key.stage;
  video.currentTime=key.timestamp;
  updateFrame(key.frame,true);
}
function renderKeyframes(){
  $('keyframe-list').replaceChildren();
  for(const key of result.visualization.keyframes){
    const button=document.createElement('button');button.className='keyframe';button.dataset.stage=key.stage;button.disabled=key.frame==null;
    button.title=key.reason||'';
    if(key.image_url){const image=document.createElement('img');image.src=key.image_url;image.alt=(stageLabels[key.stage]||key.stage)+' 추정 키프레임';button.appendChild(image);}
    else{const empty=document.createElement('div');empty.className='empty-thumb';empty.textContent='단계 미검출';button.appendChild(empty);}
    const meta=document.createElement('div');meta.className='meta';
    const name=document.createElement('span');name.className='name';name.textContent=stageLabels[key.stage]||key.stage;meta.appendChild(name);
    const info=document.createElement('div');info.className='info';
    const time=document.createElement('span');time.textContent=key.timestamp==null?'—':`${key.timestamp.toFixed(2)}s`;
    const status=document.createElement('span');status.textContent=key.status==='reference_only'?'미확인 참고':key.frame==null?'미검출':'추정 후보';
    if(key.status==='reference_only')status.className='reference';
    info.append(time,status);meta.appendChild(info);button.appendChild(meta);button.addEventListener('click',()=>jump(key));$('keyframe-list').appendChild(button);
  }
}
function showResult(data){
  video.pause();result=data;frameIndex=-1;preferredStage=null;
  const vis=result.visualization;
  $('source-badge').classList.toggle('synthetic',!!result.synthetic_demo);
  $('source-badge').textContent=`${roleLabels[result.role]||result.role} · ${result.synthetic_demo?'DEMO · 합성 데모 — 실제 영상 분석 결과 아님':'업로드 영상 — 영상 기반 추정'}`;
  $('status').textContent=`${vis.frame_count} frames · ${result.sample_fps} fps · ${result.status}`;
  $('json-link').hidden=false;$('json-link').href=`/api/analysis/${result.id}`;
  video.src=vis.overlay_video_url||'';$('video-placeholder').hidden=!!vis.overlay_video_url;
  timeline.max=String(Math.max(vis.frame_count-1,0));timeline.disabled=!vis.frame_count;
  $('play').disabled=!vis.overlay_video_url;
  renderKeyframes();updateFrame(0,true);renderScouting();
}
function setBusy(value){
  busy=value;document.querySelectorAll('[data-role]').forEach(button=>button.disabled=value);
  $('demo').disabled=value||selectedRole==='auto';$('analyze').disabled=value||!$('upload').files.length;
  if(value){video.pause();$('status').textContent='프레임과 시각화 파일을 생성하고 있습니다…';}
}
async function submit(demo=false){
  if(busy)return;
  setBusy(true);
  try{
    let response;
    if(demo){const form=new FormData();appendPlayerMetadata(form);response=await fetch(`/api/demo/${selectedRole}`,{method:'POST',body:form});}
    else{
      const form=new FormData();form.append('video',$('upload').files[0]);form.append('role',selectedRole);form.append('throwing_hand',$('hand').value);form.append('position_type',$('position').value);appendPlayerMetadata(form);
      response=await fetch('/api/analyze',{method:'POST',body:form});
    }
    const data=await response.json();
    if(!response.ok)throw new Error(typeof data.detail==='string'?data.detail:data.detail?.message||`요청 실패 (${response.status})`);
    showResult(data);
  }catch(error){$('status').textContent=`오류: ${error.message}`;}
  finally{setBusy(false);}
}
$('demo').addEventListener('click',()=>submit(true));$('analyze').addEventListener('click',()=>submit(false));
$('upload').addEventListener('change',()=>{$('analyze').disabled=busy||!$('upload').files.length;if($('upload').files.length)$('status').textContent=$('upload').files[0].name;});
document.querySelectorAll('[data-role]').forEach(button=>button.addEventListener('click',()=>{
  selectedRole=button.dataset.role;document.querySelectorAll('[data-role]').forEach(b=>b.classList.toggle('selected',b===button));$('position').hidden=selectedRole!=='defense';$('demo').disabled=selectedRole==='auto';
}));
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>{
  if(!camera||!controls)return;
  const positions={front:[0,.5,6],side:[6,.5,0],rear:[0,.5,-6]};camera.position.set(...positions[button.dataset.view]);controls.target.set(0,.15,0);controls.update();
  document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('selected',b===button));
}));
$('play').addEventListener('click',async()=>{if(video.paused){if(video.ended)video.currentTime=0;try{await video.play();}catch(error){$('status').textContent='재생을 시작할 수 없습니다.';}}else video.pause();});
video.addEventListener('play',()=>{$('play').innerHTML='❚❚ <span>일시 정지</span>';$('play').setAttribute('aria-label','일시 정지');});
video.addEventListener('pause',()=>{$('play').innerHTML='▶ <span>재생</span>';$('play').setAttribute('aria-label','재생');});
video.addEventListener('error',()=>{if(result)$('status').textContent='오버레이 영상을 불러오지 못했습니다. JSON과 키프레임을 확인하세요.';});
timeline.addEventListener('input',()=>{if(!result)return;video.pause();preferredStage=null;const index=Number(timeline.value);video.currentTime=index/result.sample_fps;updateFrame(index,true);});
const sync=()=>{if(result&&!video.paused)updateFrame(Math.min(Math.floor(video.currentTime*result.sample_fps),result.visualization.frame_count-1));requestAnimationFrame(sync);};sync();

const categoryLabels={batting:'타격',defense:'수비',catching:'포수',pitching:'투수',baserunning:'주루'};
function appendPlayerMetadata(form){
  for(const [id,key] of [['player-id','player_id'],['analysis-date','analysis_date'],['comparison-context','comparison_context']]){
    const value=$(id).value.trim();if(value)form.append(key,value);
  }
}
function activateTab(scouting){
  $('motion-panel').hidden=scouting;$('scouting-panel').hidden=!scouting;
  for(const [id,selected] of [['motion-tab',!scouting],['scouting-tab',scouting]]){$(id).classList.toggle('selected',selected);$(id).setAttribute('aria-selected',String(selected));}
  if(scouting)video.pause();
}
$('motion-tab').addEventListener('click',()=>activateTab(false));$('scouting-tab').addEventListener('click',()=>activateTab(true));
function node(tag,text,cls){const el=document.createElement(tag);if(text!=null)el.textContent=text;if(cls)el.className=cls;return el;}
function renderFeedback(id,items){$(id).replaceChildren();if(!items.length)$(id).appendChild(node('li','근거 부족 또는 해당 관찰 없음 — 억지로 평가하지 않습니다.'));for(const item of items)$(id).appendChild(node('li',`${item.text} (추정 · ${item.confidence_grade} ${item.confidence.toFixed(2)})`));}
function renderScouting(){
  const report=result.scouting_report;if(!report)return;
  $('report-player').textContent=`선수 ${report.player_id||'미지정'} · ${report.analysis_date} · ${roleLabels[result.role]} · 이 영상의 관찰`;
  $('report-source').textContent=result.synthetic_demo?'DEMO · 실제 선수 평가 아님':'실제 업로드 · 영상 기반 추정';$('report-source').classList.toggle('synthetic',result.synthetic_demo);
  $('report-summary').textContent=report.overall_summary+' '+report.rating_label;
  $('rating-cards').replaceChildren();$('role-reports').replaceChildren();
  for(const [category,label] of Object.entries(categoryLabels)){
    const card=node('article',null,'rating-card');card.append(node('h2',label),node('span','—','score'),node('p','점수·등급 보류 · 검증된 평가 기준 없음'));$('rating-cards').appendChild(card);
    const evaluation=report.role_evaluations[category];const section=node('article',null,'role-report');section.appendChild(node('h3',label+(evaluation.analyzed?' · 관찰 지표':' · 이 영상에서 미분석')));
    for(const [name,assessment] of Object.entries(evaluation.metrics)){
      const row=node('div',null,'observation-row');const left=node('div',name.replaceAll('_',' '));left.appendChild(node('small','점수 / 등급: —'));
      const right=node('div');const m=assessment.observation;
      right.appendChild(node('span',m?.value==null?'관찰값 없음':`${typeof m.value==='number'?m.value.toFixed(3):String(m.value)} ${m.unit||''}`,'observed'));
      right.appendChild(node('small',m?.value==null?assessment.reason:`추정 · ${m.confidence_grade} ${m.confidence.toFixed(2)} · 공식 평가 아님`));row.append(left,right);section.appendChild(row);
    }$('role-reports').appendChild(section);
  }
  renderFeedback('report-strengths',report.strengths);renderFeedback('report-development',report.development_areas);
  $('play-reports').replaceChildren();
  if(!report.plays.length)$('play-reports').appendChild(node('p','검출된 이벤트 후보가 없습니다. 플레이 성공/실패를 판정하지 않습니다.','muted'));
  for(const [index,play] of report.plays.entries()){
    const card=node('div',null,'play-card');const copy=node('div');copy.append(node('strong',`${index+1}. ${play.event.type} · ${play.timestamp.toFixed(2)}s · 추정 후보`),node('p',`confidence ${play.confidence.toFixed(2)} · ${play.confidence_grade} · 플레이별 장점/개선점 판정 보류`),node('p',`영상 전체 관찰: 강점 ${play.context_feedback.strengths.length}, 개선점 ${play.context_feedback.weaknesses.length}. 이 플레이의 평가와 구분합니다.`));
    const button=node('button','2D / 3D 프레임 보기');button.disabled=play.visualization_reference.frame==null;button.addEventListener('click',()=>{activateTab(false);video.pause();const frame=play.visualization_reference.frame;video.currentTime=frame/result.sample_fps;updateFrame(frame,true);$('motion-panel').scrollIntoView({behavior:'smooth'});});card.append(copy,button);$('play-reports').appendChild(card);
  }
  $('growth-report').replaceChildren();$('player-aggregate').replaceChildren();$('growth-notice').textContent='같은 선수의 실제 기록과 DEMO 기록은 서로 비교하지 않습니다. 비교 조건을 입력하고 선수 기록을 조회하세요.';
}
function growthTable(headers,rows){const table=node('table',null,'growth-table');const head=node('tr');headers.forEach(label=>head.appendChild(node('th',label)));table.appendChild(head);for(const values of rows){const row=node('tr');for(const value of values){const td=node('td');td.appendChild(value instanceof HTMLElement?value:document.createTextNode(String(value)));row.appendChild(td);}table.appendChild(row);}const scroll=node('div',null,'growth-scroll');scroll.appendChild(table);return scroll;}
$('demo-growth').addEventListener('click',async()=>{
  try{const data=await(await fetch('/api/demo/growth')).json();$('growth-notice').textContent=data.label;$('player-aggregate').replaceChildren();$('growth-report').replaceChildren(growthTable(['DEMO 세션','임의 예시값','이전 대비','근거'],data.points.map(p=>[p.session,p.value,p.delta==null?'—':`+${p.delta}`,'DEMO · confidence 0.00 · 실제 계산 아님'])));}catch(error){$('growth-notice').textContent='DEMO 예시를 불러오지 못했습니다.';}
});
$('load-history').addEventListener('click',async()=>{
  const player=$('player-id').value.trim()||result?.player_id;if(!player){$('growth-notice').textContent='선수 ID를 입력하세요.';return;}
  const source=result?.synthetic_demo?'demo':'real';
  try{
    const requests=await Promise.all([fetch(`/api/players/${encodeURIComponent(player)}/history?source=${source}`),fetch(`/api/players/${encodeURIComponent(player)}/scouting-report?source=${source}`)]);
    if(requests.some(r=>!r.ok))throw new Error('조회 실패');const [history,aggregate]=await Promise.all(requests.map(r=>r.json()));
    $('growth-notice').textContent=`${source==='demo'?'DEMO 기록만':'실제 업로드 기록만'} · ${history.count}개 · 수치 변화는 실력 향상 판정이 아닙니다.`;
    $('player-aggregate').replaceChildren();for(const [category,value] of Object.entries(aggregate.roles))if(value)$('player-aggregate').appendChild(node('span',`${categoryLabels[category]} 최근 관찰: ${value.analysis_date}`,'aggregate-role'));
    const rows=history.points.flatMap(point=>{
      const preferred=['balance','head_stability_score','stance_width','knee_flexion'];
      const metrics=Object.entries(point.observations).filter(([,m])=>m.value!=null&&typeof m.value==='number').sort(([a],[b])=>(preferred.includes(a)?preferred.indexOf(a):99)-(preferred.includes(b)?preferred.indexOf(b):99)).slice(0,4);
      const link=node('button','영상 보기');link.addEventListener('click',async()=>{const response=await fetch(`/api/analysis/${point.analysis_id}`);if(response.ok){showResult(await response.json());activateTab(false);}});
      return metrics.length?metrics.map(([key,m],index)=>[point.analysis_date,roleLabels[point.role],key,m.value.toFixed(3),m.delta==null?'비교 보류':`${m.delta>=0?'+':''}${m.delta.toFixed(3)}`,m.reason||'동일 선언 조건의 관찰값 차이',index===0?link:'']):[[point.analysis_date,roleLabels[point.role],'관찰 없음','—','—','근거 부족',link]];
    });
    $('growth-report').replaceChildren(rows.length?growthTable(['날짜','역할','관찰 지표','값','이전 대비','비교 조건','시각화'],rows):node('p','이 선수·데이터 출처의 저장된 분석이 없습니다.','muted'));
  }catch(error){$('growth-notice').textContent=`기록 조회 오류: ${error.message}`;}
});
