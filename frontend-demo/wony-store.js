// WONY 지정 분석 결과 목록 API가 없어서, 리포트를 연 브라우저에 요약만 저장한다.
// 기기·브라우저마다 따로 저장되며, 지워져도 분석 결과 자체(서버)는 남는다.
const KEY='wony.recentValidations';
export function recentWony(){try{const items=JSON.parse(localStorage.getItem(KEY)||'[]');return Array.isArray(items)?items:[];}catch{return [];}}
export function saveWony(a){
 try{
  const tools=Object.values(a.scouting_report?.player_tools||{});
  const item={id:a.id,url:`/demo/validation/report/${a.id}`,date:a.analysis_date,saved_at:a.created_at,role:a.role,
   role_source:a.role_input?.source,auto_role:a.automatic_role_estimate?.value,
   duration:a.validation_summary?.metadata?.duration_seconds,status:a.status,lost_at:a.target_tracking?.lost_at??null,
   tools_total:tools.length,tools_scored:tools.filter(t=>t.score!=null).length};
  const items=[item,...recentWony().filter(i=>i.id!==a.id)].slice(0,30);
  localStorage.setItem(KEY,JSON.stringify(items));
 }catch{}
}
