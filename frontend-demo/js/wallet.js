// 츄르 지갑.
//
// 지급 조건 = 온라인 랭킹 조건 (isRewardEligible === isRankingEligible: 정상 CLEAR 만.
//   GAME OVER · NO FAIL · NO FAIL CLEAR · 자동 플레이 · 미리보기는 지급하지 않음)
// 지급량 = config.js CHURU_REWARDS × 곡별 조정 (churuRewardFor). 판당(playId) 최대 1번.
//
// 기준(authoritative) 잔액:
//   로그인 회원 → 서버(DB rhythm_wallet). 지급량 · 잔액 모두 DB 가 계산하고, 브라우저는 표시만 한다.
//   비로그인 / 온라인 기능 꺼짐 → 이 기기 localStorage (게스트용 보조 지갑, 서버 잔액과 합치지 않음)
import { DIFFICULTY_LABELS, churuRewardFor } from './config.js';
import { isRankingEligible } from './ranking.js';

export const WALLET_STORAGE_KEY = 'wonyRhythm.wallet.v1';
const KEEP_PLAY_IDS = 200;

/** 츄르 지급 대상인지 (랭킹과 같은 함수 하나) */
export const isRewardEligible = isRankingEligible;

/** 이 판의 보상량 (표시 · 게스트 지갑용. 로그인 회원은 DB 값이 우선) */
export function rewardFor(record) {
  return churuRewardFor(record?.difficulty, record?.songId);
}

export function rewardLabel(record) {
  return `${DIFFICULTY_LABELS[record?.difficulty] || ''} 클리어 보상`.trim();
}

function readLocal(storage) {
  try {
    const v = JSON.parse(storage?.getItem(WALLET_STORAGE_KEY) || 'null');
    const balance = Number.isInteger(v?.balance) && v.balance >= 0 ? v.balance : 0;
    const plays = Array.isArray(v?.plays) ? v.plays.filter(id => typeof id === 'string') : [];
    return { balance, plays };
  } catch {
    return { balance: 0, plays: [] };
  }
}

export function loadLocalBalance(storage = globalThis.localStorage) {
  return readLocal(storage).balance;
}

/**
 * 게스트 지갑에 이 판 보상 지급 (같은 playId 는 1번만).
 * @returns {{granted: boolean, amount: number, balanceBefore: number, balanceAfter: number, duplicate?: boolean, reason?: string}}
 */
export function grantLocalReward(record, context = {}, storage = globalThis.localStorage) {
  const w = readLocal(storage);
  const none = reason => ({ granted: false, amount: 0, balanceBefore: w.balance, balanceAfter: w.balance, reason });
  if (!isRewardEligible(record, context)) return none('not-eligible');
  if (typeof record.playId !== 'string' || !record.playId) return none('no-play-id');
  if (w.plays.includes(record.playId)) return { ...none('duplicate'), duplicate: true };
  const amount = rewardFor(record);
  const next = { balance: w.balance + amount, plays: [...w.plays, record.playId].slice(-KEEP_PLAY_IDS) };
  try {
    storage.setItem(WALLET_STORAGE_KEY, JSON.stringify(next));
  } catch {
    return none('save-failed');
  }
  return { granted: true, amount, balanceBefore: w.balance, balanceAfter: next.balance };
}

/**
 * 화면에 보여줄 잔액과 출처.
 * @param online getOnlineStatus() 결과
 * @returns {{balance: number|null, source: 'online'|'local'}}  balance null = 로그인 회원인데 서버 잔액을 못 읽음
 */
export function walletView(online, storage = globalThis.localStorage) {
  if (online?.onlineEnabled && online?.loggedIn) {
    return { balance: Number.isInteger(online.churuBalance) ? online.churuBalance : null, source: 'online' };
  }
  return { balance: loadLocalBalance(storage), source: 'local' };
}

export function walletText(balance) {
  return `🐟 츄르 ${Number.isInteger(balance) ? balance.toLocaleString('ko-KR') : '-'}`;
}

/** 지갑 배지 표시 (메인 · 상점 · 랭킹 화면 상단) */
export function renderWalletBadge(el, view) {
  el.textContent = walletText(view.balance);
  el.dataset.source = view.source;
  el.title = view.source === 'online' ? 'WONY PHONE 회원 츄르' : '이 기기에 저장된 츄르 (로그인하지 않은 플레이)';
  el.hidden = false;
}
