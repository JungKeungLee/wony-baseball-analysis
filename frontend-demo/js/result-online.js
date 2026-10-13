// 결과 화면의 온라인 랭킹 · 츄르 영역 (결과는 먼저 바로 보여주고, 이 부분만 비동기로 채운다).
//
// 순서: 결과(즉시) → 🏆 순위 변화 → 🐟 츄르 보상
//   정상 CLEAR + 로그인 : 서버 저장 1번 (DB 가 같은 트랜잭션에서 저장 전 순위 → 저장 → 저장 후 순위 · 츄르 지급) → 순위 연출 → 츄르 연출
//                        → 랭킹 미리보기(상위 3 + 내 앞뒤)
//   정상 CLEAR + 비로그인: 랭킹은 로그인 안내, 츄르는 이 기기 지갑(게스트)
//   GAME OVER · NO FAIL : 최근 기록용으로 서버 저장은 하되 랭킹 · 츄르 제외 안내
//   AUTO · PREVIEW      : 서버 요청 없음, 랭킹 · 츄르 제외 안내
// 어떤 실패도 결과 화면 · 로컬 기록을 막지 않는다.
import { DIFFICULTY_LABELS } from './config.js';
import { CHURU_ANIMATION_MS, RANK_ANIMATION_MS, animateNumber, describeRankChange } from './rank-change.js';
import { isOnlineSubmittable, isRankingEligible, rankingExclusionText } from './ranking.js';
import { rankingProblemText, renderRankingList } from './ranking-view.js';
import { rewardFor, rewardLabel } from './wallet.js';

export const ONLINE_TEXT = Object.freeze({
  checking: '온라인 기록 확인 중...',
  failed: '온라인 기록을 불러오지 못했습니다. 로컬 기록은 정상적으로 저장되었습니다.',
  'login-required': '로그인하지 않아 온라인 기록은 저장되지 않았어요. 로컬 기록은 정상적으로 저장되었습니다.',
  'not-configured': '온라인 기록 기능이 아직 준비되지 않았어요. 로컬 기록은 정상적으로 저장되었습니다.',
  'too-many': '잠시 후 다시 플레이하면 온라인에 저장돼요. 로컬 기록은 정상적으로 저장되었습니다.',
  saved: '온라인 기록 저장 완료 · 랭킹 반영',
  savedOnly: '온라인 기록 저장 완료',
});
export const CHURU_TEXT = Object.freeze({
  failed: '츄르 보상 처리에 실패했습니다.',
  duplicate: '이 플레이의 보상은 이미 지급되었습니다.',
  guest: '이 기기에 저장된 츄르예요. WONY PHONE 회원으로 플레이하면 계정에 쌓여요.',
  pending: '보상 확인 중...',
});

const fmt = n => (Number.isFinite(n) ? Math.round(n).toLocaleString('ko-KR') : '-');
const wait = ms => new Promise(r => setTimeout(r, ms));
const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, textContent: text ?? '' });

/**
 * @param {object} p
 * @param {object} p.record  결과 기록 (playId 포함)
 * @param {object} p.context { autoplay, preview }
 * @param {object} p.els     { box, status, change, medal, transition, delta, badges, ranking, churu, churuTitle, churuAmount,
 *                             churuFrom, churuTo, churuNote, fullRanking }
 * @param {Promise<object>} p.online  getOnlineStatus() 결과
 * @param {object} p.deps    { submitRanking, loadRanking, grantLocalReward }
 * @param {boolean} p.reducedMotion
 * @param {() => boolean} p.isCurrent  같은 결과 화면이 아직 떠 있는지 (다시 하기를 누르면 false → 표시 중단)
 * @param {string} p.rankingHref  [전체 랭킹 보기] 주소
 */
