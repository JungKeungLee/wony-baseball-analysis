const $=id=>document.getElementById(id),video=$('selection-video'),canvas=$('selection-canvas'),ctx=canvas.getContext('2d');
let fileURL=null,start=null,box=null,snapshot=null,sourceTime=0;
// 영상 크기·길이를 읽기 전에는 분석할 수 없다 (0 / NaN / Infinity 방지).
const metadataReady=()=>video.videoWidth>0&&video.videoHeight>0&&Number.isFinite(video.duration)&&video.duration>0;
function valid(){const file=!!$('validation-file').files[0],ready=file&&metadataReady(),viewpoint=$('selection-viewpoint').value!=='unknown',confirmed=$('confirm-target').checked,yes=ready&&!!box&&viewpoint&&confirmed;$('validate-target').disabled=!yes;$('download-selection').disabled=!yes;
 // 앞 단계를 끝내야 다음 단계가 밝아진다 (표시만 바꾸고 입력은 막지 않는다).
 $('step-select').classList.toggle('locked',!file);$('step-role').classList.toggle('locked',!box);$('step-start').classList.toggle('locked',!yes);
 for(const [id,done] of [['step-file',file],['step-select',!!box&&confirmed],['step-role',!!box&&confirmed]])$(id).classList.toggle('done',done);
 // 지금 할 단계 하나만 파랗게: 끝나지 않았고 잠기지 않은 첫 단계
 const steps=['step-file','step-select','step-role','step-start'].map($),current=steps.find(s=>!s.classList.contains('done')&&!s.classList.contains('locked'));for(const s of steps)s.classList.toggle('current',s===current);
 const missing=!file?'1단계: 영상을 먼저 올려주세요.':!ready?'영상 정보를 불러오는 중입니다… 잠시 후에도 이 문구가 보이면 영상을 다시 선택해주세요.':!box?'2단계: 영상을 멈추고 WONY를 네모로 감싸주세요.':!confirmed?'2단계: 고른 선수가 WONY가 맞는지 체크해주세요.':'';
 if(!$('validation-status').dataset.busy)$('validation-status').textContent=missing;}
