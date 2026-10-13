// 서버 응답을 안전하게 읽는다: 본문을 먼저 text로 읽고, JSON일 때만 파싱한다.
// 빈 본문 · HTML · 일반 텍스트 · 연결 끊김(서버 재시작 · 메모리 부족 · 프록시 시간 초과)도 원인을 그대로 보여준다.
const KNOWN={401:'로그인이 필요하거나 세션이 만료됐습니다. WONY PHONE에서 다시 열어주세요.',403:'접근 권한이 없습니다.',
 413:'영상 파일이 너무 큽니다.',502:'서버가 응답하지 못했습니다 (HTTP 502). 분석 중 서버가 재시작됐을 수 있어요 (메모리 부족 등).',
 503:'서버가 잠시 사용할 수 없습니다 (HTTP 503).',504:'서버 응답 시간이 초과됐습니다 (HTTP 504).'};

export class HttpError extends Error{
 constructor(message,info){super(message);this.name='HttpError';Object.assign(this,info);}
}

function plain(text){return text.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,300);}
function detailOf(data){const d=data?.detail;return typeof d==='string'?d:d?.message||(d!=null?JSON.stringify(d):null);}

/** fetch + 안전한 본문 읽기. 성공이면 JSON 데이터를, 아니면 원인이 담긴 HttpError를 던진다. */
export async function requestJson(url,options={}){
 const method=(options.method||'GET').toUpperCase();let response;
 try{response=await fetch(url,options);}
 catch(error){console.error('[WONY] request failed before a response',{url,method,error});
  throw new HttpError('서버와 연결이 끊겼습니다. 인터넷 연결이나 서버 상태를 확인한 뒤 다시 시도해주세요.',{url,method,status:0,body:''});}
 const text=await response.text().catch(()=>''),type=response.headers.get('content-type')||'';
 const info={url,method,status:response.status,contentType:type,body:text.slice(0,2000),
  headers:Object.fromEntries([...response.headers].filter(([k])=>/^(content-|x-render|rndr|cf-|server|date)/i.test(k)))};
 let data=null,parsed=false;
 if(text.trim()&&(type.includes('json')||/^\s*[\[{]/.test(text))){try{data=JSON.parse(text);parsed=true;}catch{}}
 if(!response.ok){
  console.error('[WONY] request failed',info);
  const detail=parsed?detailOf(data):null;
  const message=detail||(text.trim()?`서버 오류 (HTTP ${response.status}): ${plain(text)||text.slice(0,300)}`:KNOWN[response.status]||`서버가 빈 응답을 보냈습니다 (HTTP ${response.status}).`);
  throw new HttpError(message,{...info,data});
 }
 if(response.status===204||!text.trim()){console.error('[WONY] empty success response',info);throw new HttpError(`서버 응답이 비어 있습니다 (HTTP ${response.status}).`,info);}
 if(!parsed){console.error('[WONY] non-JSON success response',info);throw new HttpError(`서버가 JSON이 아닌 응답을 보냈습니다 (HTTP ${response.status}, ${type||'형식 없음'}): ${plain(text)}`,info);}
 return data;
}
