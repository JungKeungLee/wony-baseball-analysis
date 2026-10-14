// 결과 화면의 온라인 랭킹 · 최고 기록 · 츄르 영역 (결과는 먼저 바로 보여주고, 이 부분만 비동기로 채운다).
//
// 로그인 필수: 게임은 로그인 회원만 시작할 수 있다. 기록 · 랭킹 · 츄르는 모두 서버(DB)에만 남는다.
// 순서: 1. 결과(즉시) → 2. 등급 등장 → 3. 🏆 순위 변화 → 4. 🐟 츄르 보상
//   저장 요청은 바로 보내고, 순위 · 츄르 표시는 ready(결과 · 등급 연출이 끝나는 시점)를 기다린다 → 효과가 겹치지 않음
//   정상 CLEAR        : 서버 저장 1번 (DB 가 같은 트랜잭션에서 저장 전 순위 → 저장 → 저장 후 순위 · 츄르 지급) → 순위 연출 → 츄르 연출
//                      → 랭킹 미리보기(상위 3 + 내 앞뒤)
//   GAME OVER · NO FAIL: 최근 플레이 기록용으로 서버 저장은 하되 랭킹 · 츄르 제외 안내
//   AUTO · PREVIEW    : 서버 요청 없음, 랭킹 · 츄르 제외 안내
//   세션 만료(401)    : "로그인 세션이 만료되었습니다." + WONY PHONE 로그인으로 (저장 · 지급 없음, 같은 판을 다시 보내지 않음)
// 어떤 실패도 결과 화면을 막지 않는다.
import { DIFFICULTY_LABELS } from './config.js';
import { CHURU_ANIMATION_MS, RANK_ANIMATION_MS, animateNumber, describeRankChange } from './rank-change.js';
import { isOnlineSubmittable, isRankingEligible, rankingExclusionText } from './ranking.js';
import { rankingProblemText, renderRankingList } from './ranking-view.js';
import { SESSION_EXPIRED_TEXT } from './session.js';
import { rewardLabel } from './wallet.js';

export const ONLINE_TEXT = Object.freeze({
  checking: '온라인 기록 확인 중...',
  failed: '온라인 기록을 불러오지 못했습니다.',
  'login-required': SESSION_EXPIRED_TEXT,
  'not-configured': '온라인 기록 기능이 아직 준비되지 않았어요.',
  'too-many': '잠시 후 다시 플레이하면 온라인에 저장돼요.',
  saved: '온라인 기록 저장 완료 · 랭킹 반영',
  savedOnly: '온라인 기록 저장 완료',
});
export const CHURU_TEXT = Object.freeze({
  failed: '츄르 보상 처리에 실패했습니다.',
  duplicate: '이 플레이의 보상은 이미 지급되었습니다.',
});
const IMPROVED_LABELS = [['score', '점수'], ['grade', '등급'], ['accuracy', '정확도'], ['max_combo', '콤보']];

const fmt = n => (Number.isFinite(n) ? Math.round(n).toLocaleString('ko-KR') : '-');
const wait = ms => new Promise(r => setTimeout(r, ms));
const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, textContent: text ?? '' });

/**
 * @param {object} p
 * @param {object} p.record  결과 기록 (playId 포함)
 * @param {object} p.context { autoplay, preview }
 * @param {object} p.els     { box, status, change, medal, transition, delta, badges, ranking, churu, churuTitle, churuAmount,
 *                             churuFrom, churuTo, churuNote, fullRanking, login, best, newBest }
 * @param {Promise<object>} p.online  getOnlineStatus() 결과 (게임 화면을 열 때 1번 확인한 값)
 * @param {object} p.deps    { submitRanking, loadRanking }
 * @param {boolean} p.reducedMotion
 * @param {() => boolean} p.isCurrent  같은 결과 화면이 아직 떠 있는지 (다시 하기를 누르면 false → 표시 중단)
 * @param {string} p.rankingHref  [전체 랭킹 보기] 주소
 * @param {Promise} [p.ready]  결과 · 등급 연출이 끝나면 resolve (그 뒤에 순위 → 츄르 표시)
 */