$('selection-viewpoint').onchange=valid;
$('validation-file').onchange=()=>{if(fileURL)URL.revokeObjectURL(fileURL);const file=$('validation-file').files[0];box=null;canvas.hidden=true;$('capture-selection').disabled=true;$('confirm-target').checked=false;valid();if(file){fileURL=URL.createObjectURL(file);video.src=fileURL;}};
video.onloadeddata=()=>{$('capture-selection').disabled=!metadataReady();valid();};video.onloadedmetadata=valid;video.onerror=()=>{$('validation-status').textContent='영상 정보를 불러오지 못했습니다. 영상을 다시 선택해주세요.';};
$('capture-selection').onclick=()=>{video.pause();sourceTime=video.currentTime;canvas.width=video.videoWidth;canvas.height=video.videoHeight;ctx.drawImage(video,0,0);snapshot=ctx.getImageData(0,0,canvas.width,canvas.height);box=null;$('confirm-target').checked=false;canvas.hidden=false;valid();};
// 캔버스는 영상의 표시 크기(videoWidth×videoHeight)로 그려지므로 여백(letterbox)이 없다. 테두리(clientLeft/Top)만 빼고 비율 변환한다.
const point=e=>{const r=canvas.getBoundingClientRect(),w=canvas.clientWidth,h=canvas.clientHeight;return [Math.max(0,Math.min(canvas.width,(e.clientX-r.left-canvas.clientLeft)*canvas.width/w)),Math.max(0,Math.min(canvas.height,(e.clientY-r.top-canvas.clientTop)*canvas.height/h))];};
canvas.onpointerdown=e=>{box=null;$('confirm-target').checked=false;valid();start=point(e);canvas.setPointerCapture(e.pointerId);};
canvas.onpointermove=e=>{if(!start)return;const end=point(e);box=[Math.min(start[0],end[0]),Math.min(start[1],end[1]),Math.abs(end[0]-start[0]),Math.abs(end[1]-start[1])].map(Math.round);ctx.putImageData(snapshot,0,0);ctx.strokeStyle='#ffda7a';ctx.lineWidth=4;ctx.strokeRect(...box);};
canvas.onpointerup=()=>{start=null;if(box&&(box[2]<10||box[3]<10))box=null;$('selection-description').textContent=box?`WONY 선택 완료 (${sourceTime.toFixed(1)}초 장면)`:'WONY 몸 전체를 감싸도록 네모를 그려주세요.';valid();};
$('confirm-target').onchange=valid;
function selection(){return {player_id:'wony',confirmed_by_user:$('confirm-target').checked,viewpoint:$('selection-viewpoint').value,source_time:sourceTime,source_width:video.videoWidth,source_height:video.videoHeight,bbox:box,source:'manual_selection',pose_margin:Number($('pose-margin').value),role_hint:$('role-hint').value};}
$('download-selection').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(selection(),null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='wony-target-selection.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
$('validate-target').onclick=async()=>{const file=$('validation-file').files[0];
 const fail=text=>{$('validation-status').textContent=text;};
 if(!file||!metadataReady())return fail('영상 정보를 불러오지 못했습니다. 영상을 다시 선택해주세요.');
 if(video.duration>120)return fail('120초 이하 영상만 분석할 수 있습니다.');
 if(file.size>128*1024*1024)return fail('128 MiB 이하 영상만 분석할 수 있습니다.');
 if(!box)return fail('WONY 영역을 다시 선택해주세요.');
 if(canvas.width!==video.videoWidth||canvas.height!==video.videoHeight||box[0]<0||box[1]<0||box[0]+box[2]>video.videoWidth||box[1]+box[3]>video.videoHeight)return fail('선택 영역을 확인하지 못했습니다. WONY를 다시 지정해주세요.');
 const r=canvas.getBoundingClientRect();
 console.info('[WONY] validation payload',{file:{name:file.name,size:file.size,type:file.type},duration:video.duration,videoWidth:video.videoWidth,videoHeight:video.videoHeight,
  displayedVideo:[Math.round(video.getBoundingClientRect().width),Math.round(video.getBoundingClientRect().height)],canvasCss:[canvas.clientWidth,canvas.clientHeight],canvasRect:[r.width,r.height],
  roiBrowserPixels:box,coordinateSystem:'browser natural size (videoWidth×videoHeight, SAR applied); server maps to source pixels',selection:selection()});$('validate-target').disabled=true;$('validation-status').dataset.busy='1';try{const form=new FormData();form.append('video',file);form.append('selection',JSON.stringify(selection()));$('validation-status').textContent='분석 중입니다… 영상 길이에 따라 1~5분 걸릴 수 있어요. 이 창을 닫지 마세요.';const response=await fetch('/api/validation',{method:'POST',body:form});const result=await response.json();if(!response.ok)throw new Error(typeof result.detail==='string'?result.detail:JSON.stringify(result.detail));location.href=result.report_url;}catch(e){delete $('validation-status').dataset.busy;$('validation-status').textContent=friendlyError(e.message);$('validate-target').disabled=false;}};

function friendlyError(message){
 const code=(/^\[(\w+)\]/.exec(message)||[])[1];
 const byCode={video_metadata_unreadable:'영상 정보를 불러오지 못했습니다. 영상을 다시 선택해주세요.',video_too_long:'120초 이하 영상만 분석할 수 있습니다.',video_too_large:'128 MiB 이하 영상만 분석할 수 있습니다.',video_empty:'빈 영상입니다. 영상을 다시 선택해주세요.',
  selection_missing:'WONY 영역을 다시 선택해주세요.',selection_out_of_frame:'선택 영역을 확인하지 못했습니다. WONY를 다시 지정해주세요.',selection_size_mismatch:'선택 영역의 기준 크기가 영상과 맞지 않습니다. 영상을 다시 선택한 뒤 WONY를 다시 지정해주세요.',selection_time_out_of_range:'선택한 장면 시간이 영상 길이를 벗어났습니다. 장면을 다시 골라주세요.',
  selection_invalid_json:'선택 정보를 보내지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해주세요.',selection_invalid:'선택 정보를 확인하지 못했습니다. WONY를 다시 지정해주세요.',not_confirmed:'고른 선수가 WONY가 맞는지 체크해주세요.',engine_busy:'다른 분석이 진행 중입니다. 잠시 후 다시 시도해주세요.',
  analysis_input_rejected:'영상을 분석하는 중 입력을 처리하지 못했습니다. 다른 장면에서 WONY를 다시 지정해보세요.'};
 return byCode[code]||`분석하지 못했습니다: ${message}`;
}
valid();
