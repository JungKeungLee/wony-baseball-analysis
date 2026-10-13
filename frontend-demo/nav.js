// 공통 헤더: 모바일(820px 이하)에서 메뉴 버튼으로 사이트 메뉴를 펼치고 접는다.
const header=document.querySelector('.site-header'),toggle=header?.querySelector('.menu-toggle');
if(header&&toggle){
 const set=open=>{header.classList.toggle('open',open);toggle.setAttribute('aria-expanded',String(open));toggle.querySelector('.menu-text').textContent=open?'닫기':'메뉴';};
 toggle.addEventListener('click',()=>set(!header.classList.contains('open')));
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&header.classList.contains('open')){set(false);toggle.focus();}});
 header.querySelectorAll('.main-nav a').forEach(a=>a.addEventListener('click',()=>set(false)));
}
