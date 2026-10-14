// 츄르 (로그인 회원 전용).
//
// 지급 조건 = 온라인 랭킹 조건 (isRewardEligible === isRankingEligible: 정상 CLEAR 만.
//   GAME OVER · NO FAIL · NO FAIL CLEAR · 자동 플레이 · 미리보기는 지급하지 않음)
// 지급량 · 잔액은 서버(DB rhythm_wallet · rhythm_reward_rules)가 계산한다. 이 기기에는 저장하지 않는다.
// 아래 rewardFor 는 결과 화면에서 서버 응답을 기다리는 동안 보여줄 예상값일 뿐이다.
import { DIFFICULTY_LABELS, churuRewardFor } from './config.js';
import { isRankingEligible } from './ranking.js';

/** 츄르 지급 대상인지 (랭킹과 같은 함수 하나) */
export const isRewardEligible = isRankingEligible;

/** 이 판의 예상 보상량 (표시용. 실제 지급량은 DB 값) */
export function rewardFor(record) {
  return churuRewardFor(record?.difficulty, record?.songId);
}

export function rewardLabel(record) {
  return `${DIFFICULTY_LABELS[record?.difficulty] || ''} 클리어 보상`.trim();
}

/**
 * 화면에 보여줄 잔액 (로그인 회원의 서버 잔액).
 * @param online getOnlineStatus() 결과
 * @returns {{balance: number|null}}  null = 비로그인이거나 서버 잔액을 못 읽음
 */
export function walletView(online) {
  const ok = online?.loggedIn === true && Number.isInteger(online.churuBalance);
  return { balance: ok ? online.churuBalance : null };
}

export function walletText(balance) {
  return `🐟 츄르 ${Number.isInteger(balance) ? balance.toLocaleString('ko-KR') : '-'}`;
}

/** 지갑 배지 표시 (메인 · 상점 · 랭킹 화면 상단) */
export function renderWalletBadge(el, view) {
  el.textContent = walletText(view.balance);
  el.title = Number.isInteger(view.balance) ? 'WONY PHONE 회원 츄르' : '츄르 잔액을 불러오지 못했어요';
  el.hidden = false;
}
