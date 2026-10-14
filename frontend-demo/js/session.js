// 로그인 필수 (WONY PHONE 로그인 → 리듬게임 앱 → 60초 입장권 → WONY RHYTHM 세션 쿠키).
//
// 1차: 서버가 세션 없는 요청에는 게임 화면 대신 로그인 안내를 보낸다 (backend/app/main.py).
// 2차: 화면을 연 뒤 /api/rhythm/me 로 다시 확인 → 세션이 만료됐으면 로그인 안내로 보낸다 (이 파일).
// 3차: 기록 · 랭킹 · 츄르 API 는 세션이 없으면 401.
// 게임 도중에는 확인하지 않는다 (진행 중인 판을 끊지 않음). 만료는 결과 저장 때 알려준다.
import { getOnlineStatus } from './ranking.js';
import { purgeMemberData } from './storage.js';

export const SESSION_EXPIRED_TEXT = '로그인 세션이 만료되었습니다.\n다시 로그인해주세요.';

let status = null;

/** 로그인 상태 (화면당 1번 요청) */
export function memberStatus() {
  status ||= getOnlineStatus();
  return status;
}

/** 로그인 안내 화면으로 (서버가 세션이 없으면 로그인 안내를 보냄) */
export function goToLogin(reason = 'expired') {
  location.replace(`/?login=${reason}`);
}

/**
 * 회원 화면 공통: 이전 버전의 로컬 기록 · 츄르를 지우고, 세션이 없으면 로그인 안내로.
 * 서버에 닿지 않은 경우(error)는 보내지 않는다 (네트워크 문제로 화면이 튀지 않게).
 */
export async function requireMember() {
  purgeMemberData();
  const s = await memberStatus();
  if (!s.loggedIn && !s.error) goToLogin('expired');
  return s;
}