export async function runResultOnline({ record, context, els, online, deps, reducedMotion = false, isCurrent = () => true, rankingHref, ready = Promise.resolve() }) {
  const eligible = isRankingEligible(record, context);
  const submittable = isOnlineSubmittable(record, context);
  const exclusion = rankingExclusionText(record, context);
  resetView(els);
  const status = await online;
  if (!isCurrent()) return { stage: 'stale' };

  // 랭킹 · 츄르 제외 판 (AUTO / PREVIEW / GAME OVER / NO FAIL)
  if (!eligible) {
    els.box.hidden = false;
    els.status.textContent = exclusion;
    if (!submittable || !status.onlineEnabled || !status.loggedIn) return { stage: 'excluded' };
    // 최근 플레이 기록용으로만 서버 저장 (DB 도 같은 규칙으로 랭킹 · 츄르 제외)
    const saved = await deps.submitRanking(record, context);
    if (!isCurrent()) return { stage: 'stale' };
    if (!saved.submitted && saved.reason === 'login-required') {
      showExpired(els, status);
      return { stage: 'expired' };
    }
    if (saved.submitted) {
      els.status.textContent = `${exclusion} (플레이 기록은 저장됨)`;
      showBest(els, saved);
    }
    return { stage: 'excluded' };
  }

  els.box.hidden = false;
  els.status.textContent = ONLINE_TEXT.checking;
  if (!status.onlineEnabled) {
    els.status.textContent = ONLINE_TEXT['not-configured'];
    showChuruFailed(els, record);
    return { stage: 'failed', reason: 'not-configured' };
  }
  if (!status.loggedIn) {   // 게임 화면은 로그인해야 열리므로, 여기 오는 건 세션이 사라진 경우
    showExpired(els, status);
    showChuruFailed(els, record);
    return { stage: 'expired' };
  }

  // 서버 저장 1번 (같은 playId 재전송은 DB 가 처음 결과만 돌려줌)
  const saved = await deps.submitRanking(record, context);
  await ready;   // 결과 · 등급 연출 다음에 순위 → 츄르
  if (!isCurrent()) return { stage: 'stale' };
  if (!saved.submitted) {
    if (saved.reason === 'login-required') showExpired(els, status);
    else els.status.textContent = ONLINE_TEXT[saved.reason] || ONLINE_TEXT.failed;
    showChuruFailed(els, record);
    return { stage: saved.reason === 'login-required' ? 'expired' : 'failed', reason: saved.reason };
  }
  showBest(els, saved);

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
  if (els.login) els.login.hidden = true;
  if (els.newBest) els.newBest.hidden = true;
}

/** 세션 만료: 안내 + WONY PHONE 로그인 버튼 (이 판은 다시 보내지 않음 → 중복 저장 · 지급 없음) */
function showExpired(els, status) {
  els.box.hidden = false;
  els.status.textContent = SESSION_EXPIRED_TEXT;
  if (els.login) {
    els.login.href = status?.loginUrl || '/?login=expired';
    els.login.hidden = false;
  }
}

/** 서버 최고 기록 (DB rhythm_scores = 정상 CLEAR 만) */
function showBest(els, saved) {
  if (els.best) els.best.textContent = fmt(saved.best?.best_score ?? null);
  const improved = IMPROVED_LABELS.filter(([k]) => saved.improved?.[k] === true).map(([, label]) => label);
  if (els.newBest && improved.length) {
    els.newBest.textContent = `🎉 최고 ${improved.join(' · ')} 갱신!`;
    els.newBest.hidden = false;
  }
}

async function showRankChange(els, change, { reducedMotion, isCurrent }) {
  els.change.hidden = false;
  els.change.dataset.kind = change.kind;
  els.medal.textContent = change.medal;
  els.medal.hidden = !change.medal;
  els.delta.textContent = change.change;
  els.delta.hidden = !change.change;
  els.badges.replaceChildren(...change.badges.map(b => el('li', 'rank-badge', b)));
  els.change.classList.toggle('is-animated', !reducedMotion);
  els.transition.setAttribute('aria-label', change.transition);
  if (change.from !== null && change.from !== change.to) {
    // 12위 / ↓ / 7위: 새 순위 숫자를 이전 순위에서 굴려 내려옴 (동작 줄이기면 바로 최종값)
    const to = el('span', 'rank-to', `${change.from}위`);
    els.transition.replaceChildren(el('span', 'rank-from', `${change.from}위`), el('span', 'rank-arrow', '↓'), to);
    await animateNumber(to, change.from, change.to, { duration: RANK_ANIMATION_MS, reducedMotion, format: n => `${n}위`, isCancelled: () => !isCurrent() });
  } else {
    els.transition.replaceChildren(el('span', 'rank-to', change.transition));
  }
  if (!reducedMotion) await wait(250);   // 순위 다음에 츄르
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
  els.churu.hidden = false;
  els.churu.dataset.state = note === CHURU_TEXT.duplicate ? 'duplicate' : 'granted';
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
