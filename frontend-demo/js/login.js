// 로그인 안내 화면 (서버가 세션 없는 요청에 게임 화면 대신 보냄).
import { purgeMemberData } from './storage.js';

// 로그인하지 않은 상태에서는 이 기기에 회원 데이터(이전 버전의 기록 · 츄르)를 남기지 않는다
purgeMemberData();

const MESSAGES = {
  failed: '로그인 링크가 만료되었거나 이미 사용되었어요. WONY PHONE에서 다시 열어주세요.',
  unavailable: '로그인 기능이 아직 준비되지 않았어요.',
  expired: '로그인 세션이 만료되었습니다. 다시 로그인해주세요.',
};
const params = new URLSearchParams(location.search);
const message = MESSAGES[params.get('login')];
if (message) {
  const el = document.getElementById('loginMessage');
  el.textContent = message;
  el.hidden = false;
}

const link = document.getElementById('phoneLink');
if (!/^https?:\/\//.test(link.dataset.phoneUrl || '')) {   // 서버에 WONY_PHONE_URL 이 없음
  link.hidden = true;
  document.getElementById('phoneMissing').hidden = false;
}
