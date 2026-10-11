import * as THREE from 'three';
import { OrbitControls } from '/demo/vendor/OrbitControls.js';

const $ = id => document.getElementById(id);
const video = $('overlay');
const timeline = $('timeline');
const roleLabels = {batter:'타격',defense:'수비',catcher:'포수',pitcher:'투수',baserunning:'주루',unknown:'역할 미확인'};
const eventLabels = {swing:'스윙',receive:'포구',fielding:'수비 동작',release:'투구',run:'주루',start:'출발',sprint:'주루'};
const eventLabel = type => eventLabels[type]||'플레이';
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
  if(!count){$('frame-counter').textContent='FRAME —';$('frame-label').textContent='시각화 프레임 없음';showFigure(null);renderAngles(null);return;}
  const next=Math.max(0,Math.min(index,count-1));
  if(!force&&next===frameIndex)return;
  frameIndex=next;timeline.value=String(next);
  const frame=result.visualization.pose3d.frames[next];
  const time=frame?.timestamp??next/result.sample_fps;
  $('clock').textContent=`${time.toFixed(1).padStart(4,'0')} / ${((count-1)/result.sample_fps).toFixed(1).padStart(4,'0')}`;
  $('frame-counter').textContent=`FRAME ${String(next+1).padStart(3,'0')} / ${count}`;
  $('frame-label').textContent=`${time.toFixed(2)}s · frame ${next}`;
  $('confidence-label').title=`추정 confidence ${frame?.confidence?.toFixed(2)||'0.00'} · LOW · 깊이 미보정`;
  showFigure(frame);
  const keys=result.visualization.keyframes.filter(k=>k.frame===next);
  const key=keys.find(k=>k.stage===preferredStage)||keys[0];
  preferredStage=key?.stage??null;
  document.querySelectorAll('.keyframe').forEach(button=>button.classList.toggle('selected',button.dataset.stage===preferredStage));
  renderAngles(key);
}
function jump(key){
  if(key.frame==null)return;
  video.pause();$('original-video').pause();if(selectedEntry?.source_url)$('original-video').currentTime=selectedEntry.start+key.timestamp;preferredStage=key.stage;
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
  result.visualization ||= {frame_count:0,keyframes:[],pose3d:{frames:[],edges:[]}};
  const vis=result.visualization;
  $('status').textContent=`${vis.frame_count} frames · ${result.sample_fps} fps · ${result.status}`;
  $('json-link').hidden=false;$('json-link').href=`/api/analysis/${result.id}`;
  video.src=vis.overlay_video_url||'';$('video-placeholder').hidden=!!vis.overlay_video_url;
  timeline.max=String(Math.max(vis.frame_count-1,0));timeline.disabled=!vis.frame_count;
  $('play').disabled=!vis.overlay_video_url;
  renderKeyframes();updateFrame(0,true);
}
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>{
  if(!camera||!controls)return;
  const positions={front:[0,.5,6],side:[6,.5,0],rear:[0,.5,-6]};camera.position.set(...positions[button.dataset.view]);controls.target.set(0,.15,0);controls.update();
  document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('selected',b===button));
}));
$('play').addEventListener('click',async()=>{const target=$('original-view').hidden?video:$('original-video');if(target.paused){if(target.ended)target.currentTime=target===video?0:selectedEntry.start;try{await target.play();}catch(error){$('status').textContent='재생을 시작할 수 없습니다.';}}else target.pause();});
video.addEventListener('play',()=>{$('play').innerHTML='❚❚ <span>일시 정지</span>';$('play').setAttribute('aria-label','일시 정지');});
video.addEventListener('pause',()=>{$('play').innerHTML='▶ <span>재생</span>';$('play').setAttribute('aria-label','재생');});
video.addEventListener('error',()=>{if(result)$('status').textContent='오버레이 영상을 불러오지 못했습니다. JSON과 키프레임을 확인하세요.';});
timeline.addEventListener('input',()=>{if(!result)return;video.pause();preferredStage=null;const index=Number(timeline.value);video.currentTime=index/result.sample_fps;$('original-video').pause();if(selectedEntry?.source_url)$('original-video').currentTime=selectedEntry.start+index/result.sample_fps;updateFrame(index,true);});
const sync=()=>{if(result&&!video.paused)updateFrame(Math.min(Math.floor(video.currentTime*result.sample_fps),result.visualization.frame_count-1));requestAnimationFrame(sync);};sync();