export async function runResultOnline({ record, context, els, online, deps, reducedMotion = false, isCurrent = () => true, rankingHref }) {
  const eligible = isRankingEligible(record, context);
  const submittable = isOnlineSubmittable(record, context);
  const exclusion = rankingExclusionText(record, context);
  resetView(els);

  // 랭킹 · 츄르 제외 판 (AUTO / PREVIEW / GAME OVER / NO FAIL)
  if (!eligible) {
    els.box.hidden = false;
    els.status.textContent = exclusion;
    if (!submittable) return { stage: 'excluded' };
    const status = await online;
    if (!isCurrent()) return { stage: 'stale' };
    if (status.onlineEnabled && status.loggedIn) {
      // 최근 플레이 기록용으로만 서버 저장 (DB 도 같은 규칙으로 랭킹 · 츄르 제외)
      const saved = await deps.submitRanking(record, context);
      if (!isCurrent()) return { stage: 'stale' };
      els.status.textContent = saved.submitted ? `${exclusion} (플레이 기록은 저장됨)` : exclusion;
    }
    return { stage: 'excluded' };
  }

  els.box.hidden = false;
  els.status.textContent = ONLINE_TEXT.checking;
  showChuruPending(els, record);
  const status = await online;
  if (!isCurrent()) return { stage: 'stale' };

  // 비로그인 · 온라인 꺼짐: 게스트 지갑 (이 기기)
  if (!status.onlineEnabled || !status.loggedIn) {
    els.status.textContent = status.onlineEnabled ? ONLINE_TEXT['login-required'] : ONLINE_TEXT['not-configured'];
    const local = deps.grantLocalReward(record, context);
    await showChuru(els, record, local, { reducedMotion, isCurrent, note: local.duplicate ? CHURU_TEXT.duplicate : CHURU_TEXT.guest });
    return { stage: 'guest', churu: local };
  }

  // 로그인 회원: 서버 저장 1번 (같은 playId 재전송은 DB 가 처음 결과만 돌려줌)
  const saved = await deps.submitRanking(record, context);
  if (!isCurrent()) return { stage: 'stale' };
  if (!saved.submitted) {
    els.status.textContent = ONLINE_TEXT[saved.reason] || ONLINE_TEXT.failed;
    showChuruFailed(els, record);
    return { stage: 'failed', reason: saved.reason };
  }

  // 1) 순위 변화
  els.status.textContent = saved.ranked ? ONLINE_TEXT.saved : ONLINE_TEXT.savedOnly;
  const change = describeRankChange({
    rankBefore: saved.rankBefore, rankAfter: saved.rankAfter, totalRanked: saved.totalRanked,
    improvedScore: saved.improved?.score === true, duplicate: saved.duplicate,
  });
  if (change) await showRankChange(els, change, { reducedMotion, isCurrent });
  if (!isCurrent()) return { stage: 'stale' };

  // 2) 츄르 (DB 가 계산한 값만 표시)
  if (saved.churu?.granted) {
    await showChuru(els, record, saved.churu, { reducedMotion, isCurrent, note: saved.duplicate ? CHURU_TEXT.duplicate : '' });
  } else {
    showChuruFailed(els, record);
  }
  if (!isCurrent()) return { stage: 'stale' };

  // 3) 랭킹 미리보기: 상위 3 + 내 앞뒤 2명 → [전체 랭킹 보기]
  const board = await deps.loadRanking(record.songId, record.difficulty, { laneCount: record.laneCount, limit: 3, around: 2 });
  if (!isCurrent()) return { stage: 'stale' };
  els.ranking.replaceChildren(board.ok ? renderRankingList(board.rows) : el('p', 'muted', rankingProblemText(board.reason)));
  if (els.fullRanking && rankingHref) {
    els.fullRanking.href = rankingHref;
    els.fullRanking.hidden = false;
  }
  return { stage: 'done', change, churu: saved.churu };
}

function resetView(els) {
  els.box.hidden = true;
  els.status.textContent = '';
  els.change.hidden = true;
  els.change.dataset.kind = '';
  els.badges.replaceChildren();
  els.ranking.replaceChildren();
  els.churu.hidden = true;
  els.churu.dataset.state = '';
  if (els.fullRanking) els.fullRanking.hidden = true;
}

async function showRankChange(els, change, { reducedMotion, isCurrent }) {
  els.change.hidden = false;
  els.change.dataset.kind = change.kind;
  els.medal.textContent = change.medal;
  els.medal.hidden = !change.medal;
  els.delta.textContent = change.change;
  els.delta.hidden = !change.change;
  els.badges.replaceChildren(...change.badges.map(b => el('li', 'rank-badge', b)));
  if (change.kind === 'up' && !reducedMotion) {
    // "12위 → 7위": 새 순위 숫자를 이전 순위에서 굴려 내려옴
    const to = el('span', 'rank-to', `${change.from}위`);
    els.transition.replaceChildren(document.createTextNode(`${change.from}위 → `), to);
    await animateNumber(to, change.from, change.to, { duration: RANK_ANIMATION_MS, reducedMotion, format: n => `${n}위`, isCancelled: () => !isCurrent() });
  } else {
    els.transition.textContent = change.transition;
  }
  els.change.classList.toggle('is-animated', !reducedMotion);
}

function showChuruPending(els, record) {
  els.churu.hidden = false;
  els.churu.dataset.state = 'pending';
  els.churuTitle.textContent = `🐟 ${rewardLabel(record)}`;
  els.churuAmount.textContent = `+${rewardFor(record)} 츄르`;
  els.churuFrom.textContent = '-';
  els.churuTo.textContent = '-';
  els.churuNote.textContent = CHURU_TEXT.pending;
}

function showChuruFailed(els, record) {
  els.churu.hidden = false;
  els.churu.dataset.state = 'failed';
  els.churuTitle.textContent = `🐟 ${DIFFICULTY_LABELS[record.difficulty] || ''} 클리어 보상`.trim();
  els.churuAmount.textContent = '';
  els.churuFrom.textContent = '-';
  els.churuTo.textContent = '-';
  els.churuNote.textContent = CHURU_TEXT.failed;
}

async function showChuru(els, record, churu, { reducedMotion, isCurrent, note = '' }) {
  if (!churu.granted && !churu.duplicate) {
    showChuruFailed(els, record);
    return;
  }
  els.churu.hidden = false;
  els.churu.dataset.state = churu.duplicate ? 'duplicate' : 'granted';
  els.churuTitle.textContent = `🐟 ${rewardLabel(record)}`;
  els.churuAmount.textContent = `+${fmt(churu.amount)} 츄르`;
  els.churuNote.textContent = note;
  const from = Number.isFinite(churu.balanceBefore) ? churu.balanceBefore : null;
  const to = Number.isFinite(churu.balanceAfter) ? churu.balanceAfter : null;
  els.churuFrom.textContent = fmt(from);
  if (to === null) {
    els.churuTo.textContent = '-';
    return;
  }
  if (!reducedMotion) await wait(150);
  await animateNumber(els.churuTo, from ?? to, to, { duration: CHURU_ANIMATION_MS, reducedMotion, format: fmt, isCancelled: () => !isCurrent() });
}
