const $=id=>document.getElementById(id),video=$('selection-video'),canvas=$('selection-canvas'),ctx=canvas.getContext('2d');
let fileURL=null,start=null,box=null,snapshot=null,sourceTime=0;
function valid(){const viewpoint=$('selection-viewpoint').value!=='unknown',yes=!!box&&viewpoint&&$('confirm-target').checked;$('validate-target').disabled=!yes;$('download-selection').disabled=!yes;
 // 아직 안 한 단계를 알려준다.
 const missing=!$('validation-file').files[0]?'영상을 먼저 선택해주세요.':!box?'장면을 멈추고 WONY를 사각형으로 지정해주세요.':!viewpoint?'화면 시점을 선택해주세요.':!$('confirm-target').checked?'지정한 선수가 WONY인지 확인해주세요.':'';
 if(!$('validation-status').dataset.busy)$('validation-status').textContent=missing;}
$('selection-viewpoint').onchange=valid;
$('validation-file').onchange=()=>{if(fileURL)URL.revokeObjectURL(fileURL);const file=$('validation-file').files[0];box=null;canvas.hidden=true;$('capture-selection').disabled=true;$('confirm-target').checked=false;valid();if(file){fileURL=URL.createObjectURL(file);video.src=fileURL;}};
video.onloadeddata=()=>{$('capture-selection').disabled=false;};
$('capture-selection').onclick=()=>{video.pause();sourceTime=video.currentTime;canvas.width=video.videoWidth;canvas.height=video.videoHeight;ctx.drawImage(video,0,0);snapshot=ctx.getImageData(0,0,canvas.width,canvas.height);box=null;$('confirm-target').checked=false;canvas.hidden=false;valid();};
const point=e=>{const r=canvas.getBoundingClientRect();return [Math.max(0,Math.min(canvas.width,(e.clientX-r.left)*canvas.width/r.width)),Math.max(0,Math.min(canvas.height,(e.clientY-r.top)*canvas.height/r.height))];};
canvas.onpointerdown=e=>{box=null;$('confirm-target').checked=false;valid();start=point(e);canvas.setPointerCapture(e.pointerId);};
canvas.onpointermove=e=>{if(!start)return;const end=point(e);box=[Math.min(start[0],end[0]),Math.min(start[1],end[1]),Math.abs(end[0]-start[0]),Math.abs(end[1]-start[1])].map(Math.round);ctx.putImageData(snapshot,0,0);ctx.strokeStyle='#ffda7a';ctx.lineWidth=4;ctx.strokeRect(...box);};
canvas.onpointerup=()=>{start=null;if(box&&(box[2]<10||box[3]<10))box=null;$('selection-description').textContent=box?`WONY 지정 완료 · ${sourceTime.toFixed(1)}초 장면 (영역 ${box.join(', ')})`:'WONY 몸 전체를 감싸는 사각형을 그려주세요.';valid();};
$('confirm-target').onchange=valid;
function selection(){return {player_id:'wony',confirmed_by_user:$('confirm-target').checked,viewpoint:$('selection-viewpoint').value,source_time:sourceTime,source_width:video.videoWidth,source_height:video.videoHeight,bbox:box,source:'manual_selection',pose_margin:Number($('pose-margin').value),role_hint:$('role-hint').value};}
$('download-selection').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(selection(),null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='wony-target-selection.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
$('validate-target').onclick=async()=>{const file=$('validation-file').files[0];if(!file||file.size>128*1024*1024||video.duration>120){$('validation-status').textContent='검증은 120초·128 MiB 이하 영상으로 진행합니다.';return;}$('validate-target').disabled=true;$('validation-status').dataset.busy='1';try{const form=new FormData();form.append('video',file);form.append('selection',JSON.stringify(selection()));$('validation-status').textContent='WONY를 따라가며 자세를 분석하고 있습니다… 영상 길이에 따라 1~5분 정도 걸릴 수 있습니다. 이 창을 닫지 마세요.';const response=await fetch('/api/validation',{method:'POST',body:form});const result=await response.json();if(!response.ok)throw new Error(typeof result.detail==='string'?result.detail:JSON.stringify(result.detail));location.href=result.report_url;}catch(e){delete $('validation-status').dataset.busy;$('validation-status').textContent=friendlyError(e.message);$('validate-target').disabled=false;}};

function friendlyError(message){
 if(/busy/i.test(message))return '다른 분석이 진행 중입니다. 잠시 후 다시 시도해주세요.';
 if(/Confirm/i.test(message))return '지정한 선수가 WONY인지 확인 체크를 해주세요.';
 if(/128 MiB|maximum/i.test(message))return '영상이 너무 큽니다. 128 MiB 이하로 잘라주세요.';
 if(/metadata|selection could not/i.test(message))return '영상 정보나 지정 영역을 확인하지 못했습니다. 120초 이하 영상인지, WONY 영역이 화면 안에 있는지 확인해주세요.';
 return `분석하지 못했습니다: ${message}`;
}
