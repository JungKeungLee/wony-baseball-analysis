export function addCaptureForm(container,prefix,{identity=true}={}){
 const details=document.createElement('div');details.className='capture-settings';const summary=document.createElement('p');summary.textContent='성장 비교용 촬영 조건 (선택)';details.append(summary);
 const grid=document.createElement('div');grid.className='player-settings';
 for(const [key,label,options] of [
  ['player','선수 ID'],['context','같은 촬영/과제 그룹'],['angle','카메라 각도'],
  ['environment','영상 환경',['','real','vr']],['vr','VR 게임/환경'],
  ['quality','화질',['','good','fair','poor']],['motion','카메라 움직임',['','fixed','moving','unknown']],
  ['projection','영상 투영',['flat','360']]]){
  if(!identity&&['player','context'].includes(key))continue;
  const row=document.createElement('label');row.textContent=label+' ';const input=document.createElement(options?'select':'input');input.id=prefix+'-'+key;
  if(options)for(const value of options){const option=document.createElement('option');option.value=value;option.textContent=value||'미지정';input.append(option);}else input.maxLength=key==='player'?64:80;
  row.append(input);grid.append(row);
 }
 details.append(grid);const p=document.createElement('p');p.className='hint';p.textContent='조건은 사용자가 선언한 정보입니다. 고정 카메라·같은 각도/환경/화질의 기록만 비교하며, 관측값 변화는 실력 향상 판정이 아닙니다.';details.append(p);container.append(details);
}
export function appendCapture(form,prefix,{identity=true}={}){
 const get=key=>document.getElementById(prefix+'-'+key)?.value.trim()||'';
 if(identity){if(get('player'))form.append('player_id',get('player'));if(get('context'))form.append('comparison_context',get('context'));}
 const angle=get('angle'),environment=get('environment'),quality=get('quality'),motion=get('motion'),vr=get('vr');
 if(![angle,environment,quality,motion,vr].some(Boolean))return;
 if(!angle||!environment||!quality||!motion||(environment==='vr'&&!vr))throw new Error('성장 비교 조건을 모두 입력하세요. VR은 게임/환경도 필요합니다.');
 form.append('capture_context',JSON.stringify({camera_angle:angle,environment,vr_environment:environment==='vr'?vr:null,video_quality:quality,camera_motion:motion,projection:get('projection')||'flat'}));
}