const metricLabels={stance_type:'기본 스탠스',swing_type:'스윙 궤적',head_stability:'머리 고정',weight_transfer:'체중 이동 추정',balance:'밸런스',stance_width:'스탠스 폭',knee_flexion:'무릎 굽힘',trunk_lean:'상체 기울기',torso_lean:'상체 기울기',head_stability_score:'머리 안정성 대리 지표',weight_transfer_score:'체중 이동 대리 지표',hip_rotation:'골반 회전 추정',shoulder_rotation:'어깨 회전 추정',elbow_angle:'팔꿈치 각도',wrist_angle:'손목 각도',leg_kick:'레그킥 후보',follow_through:'팔로스루',contact:'컨택',impact_time:'임팩트 후보 시점',release_time:'릴리스 후보 시점',first_step_time:'첫 이동 후보 시점',reaction_time:'반응 시간',transition_time:'송구 전환 후보 시간',running_posture:'주루 자세'};
const labelFor=key=>metricLabels[key]||key.replaceAll('_',' ');
const categoryByRole={batter:'batting',defense:'defense',catcher:'catching',pitcher:'pitching',baserunning:'baserunning'};
let bundle=null,activeRole='all',selectedEntry=null,selectedPlay=null;
function node(tag,text,cls){const el=document.createElement(tag);if(text!=null)el.textContent=String(text);if(cls)el.className=cls;return el;}
function feedback(id,items){$(id).replaceChildren();if(!items?.length)$(id).append(node('li','아직 판단할 근거가 부족합니다.','muted'));for(const item of [...new Set((items||[]).map(item=>typeof item==='string'?item:item.text||JSON.stringify(item)))]){$(id).append(node('li',item));}}
function value(m){return m?.value==null?'미지원 / 미검출':`${typeof m.value==='number'?m.value.toFixed(3):typeof m.value==='object'?JSON.stringify(m.value):m.value} ${m.unit||''} · 추정 ${m.confidence_grade||'low'} · confidence ${Number(m.confidence||0).toFixed(2)}`;}
const unitText={degrees:'°',degree:'°',seconds:'초',second:'초',torso_lengths:'× 몸통 길이',ratio:''};
function plain(m){if(m?.value==null)return '—';const v=m.value;if(typeof v==='boolean')return v?'있음':'없음';const unit=m.unit==null?'':unitText[m.unit]??m.unit;return `${typeof v==='number'?(Math.abs(v)>=10?v.toFixed(1):v.toFixed(2)):typeof v==='object'?Object.values(v).join(' · '):v}${unit==='°'?unit:unit?' '+unit:''}`;}
function duration(s){s=Math.round(s||0);if(s<60)return `${s}초`;const m=Math.floor(s/60);return m<60?`${m}분 ${s%60}초`:`${Math.floor(m/60)}시간 ${m%60}분`;}
function hhmmss(t){t=Math.floor(t);return [Math.floor(t/3600),Math.floor(t/60)%60,t%60].map(v=>String(v).padStart(2,'0')).join(':');}
function visibleEntries(){return bundle.entries.filter(e=>activeRole==='all'||e.analysis.role===activeRole);}
function selectRole(role){activeRole=role;document.querySelectorAll('[data-report-role]').forEach(b=>{const selected=b.dataset.reportRole===role;b.classList.toggle('selected',selected);b.setAttribute('aria-selected',String(selected));});$('overview').hidden=role!=='all';$('role-detail').hidden=role==='all';video.pause();$('original-video').pause();$('play-detail').hidden=true;if(role!=='all')renderRole();renderPlays();}
function renderRole(){const entries=visibleEntries();$('role-title').textContent=roleLabels[activeRole]+' 분석';$('role-summary').replaceChildren();$('role-metrics').replaceChildren();const strengths=[],weaknesses=[],coaching=[];
 for(const entry of entries){const r=entry.analysis;strengths.push(...r.strengths||[]);weaknesses.push(...r.weaknesses||[]);coaching.push(...r.coaching||[]);const section=node('article',null,'report-section');section.append(node('strong',`${hhmmss(entry.start)} ~ ${hhmmss(entry.end||entry.start)} · ${r.status}`));for(const [key,m] of Object.entries(r.summary||{}))section.append(node('p',`${labelFor(key)}: ${typeof m==='object'?value(m):m}`));$('role-summary').append(section);
 const metrics=Object.entries(r.metrics||{});const ordered=metrics.filter(([,m])=>m.value!=null).sort((a,b)=>(b[1].confidence||0)-(a[1].confidence||0));const main=ordered.slice(0,8);const chosen=new Set(main.map(([key])=>key));
 function metricBox(key,m,simple){const box=node('div',null,'angle-item');box.append(node('span',labelFor(key),'label'),node('span',simple?plain(m):value(m),'observed'));if(simple)box.title=value(m);else if(m.reason)box.append(node('small',m.reason));return box;}
 for(const [key,m] of main)$('role-metrics').append(metricBox(key,m,true));
 const remaining=metrics.filter(([key])=>!chosen.has(key));if(remaining.length){const details=node('details',null,'all-metrics');details.append(node('summary',`상세 정보 · 전체 지표 ${remaining.length}개 더 보기`));const grid=node('div',null,'angle-grid');for(const [key,m] of remaining)grid.append(metricBox(key,m));details.append(grid);$('role-metrics').append(details);}
 const evals=r.scouting_report?.role_evaluations?.[categoryByRole[activeRole]];if(evals){const p=node('p','스카우팅 점수/등급: 보류 · 검증된 채점 기준 없음');$('role-summary').append(p);}}
 feedback('role-strengths',strengths);feedback('role-weaknesses',weaknesses);feedback('role-coaching',coaching);
}
function plays(entry){return entry.analysis.scouting_report?.plays||((entry.analysis.events||[]).map((event,index)=>({id:`${entry.analysis.id}-${index}`,timestamp:event.timestamp,event,confidence:event.confidence,estimated:true,strengths:[],weaknesses:[],coaching:[],visualization_reference:{frame:Math.round(event.timestamp*entry.analysis.sample_fps)},keyframe:null})));}
function renderPlays(){const list=$('play-list');list.replaceChildren();let count=0;for(const entry of visibleEntries()){const items=plays(entry);if(!items.length){const b=node('button',`${roleLabels[entry.analysis.role]} · ${hhmmss(entry.start)} 장면 보기`,'play-link');b.addEventListener('click',()=>openPlay(entry,null));list.append(b);continue;}for(const play of items){count++;const button=node('button',`${roleLabels[entry.analysis.role]} ${count} · ${hhmmss(entry.start+play.timestamp)} · ${eventLabel(play.event.type)}`,'play-link');button.addEventListener('click',()=>openPlay(entry,play));list.append(button);}}if(!list.children.length)list.append(node('p','이 역할의 플레이가 없습니다.','empty'));}
function setMode(mode){document.querySelectorAll('[data-mode]').forEach(b=>b.classList.toggle('selected',b.dataset.mode===mode));$('original-view').hidden=mode!=='original';$('skeleton-view').hidden=mode!=='skeleton';$('pose-view').hidden=mode!=='pose';$('original-video').pause();video.pause();if(mode==='original'&&selectedEntry?.source_url)$('original-video').currentTime=selectedEntry.start+Math.max(0,Number(timeline.value))/result.sample_fps;}
function openPlay(entry,play){selectedEntry=entry;selectedPlay=play;$('play-detail').hidden=false;showResult(entry.analysis);const timestamp=play?.timestamp||0;const frame=play?.visualization_reference?.frame;
 if(frame!=null){video.currentTime=timestamp;updateFrame(frame,true);}const original=$('original-video');original.src=entry.source_url||'';original.currentTime=entry.start+timestamp;original.onloadedmetadata=()=>{original.currentTime=entry.start+timestamp;};
 const originalButton=document.querySelector('[data-mode="original"]');originalButton.disabled=!entry.source_url;originalButton.title=entry.source_url?'':'원본이 보관되지 않은 분석입니다. 오버레이를 원본으로 표시하지 않습니다.';
 $('original-notice').textContent=entry.source_url?'방송 원본의 해당 구간 · 분석 시각은 클립 상대시간입니다.':'원본 미보관: 업로드 원본은 기존 정책에 따라 삭제됐습니다.';
 $('play-title').textContent=`${roleLabels[entry.analysis.role]} · ${hhmmss(entry.start+timestamp)} · ${play?eventLabel(play.event.type):'장면 전체'}`;
 $('play-confidence').textContent=play?`이벤트 ${play.event.type} · 추정 confidence ${Number(play.confidence||0).toFixed(2)} · 플레이 성공/실패 판정 아님`:'이벤트 미검출 · 클립 전체 자세 관찰';
 feedback('play-strengths',play?.strengths);feedback('play-weaknesses',play?.weaknesses);feedback('play-coaching',play?.coaching);setMode('skeleton');$('play-detail').scrollIntoView({behavior:'smooth',block:'start'});
}
$('original-video').addEventListener('timeupdate',()=>{if(!selectedEntry)return;const relative=$('original-video').currentTime-selectedEntry.start;if(relative>=(selectedEntry.end||Infinity)-selectedEntry.start)$('original-video').pause();updateFrame(Math.floor(Math.max(0,relative)*result.sample_fps),true);});
document.querySelectorAll('[data-report-role]').forEach(b=>b.addEventListener('click',()=>selectRole(b.dataset.reportRole)));
document.querySelectorAll('[data-mode]').forEach(b=>b.addEventListener('click',()=>setMode(b.dataset.mode)));
async function renderGrowth(){const entries=bundle.entries;const rows=[];for(const entry of entries){const r=entry.analysis;if(!r.player_id)continue;try{const response=await fetch(`/api/players/${encodeURIComponent(r.player_id)}/history?source=${r.synthetic_demo?'demo':'real'}`);if(!response.ok)continue;const h=await response.json();const point=h.points.find(p=>p.analysis_id===r.id);if(!point)continue;for(const [key,m] of Object.entries(point.observations).filter(([,m])=>typeof m.value==='number').slice(0,4)){rows.push([r.analysis_date,roleLabels[r.role],labelFor(key),m.value.toFixed(2),m.delta==null?'비교 불가':`${m.delta>=0?'+':''}${m.delta.toFixed(2)}`]);}}catch{}}
 $('growth-notice').className='hint';$('growth-notice').textContent='같은 선수 · 같은 촬영 조건의 이전 분석과 비교한 변화입니다.';
 if(!rows.length){$('growth-report').replaceChildren(node('p','비교할 이전 분석이 아직 없습니다. 같은 선수를 다시 분석하면 변화가 표시됩니다.','empty'));return;}const table=node('table',null,'growth-table');const header=node('tr');['날짜','역할','항목','이번 값','이전 대비'].forEach(x=>header.append(node('th',x)));table.append(header);rows.forEach(values=>{const tr=node('tr');values.forEach(v=>tr.append(node('td',v)));table.append(tr);});const wrap=node('div',null,'growth-scroll');wrap.append(table);$('growth-report').replaceChildren(wrap);
}
async function loadReport(){try{const id=location.pathname.split('/').filter(Boolean).at(-1);const response=await fetch(`/api/reports/${encodeURIComponent(id)}`);if(!response.ok)throw new Error('분석 리포트를 찾을 수 없습니다.');bundle=await response.json();const roles=new Set(bundle.entries.map(e=>e.analysis.role));document.querySelectorAll('[data-report-role]').forEach(b=>{if(b.dataset.reportRole==='all')return;b.disabled=!roles.has(b.dataset.reportRole);b.title=b.disabled?'분석 기록 없음':'';});
 const summaries=bundle.entries.map(e=>e.analysis.scouting_report?.overall_summary||'스카우팅 요약 미보관');const roleWords={batting:'타격',defense:'수비',catching:'포수',pitching:'투수',baserunning:'주루'};$('report-summary').textContent=[...new Set(summaries)].join(' ').replace(/(batting|defense|catching|pitching|baserunning)/g,w=>roleWords[w]);
 const segments=bundle.segments?.map(s=>`${hhmmss(s.start)} ~ ${hhmmss(s.end??s.last_signal??s.start)}`).join(', ');const coverage=bundle.entries.reduce((sum,e)=>sum+Math.max(0,(e.end||e.start)-e.start),0);
 $('report-meta').textContent=`분석 날짜 ${bundle.analysis_date||'미보관'} · ${segments?'야구 후보 구간 '+segments:'단일 분석 클립'} · 실제 처리 ${coverage.toFixed(1)}초 / ${bundle.entries.length}클립 · 역할 ${[...roles].map(r=>roleLabels[r]||r).join(' · ')}`;
 $('source-badge').hidden=!bundle.synthetic_demo;$('source-badge').textContent='예시 데이터 (DEMO)';$('source-badge').title='합성 데이터 · 실제 선수 평가 아님';
 const playCounts={};for(const e of bundle.entries){const n=plays(e).length||1;playCounts[e.analysis.role]=(playCounts[e.analysis.role]||0)+n;}
 const baseballSeconds=bundle.segments?.length?bundle.segments.reduce((sum,s)=>sum+Math.max(0,s.duration??((s.end??s.last_signal??s.start)-s.start)),0):coverage;
 $('sum-date').textContent=bundle.analysis_date||'—';$('sum-time').textContent=duration(baseballSeconds);$('sum-plays').textContent=`${Object.values(playCounts).reduce((a,b)=>a+b,0)}개`;
 $('sum-roles').replaceChildren(...Object.entries(playCounts).map(([role,n])=>{const c=node('span',roleLabels[role]||role,'role-count');c.append(node('b',String(n)));return c;}));$('status').textContent='공식 스카우팅 점수 아님 · 낮은 confidence는 판정 보류';
 feedback('report-strengths',bundle.entries.flatMap(e=>e.analysis.scouting_report?.strengths||e.analysis.strengths||[]));feedback('report-development',bundle.entries.flatMap(e=>e.analysis.scouting_report?.development_areas||e.analysis.weaknesses||[]));selectRole('all');renderGrowth();
 }catch(error){$('report-error').textContent=error.message;}}
loadReport();

$('original-video').addEventListener('play',()=>{$('play').textContent='❚❚ 일시 정지';});$('original-video').addEventListener('pause',()=>{$('play').textContent='▶ 재생';});
